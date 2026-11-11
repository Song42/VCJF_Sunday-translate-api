import { randomUUID } from 'node:crypto';
import { SUPPORTED_TARGET_LANGUAGES, type TargetLanguage } from './languages.js';
import type { Caption } from './types.js';

export interface ReceiverConfig { url: string; token: string }
export class ReceiverConfigurationError extends Error {
  constructor() {
    super('RECEIVER_URL에는 HTTPS 주소(로컬은 HTTP 허용), RECEIVER_TOKEN에는 수신기의 INGEST_TOKEN과 같은 32자 이상 값을 함께 설정하세요.');
    this.name = 'ReceiverConfigurationError';
  }
}

/** Credentials never appear in a URL, diagnostic, caption, or browser payload. */
export function readReceiverConfig(env: NodeJS.ProcessEnv = process.env): ReceiverConfig | undefined {
  const raw = env.RECEIVER_URL?.trim() ?? '', token = env.RECEIVER_TOKEN?.trim() ?? '';
  if (!raw && !token) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new ReceiverConfigurationError(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || !/^[\x21-\x7e]{32,256}$/u.test(token)) throw new ReceiverConfigurationError();
  return { url: url.origin, token };
}

export interface ReceiverCaption {
  id: string; sequence: number; revision: number; status: 'draft' | 'initial' | 'final';
  speakerName: string; originalText: string; translations: Partial<Record<TargetLanguage, string>>; createdAt: number;
}
export type ReceiverEvent =
  | { type: 'session'; sessionId: string; title: string; languages: TargetLanguage[] }
  | { type: 'caption'; sessionId: string; caption: ReceiverCaption }
  | { type: 'end'; sessionId: string };
interface Meeting {
  event: Extract<ReceiverEvent, { type: 'session' }>;
  latest: Map<string, ReceiverCaption>; pending: Map<string, ReceiverCaption>;
  ready: boolean; ended: boolean; endSent: boolean; blocked: boolean;
}
export interface ReceiverPublisherOptions extends ReceiverConfig {
  fetch?: typeof fetch;
  onDiagnostic?: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
}
const STATUS_RANK = { draft: 0, initial: 1, final: 2 };
const MAX_CAPTIONS = 200;

/** One bounded asynchronous sender. HTTP failure cannot stall speech processing. */
export class ReceiverPublisher {
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  private meeting: Meeting | undefined;
  private working = false;
  private closed = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly options: ReceiverPublisherOptions) {
    const config = readReceiverConfig({ RECEIVER_URL: options.url, RECEIVER_TOKEN: options.token })!;
    this.endpoint = `${config.url}/api/ingest`;
    this.fetcher = options.fetch ?? fetch;
  }

  startSession(title: string, languages: readonly TargetLanguage[]): string {
    if (this.closed) throw new Error('Receiver publisher is closed');
    if (!languages.length || new Set(languages).size !== languages.length
      || languages.some(language => !SUPPORTED_TARGET_LANGUAGES.includes(language))) throw new RangeError('Invalid receiver languages');
    const sessionId = randomUUID();
    this.controller?.abort();
    clearTimeout(this.timer); this.timer = undefined; this.failures = 0;
    this.meeting = { event: { type: 'session', sessionId, title: title.slice(0, 120) || '모임', languages: [...languages] },
      latest: new Map(), pending: new Map(), ready: false, ended: false, endSent: false, blocked: false };
    this.kick();
    return sessionId;
  }

  publish(caption: Caption): void {
    const meeting = this.meeting;
    if (this.closed || !meeting || meeting.ended || meeting.blocked) return;
    // Explicit allowlist: no audio, Discord IDs, recordings, source IDs, or diagnostics.
    const translations: ReceiverCaption['translations'] = {};
    for (const language of meeting.event.languages) {
      const text = caption.translations[language];
      if (typeof text === 'string') translations[language] = text;
    }
    const item: ReceiverCaption = { id: caption.segmentId, sequence: caption.sequence,
      revision: caption.revision ?? 0, status: caption.status ?? 'final', speakerName: caption.speakerName,
      originalText: caption.originalText, translations, createdAt: caption.createdAt };
    const previous = meeting.latest.get(item.id);
    if (previous && (previous.revision > item.revision
      || previous.revision === item.revision && STATUS_RANK[previous.status] >= STATUS_RANK[item.status])) return;
    meeting.latest.set(item.id, item); meeting.pending.set(item.id, item);
    while (meeting.latest.size > MAX_CAPTIONS) {
      const first = meeting.latest.keys().next().value!;
      meeting.latest.delete(first); meeting.pending.delete(first);
    }
    this.kick();
  }

  endSession(): void {
    if (!this.meeting || this.closed) return;
    this.meeting.ended = true; this.kick();
  }

  /** A bounded best-effort flush, suitable for the bot's 5-second shutdown deadline. */
  async close(timeoutMs = 2_000): Promise<void> {
    if (this.closed) return;
    this.endSession();
    clearTimeout(this.timer); this.timer = undefined; this.kick();
    await this.waitForIdle(Math.max(0, Math.min(timeoutMs, 3_000)));
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.controller?.abort(); this.meeting = undefined;
    this.notifyIdle();
  }

  /** Also useful to callers writing deterministic transport checks; it sends no extra request. */
  async waitForIdle(timeoutMs = 2_000): Promise<boolean> {
    if (this.isIdle()) return true;
    return new Promise(resolve => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timeout); this.idleWaiters.delete(finish); resolve(this.isIdle()); };
      this.idleWaiters.add(finish); timeout = setTimeout(finish, timeoutMs);
    });
  }

  private isIdle(): boolean {
    const meeting = this.meeting;
    return this.closed || !meeting || meeting.blocked
      || !this.working && meeting.ready && !meeting.pending.size && (!meeting.ended || meeting.endSent);
  }
  private notifyIdle(): void { if (this.isIdle()) for (const finish of [...this.idleWaiters]) finish(); }
  private kick(): void {
    if (this.closed || this.working || this.timer || !this.meeting || this.meeting.blocked) return;
    void this.pump();
  }
  private retry(): void {
    if (this.closed || this.timer) return;
    const delay = Math.min(8_000, (this.options.retryBaseMs ?? 250) * 2 ** Math.min(this.failures - 1, 5));
    this.timer = setTimeout(() => { this.timer = undefined; this.kick(); }, Math.max(1, delay));
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      while (!this.closed) {
        const meeting = this.meeting;
        if (!meeting || meeting.blocked) break;
        const caption = meeting.pending.values().next().value;
        const event: ReceiverEvent | undefined = !meeting.ready ? meeting.event
          : caption ? { type: 'caption', sessionId: meeting.event.sessionId, caption }
            : meeting.ended && !meeting.endSent ? { type: 'end', sessionId: meeting.event.sessionId } : undefined;
        if (!event) break;
        const status = await this.send(event);
        if (meeting !== this.meeting || this.closed) continue;
        if (status >= 200 && status < 300) {
          if (this.failures) this.options.onDiagnostic?.('receiver_connection_restored');
          this.failures = 0;
          if (event.type === 'session') meeting.ready = true;
          if (event.type === 'caption' && meeting.pending.get(event.caption.id) === event.caption) meeting.pending.delete(event.caption.id);
          if (event.type === 'end') meeting.endSent = true;
          continue;
        }
        if (status === 401 || status === 403 || event.type === 'session' && status === 400) {
          meeting.blocked = true; meeting.pending.clear();
          this.options.onDiagnostic?.('receiver_configuration_rejected', { status });
          break;
        }
        if ((status === 400 || status === 413) && event.type === 'caption') {
          if (meeting.pending.get(event.caption.id) === event.caption) meeting.pending.delete(event.caption.id);
          if (meeting.latest.get(event.caption.id) === event.caption) meeting.latest.delete(event.caption.id);
          this.options.onDiagnostic?.('receiver_caption_rejected', { status });
          continue;
        }
        if (status === 409 && event.type !== 'session') {
          // A receiver restart loses its memory-only room. Restore only this meeting's latest revisions.
          meeting.ready = false; meeting.pending = new Map(meeting.latest); meeting.endSent = false;
        }
        this.failures++;
        if (this.failures === 1) this.options.onDiagnostic?.('receiver_delivery_retry', { status });
        this.retry(); break;
      }
    } catch {
      // Transport or observer bugs must never escape into the audio pipeline.
      this.failures++; this.retry();
    } finally {
      this.working = false; this.notifyIdle();
      if (!this.timer && !this.isIdle()) this.kick();
    }
  }

  private async send(event: ReceiverEvent): Promise<number> {
    const controller = new AbortController(); this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 2_000);
    deadline.unref();
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST',
        headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event), signal: controller.signal, redirect: 'error' });
      // Never read/record server error bodies; a malicious or broken receiver cannot fill local logs.
      await response.body?.cancel();
      return response.status;
    } catch { return 0; }
    finally { clearTimeout(deadline); if (this.controller === controller) this.controller = undefined; }
  }
}
