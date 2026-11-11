import type { AssembledCaption, TranscriptPiece } from './caption-assembler.js';
import { InterpretationError, validateInterpretation, type Interpreter } from './interpret.js';
import type { Translations } from './translate.js';
import type { ConversationSnapshot } from './conversation-memory.js';
import { UsageLimitError, UsageStorageError, type UsageLedger } from './usage.js';

interface Span {
  text: string;
  sourceId: string;
  speakerName: string;
  receivedAt: number;
}
interface Batch {
  spans: Span[];
  boundary: AssembledCaption['boundary'] | undefined;
  dirty: boolean;
  readyAt: number;
  resetContext: boolean;
  lateContextRetries: number;
}
interface Job {
  controller: AbortController;
  batch: Batch;
  text: string;
  flush: boolean;
  boundary: AssembledCaption['boundary'];
}
interface Speaker {
  id: string;
  batches: Batch[];
  context: { text: string; at: number }[];
  resetNextContext: boolean;
  lastAudioAt: number;
  job: Job | undefined;
  timer: NodeJS.Timeout | undefined;
}

export type InterpretedCaption = AssembledCaption & { translations: Translations };

export interface InterpretedCaptionOptions {
  interpreter: Interpreter;
  usage: Pick<UsageLedger, 'reserve' | 'snapshot'>;
  silenceMs: number;
  maxHoldMs: number;
  onCaption: (caption: InterpretedCaption) => void;
  onDiagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void;
  onError: (error: unknown) => void;
  now?: () => number;
  getConversation?: () => ConversationSnapshot;
}

/** Capacity or a failed forced flush must stop visibly instead of silently dropping speech. */
export class InterpretationFlowError extends Error {
  constructor(readonly code: 'interpretation_backpressure' | 'interpretation_failed') {
    super(`Caption interpretation failed: ${code}`);
    this.name = 'InterpretationFlowError';
  }
}

const MAX_TEXT = 8_000;
const MAX_QUEUED_CHARS = 96_000;
const MAX_BATCHES = 192;
const MAX_SPEAKERS = 64;
const CONTEXT_TTL = 10 * 60_000;

/** A newly arrived correction/contrast can invalidate the assertion just translated. */
export function startsMeaningCorrection(text: string): boolean {
  const head = text.replace(/^[\s.,!?…—–:;'"“”‘’]+/u, '').toLocaleLowerCase('en');
  return /^(?:아니|아닙|아닌|않|말고|하지만|다만|그게\s*아니|이\s*아니|그렇지\s*않)/u.test(head)
    || /^(?:but|not|no|rather|except|actually)(?=$|[\s,.!?;:])/u.test(head)
    || /^(?:а|но|не|нет|наоборот|вернее|емес|бірақ|жоқ|керісінше)(?=$|[\s,.!?;:])/u.test(head);
}

/** One API response chooses boundaries and supplies their translations. */
export class InterpretedCaptionAssembler {
  private readonly speakers = new Map<string, Speaker>();
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;
  private stopped = false;
  private pumping = false;
  private running = 0;
  private sequence = 0;

  constructor(private readonly options: InterpretedCaptionOptions) {
    for (const value of [options.silenceMs, options.maxHoldMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new RangeError('Interpretation deadlines must be positive timer durations');
      }
    }
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    this.cleanupTimer.unref();
  }

  activity(speakerId: string): void {
    if (this.stopped) return;
    const speaker = this.getSpeaker(speakerId);
    if (!speaker) return;
    speaker.lastAudioAt = this.now();
    this.schedule(speaker);
  }

  accept(piece: TranscriptPiece): void {
    if (this.stopped || !piece.text.trim()) return;
    const speaker = this.getSpeaker(piece.speakerId);
    if (!speaker) return;
    const text = piece.text.trim();
    if (this.queuedChars() + text.length + 1 > MAX_QUEUED_CHARS) {
      this.fail(new InterpretationFlowError('interpretation_backpressure'));
      return;
    }
    this.expire(speaker);
    let offset = 0;
    while (!this.stopped && offset < text.length) {
      let batch = this.openBatch(speaker);
      if (!batch) return;
      if (this.content(batch).length + text.length - offset + 1 > MAX_TEXT && batch.spans.length) {
        this.seal(speaker, batch, 'limit');
        batch = this.openBatch(speaker);
        if (!batch) return;
      }
      const remaining = text.slice(offset);
      const count = this.safeCut(remaining, Math.min(MAX_TEXT, remaining.length));
      batch.spans.push({ text: (batch.spans.length ? ' ' : '') + remaining.slice(0, count),
        sourceId: piece.segmentId, speakerName: piece.speakerName, receivedAt: this.now() });
      this.markDirty(batch);
      offset += count;
      if (offset < text.length) this.seal(speaker, batch, 'limit');
    }
    if (this.stopped) return;
    this.expire(speaker);
    this.schedule(speaker);
    this.pump();
  }

  gap(speakerId: string): void {
    if (this.stopped) return;
    const speaker = this.speakers.get(speakerId);
    if (!speaker) return;
    const batch = speaker.batches.at(-1);
    // A transport gap is a hard boundary, even if a pending request already reached
    // its hold deadline. Its newer tail must not be reopened across this gap.
    if (batch?.boundary === 'timeout') batch.boundary = undefined;
    if (batch && !batch.boundary) this.seal(speaker, batch, 'gap');
    speaker.resetNextContext = true;
    if (!speaker.batches.length) speaker.context.length = 0;
    this.pump();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.cleanupTimer);
    for (const speaker of this.speakers.values()) {
      speaker.job?.controller.abort();
      this.clearTimer(speaker);
      for (const batch of speaker.batches) batch.spans.length = 0;
      speaker.batches.length = 0;
      speaker.context.length = 0;
    }
    this.speakers.clear();
  }

  private getSpeaker(id: string): Speaker | undefined {
    const existing = this.speakers.get(id);
    if (existing) return existing;
    this.prune();
    if (this.speakers.size >= MAX_SPEAKERS) {
      this.fail(new InterpretationFlowError('interpretation_backpressure'));
      return undefined;
    }
    const speaker: Speaker = { id, batches: [], context: [], resetNextContext: false,
      lastAudioAt: this.now(), job: undefined, timer: undefined };
    this.speakers.set(id, speaker);
    return speaker;
  }

  private openBatch(speaker: Speaker): Batch | undefined {
    const last = speaker.batches.at(-1);
    if (last && !last.boundary) return last;
    const count = [...this.speakers.values()].reduce((total, item) => total + item.batches.length, 0);
    if (count >= MAX_BATCHES) {
      this.fail(new InterpretationFlowError('interpretation_backpressure'));
      return undefined;
    }
    const batch: Batch = { spans: [], boundary: undefined, dirty: false, readyAt: this.now(),
      resetContext: speaker.resetNextContext, lateContextRetries: 0 };
    speaker.resetNextContext = false;
    speaker.batches.push(batch);
    return batch;
  }

  private content(batch: Batch): string { return batch.spans.map((span) => span.text).join(''); }

  private queuedChars(): number {
    return [...this.speakers.values()].reduce((total, speaker) => total +
      speaker.batches.reduce((sum, batch) => sum + this.content(batch).length, 0), 0);
  }

  private markDirty(batch: Batch): void {
    if (!batch.dirty) batch.readyAt = this.now();
    batch.dirty = true;
  }

  private seal(speaker: Speaker, batch: Batch, boundary: AssembledCaption['boundary']): void {
    if (batch.boundary || !batch.spans.length) return;
    batch.boundary = boundary;
    this.markDirty(batch);
    this.clearTimer(speaker);
    this.report('interpretation_flush', { speakerId: speaker.id, boundary,
      pendingChars: this.content(batch).length, inFlight: speaker.job?.batch === batch });
  }

  private pump(): void {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.running < 3) {
        const speaker = [...this.speakers.values()].filter((item) => !item.job &&
          item.batches[0]?.dirty && item.batches[0].spans.length)
          .sort((left, right) => left.batches[0]!.readyAt - right.batches[0]!.readyAt)[0];
        if (!speaker) break;
        this.expire(speaker);
        const batch = speaker.batches[0]!;
        if (batch.resetContext) {
          speaker.context.length = 0;
          batch.resetContext = false;
        }
        const job: Job = { controller: new AbortController(), batch, text: this.content(batch),
          flush: Boolean(batch.boundary), boundary: batch.boundary ?? 'semantic' };
        speaker.job = job;
        batch.dirty = false;
        this.running += 1;
        this.report('interpretation_started', { speakerId: speaker.id, flush: job.flush,
          boundary: job.boundary, queueMs: this.now() - batch.readyAt,
          oldestPendingMs: this.now() - batch.spans[0]!.receivedAt, inputChars: job.text.length });
        void this.run(speaker, job);
      }
    } finally { this.pumping = false; }
  }

  private async run(speaker: Speaker, job: Job): Promise<void> {
    const startedAt = this.now();
    speaker.context = speaker.context.filter((item) => item.at > this.now() - CONTEXT_TTL);
    try {
      const input = { text: job.text, context: speaker.context.slice(-2).map((item) => item.text),
        signal: job.controller.signal, flush: job.flush,
        ...(this.options.getConversation ? { conversation: this.options.getConversation() } : {}) };
      const reservation = this.options.usage.reserve(this.options.interpreter.estimateUsage(input));
      const result = await this.options.interpreter.interpret(input);
      if (!this.current(speaker, job)) return;
      validateInterpretation(job.text, result, job.flush);
      try { reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }); }
      catch (error) { throw error instanceof RangeError ? new UsageStorageError('invalid_data') : error; }
      if (!this.current(speaker, job)) return;
      this.report('interpretation_ready', { speakerId: speaker.id,
        latencyMs: this.now() - startedAt, completedCount: result.completed.length,
        pendingChars: result.pending.length, flush: job.flush });
      if (result.completed.length && this.recheckLateContext(speaker, job)) return;
      for (const part of result.completed) {
        if (!this.current(speaker, job)) break;
        this.emit(speaker, job.batch, part.originalText.trim().length, part.translations, job.boundary);
      }
      if (result.completed.length) job.batch.lateContextRetries = 0;
      if (!this.current(speaker, job)) return;
      if (!job.batch.spans.length) speaker.batches.shift();
      // A timer belongs to the oldest unconsumed span, not to the entire batch.
      // Finishing the old sentence can leave a much younger trailing fragment.
      else if (!job.flush && job.batch.boundary === 'timeout'
        && this.now() < job.batch.spans[0]!.receivedAt + this.options.maxHoldMs) {
        this.rebaseHold(speaker, job.batch, result.pending);
      }
      else if (job.batch.boundary) this.markDirty(job.batch);
    } catch (error) {
      if (this.current(speaker, job)) {
        const fatal = error instanceof UsageLimitError || error instanceof UsageStorageError ||
          (error instanceof InterpretationError && ['interpretation_auth', 'interpretation_model'].includes(error.code));
        if (fatal) this.fail(error);
        else if (job.flush) {
          this.notifyError(error);
          this.fail(new InterpretationFlowError('interpretation_failed'));
        } else {
          this.notifyError(error);
          if (!this.stopped) {
            // One bounded recovery attempt, using the unchanged original spans.
            this.seal(speaker, job.batch, 'fallback');
            this.markDirty(job.batch);
          }
        }
      }
    } finally {
      if (speaker.job === job) speaker.job = undefined;
      this.running -= 1;
      if (!this.stopped) {
        this.clearTimer(speaker);
        this.expire(speaker);
        this.schedule(speaker);
      }
      this.pump();
    }
  }

  private current(speaker: Speaker, job: Job): boolean {
    return !this.stopped && speaker.job === job && this.speakers.get(speaker.id) === speaker;
  }

  private recheckLateContext(speaker: Speaker, job: Job): boolean {
    const batch = job.batch;
    const sameBatchTail = this.content(batch).slice(job.text.length).trim();
    const next = speaker.batches[1];
    // A hold timeout may have placed connected new speech into the next batch.
    // Actual gaps and size boundaries must never be joined back together here.
    const canJoinNext = batch.boundary === 'timeout' && next && !next.resetContext
      && this.content(batch).length + 1 + this.content(next).length <= MAX_TEXT
      && this.queuedChars() + 1 <= MAX_QUEUED_CHARS;
    const lateText = sameBatchTail || (canJoinNext ? this.content(next).trim() : '');
    if (!lateText || !startsMeaningCorrection(lateText)) return false;
    if (batch.lateContextRetries >= 1) {
      this.report('interpretation_late_context_limit', { speakerId: speaker.id,
        addedChars: lateText.length });
      return false;
    }
    batch.lateContextRetries += 1;
    if (canJoinNext) {
      next.spans[0]!.text = ` ${next.spans[0]!.text}`;
      batch.spans.push(...next.spans);
      if (next.boundary) batch.boundary = next.boundary;
      speaker.batches.splice(1, 1);
    }
    this.markDirty(batch);
    this.report('interpretation_late_context_deferred', { speakerId: speaker.id,
      addedChars: lateText.length, retry: batch.lateContextRetries });
    return true;
  }

  private rebaseHold(speaker: Speaker, batch: Batch, examinedPending: string): void {
    const next = speaker.batches[1];
    if (next?.resetContext || (!next && speaker.resetNextContext)) {
      batch.boundary = 'gap';
      this.markDirty(batch);
      return;
    }
    if (next && (this.content(batch).length + 1 + this.content(next).length > MAX_TEXT
      || this.queuedChars() + 1 > MAX_QUEUED_CHARS)) {
      batch.boundary = 'limit';
      this.markDirty(batch);
      return;
    }
    // A deadline alone must not repeatedly resubmit the same already-examined tail.
    batch.dirty = this.content(batch).trim() !== examinedPending.trim();
    batch.boundary = undefined;
    if (next) {
      // Speech arriving after the old timer fired was placed in a fresh batch. It
      // can now join the young tail, unless a real gap/size boundary prevented it.
      next.spans[0]!.text = ` ${next.spans[0]!.text}`;
      batch.spans.push(...next.spans);
      batch.boundary = next.boundary;
      batch.readyAt = next.readyAt;
      batch.dirty = true;
      speaker.batches.splice(1, 1);
    }
    this.report('interpretation_hold_rebased', { speakerId: speaker.id,
      oldestPendingMs: this.now() - batch.spans[0]!.receivedAt,
      pendingChars: this.content(batch).length });
  }

  private schedule(speaker: Speaker): void {
    if (this.stopped || speaker.timer) return;
    const batch = speaker.batches.at(-1);
    if (!batch || batch.boundary || !batch.spans.length) return;
    const deadline = Math.min(speaker.lastAudioAt + this.options.silenceMs,
      batch.spans[0]!.receivedAt + this.options.maxHoldMs);
    speaker.timer = setTimeout(() => {
      speaker.timer = undefined;
      if (this.stopped || this.speakers.get(speaker.id) !== speaker) return;
      this.expire(speaker);
      this.schedule(speaker);
      this.pump();
    }, Math.max(0, deadline - this.now()));
    speaker.timer.unref();
  }

  private expire(speaker: Speaker): void {
    const batch = speaker.batches.at(-1);
    if (!batch || batch.boundary || !batch.spans.length) return;
    const silenceAt = speaker.lastAudioAt + this.options.silenceMs;
    const holdAt = batch.spans[0]!.receivedAt + this.options.maxHoldMs;
    if (this.now() >= Math.min(silenceAt, holdAt)) {
      this.seal(speaker, batch, silenceAt <= holdAt ? 'silence' : 'timeout');
    }
  }

  private clearTimer(speaker: Speaker): void {
    if (speaker.timer) clearTimeout(speaker.timer);
    speaker.timer = undefined;
  }

  private safeCut(text: string, count: number): number {
    return /[\uD800-\uDBFF]/u.test(text[count - 1] ?? '') &&
      /[\uDC00-\uDFFF]/u.test(text[count] ?? '') ? count - 1 : count;
  }

  /** Source text/provenance comes from retained spans, never from a model rewrite. */
  private emit(speaker: Speaker, batch: Batch, count: number, translations: Translations,
    boundary: AssembledCaption['boundary']): void {
    const sourceSegmentIds: string[] = [];
    let originalText = '';
    let speakerName = '';
    while (count > 0 && batch.spans.length) {
      const span = batch.spans[0]!;
      const consumed = span.text.slice(0, count);
      if (consumed.trim()) {
        if (!sourceSegmentIds.includes(span.sourceId)) sourceSegmentIds.push(span.sourceId);
        if (!speakerName) speakerName = span.speakerName;
      }
      originalText += consumed;
      count -= consumed.length;
      span.text = span.text.slice(consumed.length);
      if (!span.text) batch.spans.shift();
    }
    while (batch.spans.length) {
      const span = batch.spans[0]!;
      span.text = span.text.trimStart();
      if (span.text) break;
      batch.spans.shift();
    }
    originalText = originalText.trim();
    if (originalText && !this.stopped) {
      speaker.context.push({ text: originalText.slice(-1_000), at: this.now() });
      speaker.context = speaker.context.slice(-2);
      this.options.onCaption({ segmentId: `${sourceSegmentIds[0]}:interpreted:${++this.sequence}`,
        speakerId: speaker.id, speakerName, originalText, sourceSegmentIds, boundary,
        translations: { ...translations } });
    }
  }

  private notifyError(error: unknown): void {
    try { this.options.onError(error); } catch { this.stop(); }
  }

  private fail(error: unknown): void {
    try { this.notifyError(error); } finally { this.stop(); }
  }

  private report(event: string, fields: Record<string, string | number | boolean>): void {
    try { this.options.onDiagnostic(event, fields); } catch { /* Diagnostics cannot interrupt audio. */ }
  }

  private prune(): void {
    if (this.stopped) return;
    const cutoff = this.now() - CONTEXT_TTL;
    for (const speaker of this.speakers.values()) {
      speaker.context = speaker.context.filter((item) => item.at > cutoff);
      if (!speaker.batches.length && !speaker.job && !speaker.context.length && speaker.lastAudioAt <= cutoff) {
        this.clearTimer(speaker);
        this.speakers.delete(speaker.id);
      }
    }
  }
}
