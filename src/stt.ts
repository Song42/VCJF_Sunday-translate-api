import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

export interface Transcriber {
  connect(): Promise<void>;
  append(pcm: Buffer): void;
  commit(): Promise<string>;
  close(): void;
  setPartialHandler?(handler: (event: TranscriptionPartial) => void): void;
}

export type TranscriptionDelay = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface TranscriptionPartial {
  itemId: string;
  /** Accumulated transcript for this item, never a stable final transcript. */
  text: string;
  /** One-based commit call index. Absent until server acknowledgement establishes the mapping. */
  commitIndex?: number;
}

export type SttErrorCode =
  | 'stt_closed' | 'stt_not_ready' | 'stt_timeout' | 'stt_transport'
  | 'stt_backpressure' | 'stt_protocol' | 'stt_invalid_audio'
  | 'stt_audio_too_short' | 'stt_pending_limit' | 'stt_auth'
  | 'stt_rate_limit' | 'stt_model' | 'stt_language_hint'
  | 'stt_provider' | 'stt_transcription_failed' | 'stt_configuration';

const ERROR_MESSAGES: Record<SttErrorCode, string> = {
  stt_closed: '전사 연결이 종료되었습니다.',
  stt_not_ready: '전사 세션 설정이 아직 완료되지 않았습니다.',
  stt_timeout: '전사 서버의 응답 시간이 초과되었습니다.',
  stt_transport: '전사 서버 연결에 실패했습니다.',
  stt_backpressure: '전사 전송 버퍼가 가득 차 현재 연결을 종료했습니다.',
  stt_protocol: '전사 서버 응답 형식을 확인할 수 없습니다.',
  stt_invalid_audio: '전사 입력은 24kHz 모노 PCM16 바이트여야 합니다.',
  stt_audio_too_short: '100ms 미만인 발화는 전사하지 않습니다.',
  stt_pending_limit: '처리 중인 전사 구간이 너무 많습니다.',
  stt_auth: 'OpenAI API 키와 프로젝트 권한을 확인하세요.',
  stt_rate_limit: 'OpenAI 사용 한도 또는 결제 상태를 확인하세요.',
  stt_model: 'STT_MODEL과 해당 모델의 프로젝트 접근 권한을 확인하세요.',
  stt_language_hint: '전사 언어 힌트가 거부되었습니다. STT_LANGUAGES의 지원 언어 코드를 확인하세요.',
  stt_provider: '전사 서버가 요청을 처리하지 못했습니다.',
  stt_transcription_failed: '해당 발화의 전사에 실패했습니다.',
  stt_configuration: '전사 API 키, 모델, 문맥 힌트 또는 시간 제한 설정이 올바르지 않습니다.',
};

/** Safe for logs: no provider message, transcript, request body, URL or token. */
export class SttError extends Error {
  constructor(readonly code: SttErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SttError';
  }
}

export interface RealtimeTranscriberOptions {
  apiKey: string;
  model: string;
  languages?: string[];
  prompt?: string;
  keywords?: string[];
  delay?: TranscriptionDelay;
  timeoutMs?: number;
  onDiagnostic?: (event: string) => void;
}

export type RealtimeSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'on' | 'send' | 'terminate'>;
export type RealtimeSocketFactory = (url: string, options: WebSocket.ClientOptions) => RealtimeSocket;

interface PendingTurn {
  resolve: (transcript: string) => void;
  reject: (error: SttError) => void;
  timer: NodeJS.Timeout;
  itemId?: string;
  commitIndex: number;
}

type Completion = { transcript: string } | { error: SttError };
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;
const MAX_UNCOMMITTED_BYTES = 48_000 * 30;
const MIN_TURN_BYTES = 4_800; // Application policy: 100 ms of mono PCM16 at 24 kHz.
const MAX_PENDING_TURNS = 4;
// Application limits keep optional recording context bounded before connecting.
const MAX_PROMPT_LENGTH = 1_000;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 80;

/** One speaker's streaming session. No automatic retries of already-paid audio. */
export class RealtimeTranscriber implements Transcriber {
  private socket: RealtimeSocket | undefined;
  private state: 'new' | 'connecting' | 'ready' | 'closed' = 'new';
  private terminalError = new SttError('stt_closed');
  private opening: Promise<void> | undefined;
  private resolveOpening: (() => void) | undefined;
  private rejectOpening: ((error: SttError) => void) | undefined;
  private openingTimer: NodeJS.Timeout | undefined;
  private updateSent = false;
  private audioBytes = 0;
  private readonly pending = new Set<PendingTurn>();
  private readonly awaitingAcknowledgement: PendingTurn[] = [];
  private readonly byItem = new Map<string, PendingTurn>();
  private readonly earlyCompletions = new Map<string, Completion>();
  private readonly acknowledgedItems = new Set<string>();
  private readonly timeoutMs: number;
  private readonly prompt: string | undefined;
  private readonly keywords: string[];
  private readonly delay: TranscriptionDelay;
  private commitIndex = 0;
  private partialHandler: ((event: TranscriptionPartial) => void) | undefined;
  private readonly partials = new Map<string, string>();
  private readonly deltaEvents = new Set<string>();

  constructor(
    private readonly options: RealtimeTranscriberOptions,
    private readonly socketFactory: RealtimeSocketFactory = (url, socketOptions) => new WebSocket(url, socketOptions),
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.delay = options.delay ?? 'low';
    if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(this.delay)) {
      throw new SttError('stt_configuration');
    }
    if (!options.apiKey.trim() || !options.model.trim() ||
        !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new SttError('stt_configuration');
    }
    if (options.prompt !== undefined &&
        (typeof options.prompt !== 'string' || options.prompt.length > MAX_PROMPT_LENGTH)) {
      throw new SttError('stt_configuration');
    }
    if (options.keywords !== undefined &&
        (!Array.isArray(options.keywords) || options.keywords.length > MAX_KEYWORDS ||
          options.keywords.some((keyword) => typeof keyword !== 'string' ||
            keyword.length > MAX_KEYWORD_LENGTH || /[\r\n<>]/u.test(keyword)))) {
      throw new SttError('stt_configuration');
    }
    this.prompt = options.prompt?.trim() || undefined;
    this.keywords = options.keywords?.map((keyword) => keyword.trim()).filter(Boolean) ?? [];
  }

  connect(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed') return Promise.reject(this.terminalError);
    if (this.opening) return this.opening;
    this.state = 'connecting';
    this.opening = new Promise<void>((resolve, reject) => {
      this.resolveOpening = resolve;
      this.rejectOpening = reject;
    });
    // A simultaneous /stop may reject before the caller resumes awaiting it.
    void this.opening.catch(() => {});
    this.openingTimer = setTimeout(() => this.fail(new SttError('stt_timeout')), this.timeoutMs);
    try {
      const socket = this.socketFactory(REALTIME_URL, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        handshakeTimeout: this.timeoutMs,
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
      this.socket = socket;
      socket.on('open', () => this.configure());
      socket.on('message', (data: RawData, binary: boolean) => this.receive(data, binary));
      socket.on('error', () => this.fail(new SttError('stt_transport')));
      socket.on('close', () => this.fail(new SttError('stt_closed')));
      socket.on('unexpected-response', (_request, response) => {
        const code: SttErrorCode = response.statusCode === 401 || response.statusCode === 403
          ? 'stt_auth' : response.statusCode === 429 ? 'stt_rate_limit' : 'stt_transport';
        response.destroy();
        this.fail(new SttError(code));
      });
    } catch {
      this.fail(new SttError('stt_transport'));
    }
    return this.opening;
  }

  append(pcm: Buffer): void {
    this.requireReady();
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
      throw new SttError('stt_invalid_audio');
    }
    if (this.audioBytes + pcm.length > MAX_UNCOMMITTED_BYTES ||
        (this.socket?.bufferedAmount ?? 0) + Math.ceil(pcm.length / 3) * 4 + 256 > MAX_SOCKET_BUFFER_BYTES) {
      const error = new SttError('stt_backpressure');
      this.fail(error);
      throw error;
    }
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
    this.audioBytes += pcm.length;
  }

  setPartialHandler(handler: (event: TranscriptionPartial) => void): void {
    this.partialHandler = handler;
  }

  commit(): Promise<string> {
    try {
      this.requireReady();
      if (this.audioBytes < MIN_TURN_BYTES) {
        const error = new SttError('stt_audio_too_short');
        this.fail(error);
        return Promise.reject(error);
      }
      if (this.pending.size >= MAX_PENDING_TURNS) {
        const error = new SttError('stt_pending_limit');
        this.fail(error);
        return Promise.reject(error);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    let turn!: PendingTurn;
    const result = new Promise<string>((resolve, reject) => {
      turn = { resolve, reject, commitIndex: ++this.commitIndex,
        timer: setTimeout(() => this.fail(new SttError('stt_timeout')), this.timeoutMs) };
    });
    void result.catch(() => {});
    this.pending.add(turn);
    this.awaitingAcknowledgement.push(turn);
    this.audioBytes = 0;
    try {
      this.send({ type: 'input_audio_buffer.commit', event_id: randomUUID() });
    } catch {
      // send() closes the session and rejects this and any earlier pending turn.
    }
    return result;
  }

  close(): void {
    this.fail(new SttError('stt_closed'), false);
  }

  private configure(): void {
    if (this.state !== 'connecting') return;
    this.updateSent = true;
    const languages = this.options.languages ?? ['ko', 'ru', 'kk', 'en'];
    try {
      this.send({
        type: 'session.update',
        event_id: randomUUID(),
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription: {
                model: this.options.model,
                ...(languages.length ? { languages } : {}),
                ...(this.prompt ? { prompt: this.prompt } : {}),
                ...(this.keywords.length ? { keywords: this.keywords } : {}),
                ...(this.options.model === 'gpt-live-transcribe' ? { delay: this.delay } : {}),
              },
              turn_detection: null,
            },
          },
        },
      });
    } catch {
      // The transport failure has already rejected connect().
    }
  }

  private requireReady(): void {
    if (this.state === 'closed') throw this.terminalError;
    if (this.state !== 'ready' || this.socket?.readyState !== WebSocket.OPEN) {
      throw new SttError('stt_not_ready');
    }
  }

  private send(event: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const error = new SttError('stt_transport');
      this.fail(error);
      throw error;
    }
    const json = JSON.stringify(event);
    if (socket.bufferedAmount + Buffer.byteLength(json) > MAX_SOCKET_BUFFER_BYTES) {
      const error = new SttError('stt_backpressure');
      this.fail(error);
      throw error;
    }
    try {
      socket.send(json, (error) => { if (error) this.fail(new SttError('stt_transport')); });
    } catch {
      const error = new SttError('stt_transport');
      this.fail(error);
      throw error;
    }
    if (this.state === 'closed') throw this.terminalError;
  }

  private receive(data: RawData, binary: boolean): void {
    if (this.state === 'closed') return;
    let event: Record<string, unknown>;
    try {
      const length = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
      if (binary || length > MAX_MESSAGE_BYTES) throw new Error();
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      event = parsed as Record<string, unknown>;
      if (typeof event.type !== 'string') throw new Error();
    } catch {
      this.fail(new SttError('stt_protocol'));
      return;
    }
    if (event.type === 'error') {
      this.fail(this.providerError(event.error));
    } else if (event.type === 'session.updated') {
      const session = object(event.session);
      if (!this.updateSent || session?.type !== 'transcription') {
        this.fail(new SttError('stt_protocol'));
        return;
      }
      if (this.state === 'connecting') {
        clearTimeout(this.openingTimer);
        this.openingTimer = undefined;
        this.state = 'ready';
        this.resolveOpening?.();
        this.resolveOpening = undefined;
        this.rejectOpening = undefined;
        this.report('stt_ready');
      }
    } else if (event.type === 'input_audio_buffer.committed') {
      this.acknowledge(event.item_id);
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      this.partial(event);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' ||
        event.type === 'conversation.item.input_audio_transcription.failed') {
      this.complete(event);
    }
    // Unrelated protocol events do not alter transcription state.
  }

  private partial(event: Record<string, unknown>): void {
    const itemId = itemIdentifier(event.item_id);
    if (!itemId || typeof event.delta !== 'string') { this.fail(new SttError('stt_protocol')); return; }
    if (this.acknowledgedItems.has(itemId) && !this.byItem.has(itemId)) return;
    const eventId = itemIdentifier(event.event_id);
    if (eventId) {
      if (this.deltaEvents.has(eventId)) return;
      this.deltaEvents.add(eventId);
      if (this.deltaEvents.size > 256) this.deltaEvents.delete(this.deltaEvents.values().next().value!);
    }
    if (!this.partials.has(itemId) && this.partials.size >= MAX_PENDING_TURNS + 1) {
      this.fail(new SttError('stt_protocol')); return;
    }
    const text = (this.partials.get(itemId) ?? '') + event.delta;
    if (text.length > 50_000) { this.fail(new SttError('stt_protocol')); return; }
    this.partials.set(itemId, text);
    this.emitPartial(itemId, text);
  }

  private emitPartial(itemId: string, text: string): void {
    const commitIndex = this.byItem.get(itemId)?.commitIndex;
    try { this.partialHandler?.({ itemId, text, ...(commitIndex ? { commitIndex } : {}) }); }
    catch { this.report('stt_partial_handler_error'); }
  }

  private acknowledge(value: unknown): void {
    const itemId = itemIdentifier(value);
    if (!itemId) { this.fail(new SttError('stt_protocol')); return; }
    if (this.acknowledgedItems.has(itemId)) return;
    const turn = this.awaitingAcknowledgement.shift();
    if (!turn) { this.fail(new SttError('stt_protocol')); return; }
    this.acknowledgedItems.add(itemId);
    if (this.acknowledgedItems.size > 64) this.acknowledgedItems.delete(this.acknowledgedItems.values().next().value!);
    turn.itemId = itemId;
    this.byItem.set(itemId, turn);
    const partial = this.partials.get(itemId);
    if (partial !== undefined) this.emitPartial(itemId, partial);
    const early = this.earlyCompletions.get(itemId);
    if (early) {
      this.earlyCompletions.delete(itemId);
      this.settle(turn, early);
    }
  }

  private complete(event: Record<string, unknown>): void {
    const itemId = itemIdentifier(event.item_id);
    if (!itemId) { this.fail(new SttError('stt_protocol')); return; }
    const turn = this.byItem.get(itemId);
    if (!turn && (this.acknowledgedItems.has(itemId) || this.awaitingAcknowledgement.length === 0)) return;
    let completion: Completion;
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      completion = { error: this.providerError(event.error, 'stt_transcription_failed') };
    } else if (typeof event.transcript === 'string' && event.transcript.length <= 50_000) {
      completion = { transcript: event.transcript };
    } else {
      this.fail(new SttError('stt_protocol'));
      return;
    }
    if (turn) this.settle(turn, completion);
    else {
      if (this.earlyCompletions.size >= MAX_PENDING_TURNS && !this.earlyCompletions.has(itemId)) {
        this.fail(new SttError('stt_protocol'));
        return;
      }
      this.earlyCompletions.set(itemId, completion);
    }
  }

  private settle(turn: PendingTurn, completion: Completion): void {
    clearTimeout(turn.timer);
    this.pending.delete(turn);
    if (turn.itemId) { this.byItem.delete(turn.itemId); this.partials.delete(turn.itemId); }
    if ('error' in completion) {
      this.report(completion.error.code);
      turn.reject(completion.error);
    } else turn.resolve(completion.transcript);
  }

  private providerError(value: unknown, fallback: SttErrorCode = 'stt_provider'): SttError {
    const error = object(value);
    const code = error?.code;
    const param = error?.param;
    if (code === 'invalid_api_key' || code === 'authentication_error' || code === 'permission_denied') return new SttError('stt_auth');
    if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return new SttError('stt_rate_limit');
    if (code === 'model_not_found' || code === 'model_not_supported') return new SttError('stt_model');
    if (code === 'unsupported_language' || code === 'invalid_language' || code === 'invalid_language_code' ||
        (typeof param === 'string' && /(?:^|\.)languages(?:\[\d+\])?$/.test(param))) {
      return new SttError('stt_language_hint');
    }
    return new SttError(fallback);
  }

  private report(event: string): void {
    try { this.options.onDiagnostic?.(event); } catch { /* Diagnostics do not control the transport. */ }
  }

  private fail(error: SttError, report = true): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.terminalError = error;
    clearTimeout(this.openingTimer);
    this.openingTimer = undefined;
    this.rejectOpening?.(error);
    this.resolveOpening = undefined;
    this.rejectOpening = undefined;
    for (const turn of this.pending) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.pending.clear();
    this.awaitingAcknowledgement.length = 0;
    this.byItem.clear();
    this.earlyCompletions.clear();
    this.partials.clear();
    this.deltaEvents.clear();
    this.partialHandler = undefined;
    this.acknowledgedItems.clear();
    this.audioBytes = 0;
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.terminate(); } catch { /* Already closed; do not expose socket errors. */ }
    if (report) this.report(error.code);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function itemIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}
