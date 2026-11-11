import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { RealtimeSocket, RealtimeSocketFactory } from './stt.js';

export interface DirectTranslationDelta { delta: string; text: string; elapsedMs?: number }
export interface RealtimeDirectTranslatorOptions {
  apiKey: string;
  targetLanguage: string;
  onTextDelta?: (event: DirectTranslationDelta) => void;
  timeoutMs?: number;
}
export type DirectTranslationErrorCode = 'direct_configuration' | 'direct_closed' | 'direct_not_ready'
  | 'direct_timeout' | 'direct_transport' | 'direct_protocol' | 'direct_auth'
  | 'direct_model' | 'direct_rate_limit' | 'direct_provider' | 'direct_audio' | 'direct_backpressure';
export class DirectTranslationError extends Error {
  constructor(readonly code: DirectTranslationErrorCode) { super(`Direct translation failed: ${code}`); this.name = 'DirectTranslationError'; }
}

const URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
const MAX_MESSAGE = 1024 * 1024;
const MAX_TEXT = 500_000;

/** Optional benchmark adapter: one target language per session, no prompts/glossary support. */
export class RealtimeDirectTranslator {
  private socket: RealtimeSocket | undefined;
  private state: 'new' | 'connecting' | 'ready' | 'finishing' | 'closed' = 'new';
  private terminalError = new DirectTranslationError('direct_closed');
  private readonly timeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private opening: Promise<void> | undefined;
  private resolveOpening: (() => void) | undefined;
  private rejectOpening: ((error: DirectTranslationError) => void) | undefined;
  private finishing: Promise<string> | undefined;
  private resolveFinishing: ((text: string) => void) | undefined;
  private rejectFinishing: ((error: DirectTranslationError) => void) | undefined;
  private transcript = '';
  private readonly events = new Set<string>();

  constructor(private readonly options: RealtimeDirectTranslatorOptions,
    private readonly socketFactory: RealtimeSocketFactory = (url, settings) => new WebSocket(url, settings)) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!options.apiKey.trim() || !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(options.targetLanguage)
      || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new DirectTranslationError('direct_configuration');
    }
  }

  connect(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed' || this.state === 'finishing') return Promise.reject(this.terminalError);
    if (this.opening) return this.opening;
    this.state = 'connecting';
    this.opening = new Promise((resolve, reject) => { this.resolveOpening = resolve; this.rejectOpening = reject; });
    void this.opening.catch(() => {});
    this.timer = setTimeout(() => this.fail('direct_timeout'), this.timeoutMs);
    try {
      const socket = this.socketFactory(URL, { headers: { Authorization: `Bearer ${this.options.apiKey}` },
        maxPayload: MAX_MESSAGE, handshakeTimeout: this.timeoutMs, followRedirects: false, perMessageDeflate: false });
      this.socket = socket;
      socket.on('open', () => {
        if (this.state !== 'connecting') return;
        try { this.send({ type: 'session.update', session: { audio: { output: { language: this.options.targetLanguage } } } }); }
        catch { /* send records the safe terminal error. */ }
      });
      socket.on('message', (data: RawData, binary: boolean) => this.receive(data, binary));
      socket.on('error', () => this.fail('direct_transport'));
      socket.on('close', () => this.fail('direct_closed'));
      socket.on('unexpected-response', (_request, response) => {
        const code = response.statusCode === 401 || response.statusCode === 403 ? 'direct_auth'
          : response.statusCode === 429 ? 'direct_rate_limit' : 'direct_transport';
        response.destroy(); this.fail(code);
      });
    } catch { this.fail('direct_transport'); }
    return this.opening;
  }

  /** Feed real-time paced 200 ms PCM chunks, including source silence; no automatic silence is fabricated. */
  append(pcm: Buffer): void {
    if (this.state === 'closed') throw this.terminalError;
    if (this.state !== 'ready') throw new DirectTranslationError('direct_not_ready');
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 48_000) throw new DirectTranslationError('direct_audio');
    this.send({ type: 'session.input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  finish(): Promise<string> {
    if (this.finishing) return this.finishing;
    if (this.state !== 'ready') return Promise.reject(this.state === 'closed' ? this.terminalError : new DirectTranslationError('direct_not_ready'));
    this.state = 'finishing';
    this.finishing = new Promise((resolve, reject) => { this.resolveFinishing = resolve; this.rejectFinishing = reject; });
    void this.finishing.catch(() => {});
    this.timer = setTimeout(() => this.fail('direct_timeout'), this.timeoutMs);
    try { this.send({ type: 'session.close' }); } catch { /* send rejects finishing. */ }
    return this.finishing;
  }

  close(): void { this.fail('direct_closed'); }

  private send(event: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) { this.fail('direct_transport'); throw this.terminalError; }
    const json = JSON.stringify({ ...event, event_id: randomUUID() });
    if (socket.bufferedAmount + Buffer.byteLength(json) > MAX_MESSAGE) { this.fail('direct_backpressure'); throw this.terminalError; }
    try { socket.send(json, (error) => { if (error) this.fail('direct_transport'); }); }
    catch { this.fail('direct_transport'); }
    if (this.state === 'closed') throw this.terminalError;
  }

  private receive(data: RawData, binary: boolean): void {
    if (this.state === 'closed') return;
    let event: Record<string, unknown>;
    try {
      const length = Array.isArray(data) ? data.reduce((sum, value) => sum + value.byteLength, 0) : data.byteLength;
      if (binary || length > MAX_MESSAGE) throw new Error();
      const value: unknown = JSON.parse((Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value) || typeof value.type !== 'string') throw new Error();
      event = value as Record<string, unknown>;
    } catch { this.fail('direct_protocol'); return; }
    if (event.type === 'error') {
      const code = event.error && typeof event.error === 'object' && 'code' in event.error ? event.error.code : undefined;
      this.fail(code === 'invalid_api_key' || code === 'authentication_error' || code === 'permission_denied' ? 'direct_auth'
        : code === 'rate_limit_exceeded' || code === 'insufficient_quota' ? 'direct_rate_limit'
        : code === 'model_not_found' || code === 'model_not_supported' ? 'direct_model' : 'direct_provider');
    } else if (event.type === 'session.updated' && this.state === 'connecting') {
      const session = event.session as { type?: unknown; audio?: { output?: { language?: unknown } } } | undefined;
      if (session?.type !== 'translation' || session.audio?.output?.language !== this.options.targetLanguage) { this.fail('direct_protocol'); return; }
      clearTimeout(this.timer); this.timer = undefined; this.state = 'ready';
      this.resolveOpening?.(); this.resolveOpening = undefined; this.rejectOpening = undefined;
    } else if (event.type === 'session.output_transcript.delta') {
      if (this.state !== 'ready' && this.state !== 'finishing') { this.fail('direct_protocol'); return; }
      if (typeof event.delta !== 'string' || this.transcript.length + event.delta.length > MAX_TEXT) { this.fail('direct_protocol'); return; }
      if (typeof event.event_id === 'string' && event.event_id.length <= 512) {
        if (this.events.has(event.event_id)) return;
        this.events.add(event.event_id);
        if (this.events.size > 256) this.events.delete(this.events.values().next().value!);
      }
      this.transcript += event.delta;
      const elapsedMs = typeof event.elapsed_ms === 'number' && Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0 ? event.elapsed_ms : undefined;
      try { this.options.onTextDelta?.({ delta: event.delta, text: this.transcript, ...(elapsedMs !== undefined ? { elapsedMs } : {}) }); }
      catch { /* A consumer callback cannot inject protocol changes. */ }
    } else if (event.type === 'session.closed') {
      if (this.state !== 'finishing') { this.fail('direct_closed'); return; }
      clearTimeout(this.timer); this.timer = undefined; this.state = 'closed';
      this.resolveFinishing?.(this.transcript); this.resolveFinishing = undefined; this.rejectFinishing = undefined;
      this.events.clear();
      try { this.socket?.terminate(); } catch { /* Already closed. */ }
      this.socket = undefined;
    }
    // Returned audio is intentionally discarded; this adapter benchmarks caption text only.
  }

  private fail(code: DirectTranslationErrorCode): void {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.terminalError = new DirectTranslationError(code);
    clearTimeout(this.timer); this.timer = undefined;
    this.rejectOpening?.(this.terminalError); this.rejectFinishing?.(this.terminalError);
    this.resolveOpening = undefined; this.rejectOpening = undefined;
    this.resolveFinishing = undefined; this.rejectFinishing = undefined;
    this.events.clear(); this.transcript = '';
    try { this.socket?.terminate(); } catch { /* Hide transport errors. */ }
    this.socket = undefined;
  }
}
