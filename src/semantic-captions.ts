import type { AssembledCaption, TranscriptPiece } from './caption-assembler.js';
import { SegmentationError, validateSegmentation, type Segmenter } from './segment.js';
import { UsageLimitError, UsageStorageError, type UsageLedger, type UsageRates } from './usage.js';
import { startsMeaningCorrection } from './interpreted-captions.js';

interface Span {
  text: string;
  sourceId: string;
  speakerName: string;
  receivedAt: number;
}

interface Job { controller: AbortController; valid: boolean }
interface Speaker {
  id: string;
  spans: Span[];
  context: { text: string; at: number }[];
  lastAudioAt: number;
  dirty: boolean;
  job: Job | undefined;
  timer: NodeJS.Timeout | undefined;
  lateContextRetries: number;
}

export interface SemanticCaptionOptions {
  segmenter: Segmenter;
  usage: Pick<UsageLedger, 'reserve' | 'snapshot'>;
  segmentationRates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
  silenceMs: number;
  maxHoldMs: number;
  onCaption: (caption: AssembledCaption) => void;
  onDiagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void;
  onError: (error: unknown) => void;
  now?: () => number;
}

const MAX_TEXT = 8_000;
const MAX_CAPTION = 4_000;
const MAX_SPEAKERS = 64;
const CONTEXT_TTL = 10 * 60_000;

/** AI chooses boundaries; original spans remain the sole source of caption text. */
export class SemanticCaptionAssembler {
  private readonly speakers = new Map<string, Speaker>();
  private readonly runningSpeakers = new Set<string>();
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private stopped = false;
  private pumping = false;
  private running = 0;
  private sequence = 0;

  constructor(private readonly options: SemanticCaptionOptions) {
    for (const value of [options.silenceMs, options.maxHoldMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new RangeError('Semantic caption deadlines must be positive timer durations');
      }
    }
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    this.cleanupTimer.unref();
  }

  /** Called for received audio, independently of when STT results arrive. */
  activity(speakerId: string): void {
    if (this.stopped) return;
    const speaker = this.getSpeaker(speakerId);
    if (!speaker || this.stopped) return;
    speaker.lastAudioAt = this.now();
    // Existing timers recheck lastAudioAt on waking instead of being reset per packet.
    this.schedule(speaker);
  }

  accept(piece: TranscriptPiece): void {
    if (this.stopped || !piece.text.trim()) return;
    const speaker = this.getSpeaker(piece.speakerId);
    if (!speaker || this.stopped) return;
    const text = piece.text.trim();
    if (this.content(speaker).length + text.length + 1 > MAX_TEXT) this.flush(speaker, 'limit');
    if (this.stopped) return;
    // Upstream limits turns to 8000 characters; keep even unexpected oversized input literal.
    let offset = 0;
    while (offset < text.length && !this.stopped) {
      const count = this.safeCut(text.slice(offset), Math.min(MAX_TEXT, text.length - offset));
      const part = text.slice(offset, offset + count);
      speaker.spans.push({ text: (speaker.spans.length ? ' ' : '') + part,
        sourceId: piece.segmentId, speakerName: piece.speakerName, receivedAt: this.now() });
      offset += count;
      if (offset < text.length) this.flush(speaker, 'limit');
    }
    if (this.stopped) return;
    speaker.dirty = true;
    if (!this.expire(speaker)) {
      this.schedule(speaker);
      this.pump();
    }
  }

  /** Never join phrases across a missing transcript or a lost transport. */
  gap(speakerId: string): void {
    if (this.stopped) return;
    const speaker = this.speakers.get(speakerId);
    if (!speaker) return;
    this.flush(speaker, 'gap');
    speaker.context.length = 0;
    this.pump();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const speaker of this.speakers.values()) {
      this.invalidate(speaker);
      this.clearTimer(speaker);
      speaker.spans.length = 0;
      speaker.context.length = 0;
    }
    this.speakers.clear();
  }

  private getSpeaker(id: string): Speaker | undefined {
    let speaker = this.speakers.get(id);
    if (speaker) return speaker;
    if (this.speakers.size >= MAX_SPEAKERS) {
      const oldest = [...this.speakers.values()].reduce((left, right) =>
        left.lastAudioAt <= right.lastAudioAt ? left : right);
      this.flush(oldest, 'limit');
      this.clearTimer(oldest);
      this.speakers.delete(oldest.id);
      if (this.stopped) return undefined;
    }
    speaker = { id, spans: [], context: [], lastAudioAt: this.now(), dirty: false,
      job: undefined, timer: undefined, lateContextRetries: 0 };
    this.speakers.set(id, speaker);
    return speaker;
  }

  private content(speaker: Speaker): string {
    return speaker.spans.map((span) => span.text).join('');
  }

  private pump(): void {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.running < 3) {
        const speaker = [...this.speakers.values()].find((item) =>
          item.dirty && item.spans.length && !item.job && !this.runningSpeakers.has(item.id));
        if (!speaker) break;
        if (this.expire(speaker)) continue;
        speaker.dirty = false;
        const job: Job = { controller: new AbortController(), valid: true };
        speaker.job = job;
        this.running += 1;
        this.runningSpeakers.add(speaker.id);
        void this.run(speaker, job);
      }
    } finally { this.pumping = false; }
  }

  private async run(speaker: Speaker, job: Job): Promise<void> {
    const startedAt = this.now();
    const text = this.content(speaker);
    speaker.context = speaker.context.filter((item) => item.at > this.now() - CONTEXT_TTL);
    const context = speaker.context.slice(-2).map((item) => item.text);
    try {
      const input = { text, context, signal: job.controller.signal };
      const reservation = this.options.usage.reserve(this.options.segmenter.estimateUsage(input),
        this.options.segmentationRates);
      const result = await this.options.segmenter.segment(input);
      if (!this.current(speaker, job)) return;
      validateSegmentation(text, result);
      try { reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }); }
      catch (error) { throw error instanceof RangeError ? new UsageStorageError('invalid_data') : error; }
      if (!this.current(speaker, job)) return;
      this.report('segmentation_ready', { speakerId: speaker.id,
        latencyMs: this.now() - startedAt, completedCount: result.completed.length,
        pendingChars: result.pending.length });
      const lateText = this.content(speaker).slice(text.length).trim();
      if (result.completed.length && startsMeaningCorrection(lateText)) {
        if (speaker.lateContextRetries < 1) {
          speaker.lateContextRetries += 1;
          speaker.dirty = true;
          this.report('segmentation_late_context_deferred', { speakerId: speaker.id });
          return;
        }
        this.report('interpretation_late_context_limit', { speakerId: speaker.id, addedChars: lateText.length });
      }
      for (const sentence of result.completed) {
        if (!this.current(speaker, job)) break;
        this.emitBounded(speaker, sentence.trim().length, 'semantic');
      }
      if (result.completed.length) speaker.lateContextRetries = 0;
      // Text appended during this request remains dirty; unchanged pending text does not retry.
    } catch (error) {
      if (this.current(speaker, job)) {
        const fatal = error instanceof UsageLimitError || error instanceof UsageStorageError ||
          (error instanceof SegmentationError && ['segmentation_auth', 'segmentation_model'].includes(error.code));
        try { this.options.onError(error); }
        finally {
          if (fatal) this.stop();
          if (!this.stopped) this.flush(speaker, 'fallback');
        }
      }
    } finally {
      if (speaker.job === job) speaker.job = undefined;
      this.running -= 1;
      this.runningSpeakers.delete(speaker.id);
      if (!this.stopped && this.speakers.get(speaker.id) === speaker) this.schedule(speaker);
      this.pump();
    }
  }

  private current(speaker: Speaker, job: Job): boolean {
    return !this.stopped && job.valid && speaker.job === job && this.speakers.get(speaker.id) === speaker;
  }

  private invalidate(speaker: Speaker): void {
    speaker.dirty = false;
    if (speaker.job) {
      speaker.job.valid = false;
      speaker.job.controller.abort();
    }
  }

  private clearTimer(speaker: Speaker): void {
    if (speaker.timer) clearTimeout(speaker.timer);
    speaker.timer = undefined;
  }

  private schedule(speaker: Speaker): void {
    if (this.stopped || speaker.timer || !speaker.spans.length) return;
    const deadline = Math.min(speaker.lastAudioAt + this.options.silenceMs,
      speaker.spans[0]!.receivedAt + this.options.maxHoldMs);
    speaker.timer = setTimeout(() => {
      speaker.timer = undefined;
      if (this.stopped || this.speakers.get(speaker.id) !== speaker) return;
      if (!this.expire(speaker)) this.schedule(speaker);
      this.pump();
    }, Math.max(0, deadline - this.now()));
    speaker.timer.unref();
  }

  private expire(speaker: Speaker): boolean {
    if (!speaker.spans.length) return false;
    const silenceAt = speaker.lastAudioAt + this.options.silenceMs;
    const holdAt = speaker.spans[0]!.receivedAt + this.options.maxHoldMs;
    if (this.now() < Math.min(silenceAt, holdAt)) return false;
    this.flush(speaker, silenceAt <= holdAt ? 'silence' : 'timeout');
    return true;
  }

  private flush(speaker: Speaker, boundary: AssembledCaption['boundary']): void {
    this.invalidate(speaker);
    this.clearTimer(speaker);
    if (speaker.spans.length) this.report('segmentation_flush', { speakerId: speaker.id, boundary });
    this.emitBounded(speaker, this.content(speaker).length, boundary);
  }

  private safeCut(text: string, count: number): number {
    if (/[\uD800-\uDBFF]/u.test(text[count - 1] ?? '') &&
      /[\uDC00-\uDFFF]/u.test(text[count] ?? '')) return count - 1;
    return count;
  }

  private emitBounded(speaker: Speaker, count: number, boundary: AssembledCaption['boundary']): void {
    while (!this.stopped && count > 0 && speaker.spans.length) {
      const text = this.content(speaker);
      const cut = this.safeCut(text, Math.min(count, MAX_CAPTION));
      const trimmedAfter = this.emit(speaker, cut, count > MAX_CAPTION ? 'limit' : boundary);
      count -= cut + trimmedAfter;
    }
  }

  /** Consumes original spans and returns whitespace consumed after the boundary. */
  private emit(speaker: Speaker, count: number, boundary: AssembledCaption['boundary']): number {
    const sourceSegmentIds: string[] = [];
    let originalText = '';
    let speakerName = '';
    while (count > 0 && speaker.spans.length) {
      const span = speaker.spans[0]!;
      const consumed = span.text.slice(0, count);
      if (consumed.trim()) {
        if (!sourceSegmentIds.includes(span.sourceId)) sourceSegmentIds.push(span.sourceId);
        if (!speakerName) speakerName = span.speakerName;
      }
      originalText += consumed;
      count -= consumed.length;
      span.text = span.text.slice(consumed.length);
      if (!span.text) speaker.spans.shift();
    }
    let trimmedAfter = 0;
    while (speaker.spans.length) {
      const span = speaker.spans[0]!;
      const trimmed = span.text.trimStart();
      trimmedAfter += span.text.length - trimmed.length;
      span.text = trimmed;
      if (span.text) break;
      speaker.spans.shift();
    }
    originalText = originalText.trim();
    if (originalText && !this.stopped) {
      speaker.context.push({ text: originalText.slice(-1_000), at: this.now() });
      speaker.context = speaker.context.slice(-2);
      this.options.onCaption({ segmentId: `${sourceSegmentIds[0]}:semantic:${++this.sequence}`,
        speakerId: speaker.id, speakerName, originalText, sourceSegmentIds, boundary });
    }
    return trimmedAfter;
  }

  private report(event: string, fields: Record<string, string | number | boolean>): void {
    try { this.options.onDiagnostic(event, fields); } catch { /* Diagnostics do not control transcription. */ }
  }

  private prune(): void {
    if (this.stopped) return;
    const cutoff = this.now() - CONTEXT_TTL;
    for (const speaker of this.speakers.values()) {
      speaker.context = speaker.context.filter((item) => item.at > cutoff);
      if (!speaker.spans.length && !speaker.job && !this.runningSpeakers.has(speaker.id) &&
          !speaker.context.length && speaker.lastAudioAt <= cutoff) {
        this.clearTimer(speaker);
        this.speakers.delete(speaker.id);
      }
    }
  }
}
