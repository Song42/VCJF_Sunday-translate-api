import type { Caption } from './types.js';
import type { Segmenter } from './segment.js';
import { validateSegmentation } from './segment.js';
import type { Translator, Translations } from './translate.js';
import type { ConversationSnapshot } from './conversation-memory.js';
import { startsMeaningCorrection } from './interpreted-captions.js';
import { completedSentencePrefix } from './sentence-boundary.js';
import { UsageLimitError, UsageStorageError, type UsageLedger, type UsageRates } from './usage.js';

interface Source { id: string; speakerId: string; text: string; final: boolean; failed: boolean }
interface Span { source: Source; start: number; end?: number }
interface TranslationAttempt {
  controller: AbortController; text: string; version: number; frozen: Unit['frozen'];
}
interface Unit {
  sequence: number; speakerId: string; speakerName: string; spans: Span[]; version: number; revision: number;
  closing: boolean; frozen?: { text: string; ids: string[]; reason: string };
  dirty: boolean; running: boolean; checking: boolean; checkedVersion: number; nextAt: number;
  failures: number; last?: { text: string; translations: Translations }; timer?: NodeJS.Timeout;
  nextCheckAt: number;
  attempt?: TranslationAttempt; draftCancellations: number;
}

const CANCELLED_TRANSLATION = Symbol('cancelled translation');

/** Release local scheduling even if an old transport ignores cancellation. */
async function whileActive<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(CANCELLED_TRANSLATION);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

function continuesOrCorrects(text: string): boolean {
  return startsMeaningCorrection(text) || /^(?:했습니다|합니다|했어요|됩니다|습니다)/u.test(text.trimStart());
}

export class StreamingCaptionError extends Error {
  constructor(readonly code: 'streaming_backpressure' | 'streaming_translation_failed') { super(code); }
}
export interface StreamingCaptionOptions {
  translator: Translator;
  segmenter: Segmenter;
  usage: Pick<UsageLedger, 'reserve'>;
  segmentationRates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
  allocateSequence: () => number;
  getConversation: () => ConversationSnapshot;
  onDraft: (caption: Caption) => void;
  onStable: (caption: Caption) => void;
  onError: (error: unknown) => void;
  onDiagnostic: (event: string, fields: Record<string, string | number | boolean>) => void;
  onTrace?: (event: string, fields: Record<string, unknown>) => void;
  draftIntervalMs?: number;
  now?: () => number;
}

/** Draft translation and semantic commitment have separate schedules and identities. */
export class StreamingCaptionCoordinator {
  private readonly sources = new Map<string, Source>();
  private readonly units: Unit[] = [];
  private readonly open = new Map<string, Unit>();
  private readonly controller = new AbortController();
  private readonly busySpeakers = new Set<string>();
  private readonly now: () => number;
  private readonly interval: number;
  private running = 0;
  private checking = 0;
  private stopped = false;
  private pumping = false;

  constructor(private readonly options: StreamingCaptionOptions) {
    this.now = options.now ?? Date.now;
    this.interval = options.draftIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.interval) || this.interval < 100) throw new RangeError('Invalid draft interval');
  }

  startSource(id: string, speakerId: string, speakerName: string): void {
    if (this.stopped) return;
    let unit = this.open.get(speakerId);
    if (!unit || unit.closing || unit.frozen) {
      unit = this.newUnit(speakerId, speakerName);
      if (!unit) return;
      this.open.set(speakerId, unit);
    }
    const source: Source = { id, speakerId, text: '', final: false, failed: false };
    this.sources.set(id, source); unit.spans.push({ source, start: 0 }); unit.version++;
  }

  updateSource(id: string, text: string, final: boolean, failed = false): void {
    if (this.stopped) return;
    const source = this.sources.get(id);
    if (!source || source.final) return;
    if (text.length > 8_000) { this.fail(new StreamingCaptionError('streaming_backpressure')); return; }
    const changed = source.text !== text || source.final !== final;
    source.text = text.trim(); source.final = final; source.failed = failed;
    if (!changed && !failed) return;
    this.trace('live_transcript', { speakerId: source.speakerId, sourceId: id, text: source.text, final, failed });
    for (const unit of [...this.units]) {
      if (unit.frozen || !unit.spans.some((span) => span.source === source)) continue;
      unit.version++; unit.dirty = true;
      if (unit.closing && this.resolved(unit)) this.freeze(unit, this.text(unit), 'silence');
      else {
        const sentence = completedSentencePrefix(this.stablePrefix(unit));
        if (sentence) this.freeze(unit, sentence, 'punctuation');
      }
      if (!unit.frozen && this.text(unit).length > 7_000) {
        const stable = this.stablePrefix(unit).slice(0, 6_000);
        const cut = stable.lastIndexOf(' ');
        if (stable.trim()) this.freeze(unit, (cut > 3_000 ? stable.slice(0, cut) : stable).trim(), 'limit');
      }
      this.cancelObsolete(unit);
      this.schedule(unit);
    }
    this.pump();
  }

  silence(speakerId: string): void {
    const unit = this.open.get(speakerId);
    if (this.stopped || !unit || unit.frozen) return;
    unit.closing = true; unit.version++; unit.dirty = true;
    this.open.delete(speakerId);
    this.trace('live_boundary', { sequence: unit.sequence, speakerId, reason: 'speech_silence', text: this.text(unit),
      unresolvedSources: unit.spans.filter((span) => !span.source.final).map((span) => span.source.id) });
    if (this.resolved(unit)) this.freeze(unit, this.text(unit), 'silence');
    this.schedule(unit); this.pump();
  }

  gap(speakerId: string): void {
    for (const source of this.sources.values()) {
      if (source.speakerId === speakerId && !source.final) this.updateSource(source.id, source.text, true, true);
    }
    this.silence(speakerId);
  }

  stop(): void {
    this.stopped = true; this.controller.abort();
    for (const unit of this.units) if (unit.timer) clearTimeout(unit.timer);
    this.units.length = 0; this.sources.clear(); this.open.clear(); this.busySpeakers.clear();
  }

  isSettled(): boolean { return this.units.length === 0 && this.running === 0 && this.checking === 0; }

  private newUnit(speakerId: string, speakerName: string): Unit | undefined {
    if (this.units.length >= 128) { this.fail(new StreamingCaptionError('streaming_backpressure')); return; }
    const unit: Unit = { sequence: this.options.allocateSequence(), speakerId, speakerName, spans: [], version: 0, revision: 0,
      closing: false, dirty: false, running: false, checking: false, checkedVersion: -1,
      nextAt: this.now() + this.interval, nextCheckAt: 0, failures: 0, draftCancellations: 0 };
    this.units.push(unit); return unit;
  }
  private spanText(span: Span): string { return span.source.text.slice(span.start, span.end); }
  private text(unit: Unit): string { return unit.frozen?.text ?? unit.spans.map((span) => this.spanText(span)).filter((text) => text.trim()).join(' ').trim(); }
  private resolved(unit: Unit): boolean { return unit.spans.every((span) => span.source.final); }
  private ids(unit: Unit): string[] { return unit.frozen?.ids ?? [...new Set(unit.spans.filter((span) => this.spanText(span).trim()).map((span) => span.source.id))]; }
  private stablePrefix(unit: Unit): string {
    const result: string[] = [];
    for (const span of unit.spans) { if (!span.source.final || span.source.failed) break; if (this.spanText(span).trim()) result.push(this.spanText(span)); }
    return result.join(' ').trim();
  }

  private schedule(unit: Unit): void {
    if (this.stopped || !this.units.includes(unit) || unit.timer || unit.running || !unit.dirty) return;
    const wait = Math.max(0, unit.nextAt - this.now());
    if (!wait) return;
    unit.timer = setTimeout(() => { delete unit.timer; this.pump(); }, wait); unit.timer.unref();
  }

  private cancelObsolete(unit: Unit, finalizing = false): void {
    const attempt = unit.attempt;
    if (!attempt || attempt.controller.signal.aborted || attempt.frozen) return;
    const current = this.text(unit);
    const invalid = attempt.frozen !== unit.frozen || !current.startsWith(attempt.text)
      || continuesOrCorrects(current.slice(attempt.text.length));
    if (!invalid || (!finalizing && unit.draftCancellations >= 2)) return;
    if (!finalizing) {
      unit.draftCancellations++;
      // Let rapid STT corrections accumulate before issuing the replacement.
      unit.nextAt = Math.max(unit.nextAt, this.now() + Math.min(200, this.interval));
    }
    unit.dirty = true;
    attempt.controller.abort();
    this.options.onDiagnostic('live_translation_cancelled', { sequence: unit.sequence, version: attempt.version,
      reason: finalizing ? 'finalizing' : 'source_changed' });
  }

  private pump(): void {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      for (const unit of [...this.units].sort((a, b) => Number(!!b.frozen) - Number(!!a.frozen))) {
        if (this.stopped) break;
        const text = this.text(unit);
        if (!text && unit.closing && this.resolved(unit)) { this.remove(unit); continue; }
        if (!unit.running && unit.dirty && text && this.running < 3 && !this.busySpeakers.has(unit.speakerId)) {
          if (this.now() >= unit.nextAt) {
            unit.running = true; unit.dirty = false; unit.nextAt = this.now() + this.interval;
            this.running++; this.busySpeakers.add(unit.speakerId);
            void this.translate(unit);
          } else this.schedule(unit);
        }
        // Boundary work is independent: drafts never await this model response.
        if (!unit.frozen && !unit.closing && !unit.checking && unit.checkedVersion !== unit.version && this.checking < 2 && this.now() >= unit.nextCheckAt) {
          const stable = this.stablePrefix(unit);
          const spans = unit.spans.filter((span) => this.spanText(span).trim());
          if (stable && spans.length >= 2 && text.length >= 12 && this.spanText(spans.at(-1)!).trim().length >= 6) {
            unit.checking = true; unit.checkedVersion = unit.version; this.checking++;
            unit.nextCheckAt = this.now() + 2_000;
            void this.checkPrefix(unit, text, unit.version, stable.length);
          }
        }
      }
    } finally { this.pumping = false; }
  }

  private async translate(unit: Unit): Promise<void> {
    const startedAt = this.now();
    const text = this.text(unit), version = unit.version, frozen = unit.frozen;
    const ids = [...this.ids(unit)];
    const attempt: TranslationAttempt = { controller: new AbortController(), text, version, frozen };
    unit.attempt = attempt;
    const signal = AbortSignal.any([this.controller.signal, attempt.controller.signal]);
    try {
      let translations = unit.last?.text === text ? unit.last.translations : undefined;
      if (!translations) {
        const conversation = this.options.getConversation();
        const input = { originalText: text, context: conversation.recent.filter((item) => item.speakerId === unit.speakerId).slice(-2).map((item) => item.text),
          conversation, provisional: !frozen, signal };
        this.trace('live_translation_requested', { sequence: unit.sequence, speakerId: unit.speakerId, version,
          targetText: text, sourceIds: ids, phase: frozen ? 'settling' : 'draft', reason: frozen?.reason ?? 'incremental' });
        const reservation = this.options.usage.reserve(this.options.translator.estimateUsage(input));
        const result = await whileActive(this.options.translator.translate(input), signal);
        reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        translations = result.translations;
      }
      if (this.stopped || signal.aborted || unit.attempt !== attempt || !this.units.includes(unit)) return;
      unit.failures = 0;
      // A semantic split or a corrected transcript can invalidate an in-flight draft.
      // Ordinary appended words may keep the older result as an explicitly provisional caption.
      if (unit.frozen !== frozen || (!frozen && (!this.text(unit).startsWith(text)
        || continuesOrCorrects(this.text(unit).slice(text.length))))) {
        unit.dirty = true; this.options.onDiagnostic('live_translation_superseded', { sequence: unit.sequence, version }); return;
      }
      unit.last = { text, translations: { ...translations } };
      unit.draftCancellations = 0;
      this.options.onDiagnostic('live_translation_ready', { sequence: unit.sequence, version,
        latencyMs: this.now() - startedAt, provisional: !frozen, inputChars: text.length });
      const caption: Caption = { type: 'caption', sequence: unit.sequence, segmentId: `live-${unit.sequence}`,
        speakerId: unit.speakerId, speakerName: unit.speakerName, originalText: text,
        translations: { ...translations }, sourceSegmentIds: ids, createdAt: this.now(),
        status: frozen ? 'initial' : 'draft', revision: unit.revision++,
        boundary: frozen?.reason === 'silence' ? 'silence' : frozen?.reason === 'limit' ? 'limit' : 'semantic' };
      this.trace('live_translation_published', { sequence: unit.sequence, version, revision: caption.revision,
        status: caption.status, originalText: text, sourceIds: ids, pendingText: frozen ? '' : this.text(unit).slice(text.length).trim() });
      if (frozen) {
        if (unit.spans.some((span) => span.source.failed)) caption.accuracy = { state: 'uncertain', reasons: ['unconfirmed_transcript'] };
        this.remove(unit); this.options.onStable(caption);
      } else this.options.onDraft(caption);
    } catch (error) {
      if (this.stopped || signal.aborted || error === CANCELLED_TRANSLATION) return;
      if (error instanceof UsageLimitError || error instanceof UsageStorageError || error instanceof RangeError) { this.fail(error); return; }
      unit.failures++; this.options.onError(error);
      if (unit.failures >= 3) { this.fail(new StreamingCaptionError('streaming_translation_failed')); return; }
      unit.dirty = true; unit.nextAt = this.now() + 2_000;
    } finally {
      if (unit.attempt === attempt) delete unit.attempt;
      unit.running = false; this.running--; this.busySpeakers.delete(unit.speakerId);
      if (!this.stopped) { this.schedule(unit); this.pump(); }
    }
  }

  private async checkPrefix(unit: Unit, text: string, version: number, stableLength: number): Promise<void> {
    try {
      const context = this.options.getConversation().recent.slice(-2).map((item) => item.text);
      const input = { text, context, signal: this.controller.signal };
      const reservation = this.options.usage.reserve(this.options.segmenter.estimateUsage(input), this.options.segmentationRates);
      const result = await this.options.segmenter.segment(input);
      reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      if (this.stopped || !this.units.includes(unit) || unit.frozen || unit.closing) return;
      validateSegmentation(text, result);
      const current = this.text(unit);
      // Never accept a boundary chosen without the newest correction/contrast evidence.
      if (version !== unit.version && (!current.startsWith(text) || continuesOrCorrects(current.slice(text.length)))) return;
      let remaining = text, prefix = '';
      for (const complete of result.completed) {
        const start = remaining.indexOf(complete.trim());
        const next = prefix + remaining.slice(0, start + complete.trim().length);
        const tail = current.slice(next.length).trim();
        if (next.length > stableLength || tail.length < 6 || continuesOrCorrects(tail)) break;
        prefix = next; remaining = text.slice(prefix.length);
      }
      this.trace('live_boundary_decision', { sequence: unit.sequence, speakerId: unit.speakerId,
        inputText: text, completed: result.completed, heldText: result.pending, acceptedPrefix: prefix, stableSourceLength: stableLength });
      if (prefix.trim()) this.freeze(unit, prefix.trim(), 'stable_prefix');
    } catch (error) {
      if (!this.stopped) {
        if (error instanceof UsageLimitError || error instanceof UsageStorageError || error instanceof RangeError) this.fail(error);
        else this.options.onDiagnostic('live_boundary_check_failed', { sequence: unit.sequence });
      }
    } finally { unit.checking = false; this.checking--; if (!this.stopped) this.pump(); }
  }

  private freeze(unit: Unit, prefix: string, reason: string): void {
    if (this.stopped || unit.frozen || !prefix) return;
    const all = this.text(unit);
    if (!all.startsWith(prefix)) { this.fail(new StreamingCaptionError('streaming_backpressure')); return; }
    const selected: Span[] = [], tail: Span[] = [];
    let left = prefix.length;
    for (const span of unit.spans) {
      const text = this.spanText(span);
      if (!text.trim()) { tail.push(span); continue; }
      if (selected.length && left > 0) left--; // Synthetic separator between source turns.
      const count = Math.max(0, Math.min(left, text.length));
      if (count) selected.push({ source: span.source, start: span.start, end: span.start + count });
      left -= count;
      if (count < text.length) {
        const whitespace = text.slice(count).length - text.slice(count).trimStart().length;
        tail.push({ ...span, start: span.start + count + whitespace });
      }
    }
    unit.spans = selected;
    unit.frozen = { text: prefix, ids: [...new Set(selected.map((span) => span.source.id))], reason };
    unit.version++; unit.dirty = true; unit.nextAt = this.now();
    this.cancelObsolete(unit, true);
    if (unit.timer) clearTimeout(unit.timer); delete unit.timer;
    if (tail.length) {
      const next = this.newUnit(unit.speakerId, unit.speakerName);
      if (!next) return;
      next.spans = tail; next.closing = unit.closing; next.dirty = !!this.text(next); next.version++;
      if (!next.closing) this.open.set(unit.speakerId, next);
      if (next.closing && this.resolved(next) && this.text(next)) this.freeze(next, this.text(next), reason);
      this.schedule(next);
    } else if (this.open.get(unit.speakerId) === unit) this.open.delete(unit.speakerId);
    this.trace('live_caption_settling', { sequence: unit.sequence, speakerId: unit.speakerId, reason,
      targetText: prefix, sourceIds: unit.frozen.ids, pendingText: all.slice(prefix.length).trim() });
  }

  private remove(unit: Unit): void {
    if (unit.timer) clearTimeout(unit.timer);
    const index = this.units.indexOf(unit); if (index >= 0) this.units.splice(index, 1);
    if (this.open.get(unit.speakerId) === unit) this.open.delete(unit.speakerId);
    const retained = new Set(this.units.flatMap((item) => item.spans.map((span) => span.source.id)));
    for (const id of this.sources.keys()) if (!retained.has(id)) this.sources.delete(id);
  }
  private trace(event: string, fields: Record<string, unknown>): void { this.options.onTrace?.(event, fields); }
  private fail(error: unknown): void { this.stop(); this.options.onError(error instanceof RangeError ? new UsageStorageError('invalid_data') : error); }
}
