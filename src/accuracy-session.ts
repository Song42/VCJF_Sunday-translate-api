import type { Caption } from './types.js';
import type { ConversationSnapshot } from './conversation-memory.js';
import { reviewReasons, type Reviewer } from './accuracy-review.js';
import { selectRelevantGlossary, type GlossaryEntry } from './glossary.js';
import type { AudioRetranscriber } from './audio-retranscribe.js';
import { UsageLimitError, UsageStorageError, type UsageLedger } from './usage.js';

interface Evidence { id: string; speakerId: string; parts: Buffer[]; bytes: number; at: number; text: string;
  conflict: boolean; intact: boolean; final: boolean; order: number; revision: number }
interface PendingCaption { caption: Caption; lateNegation: boolean; contextVersion: number; timer: NodeJS.Timeout }
const RETENTION_MS = 90_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const REVERSAL = /^(?:아니라|아니에요|아닙니다|아니요|그게 아니라|(?:not|no|but\s+(?:not|rather)|не|нет|а\s+не|емес|жоқ)(?=$|[^\p{L}\p{N}]))/iu;

export interface AccuracySessionOptions {
  reviewer: Reviewer;
  retranscriber: AudioRetranscriber;
  glossary: readonly GlossaryEntry[];
  usage: Pick<UsageLedger, 'reserve'>;
  getConversation: () => ConversationSnapshot;
  sttHints: { prompt: string; keywords: readonly string[]; languages: readonly string[] };
  onCaption: (caption: Caption) => void;
  onDiagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void;
  onFatal: (error: unknown) => void;
  now?: () => number;
  stabilityMs?: number;
}

/** Initial delivery never awaits review. Each caption receives at most one final update. */
export class AccuracySession {
  private readonly evidence = new Map<string, Evidence>();
  private readonly pending = new Map<number, PendingCaption>();
  private readonly queue: PendingCaption[] = [];
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly cleanup: NodeJS.Timeout;
  private readonly reread = new Map<string, { text: string; at: number }>();
  private readonly seen = new Set<number>();
  private readonly speakerRisks = new Map<string, number>();
  private readonly discardedAudioIds = new Set<string>();
  private suppressNewAudio = false;
  private activePcm: Buffer | undefined;
  private order = 0;
  private totalBytes = 0;
  private running = false;
  private stopped = false;
  constructor(private readonly options: AccuracySessionOptions) {
    if (options.stabilityMs !== undefined && (!Number.isSafeInteger(options.stabilityMs)
      || options.stabilityMs < 0 || options.stabilityMs > 10_000)) throw new RangeError('Invalid accuracy stabilization window.');
    this.now = options.now ?? Date.now;
    this.cleanup = setInterval(() => this.prune(), 10_000);
    this.cleanup.unref();
  }

  audio(id: string, speakerId: string, pcm: Buffer): void {
    if (this.stopped || !pcm.length) return;
    this.prune();
    let entry = this.evidence.get(id);
    if (!entry) {
      entry = { id, speakerId, parts: [], bytes: 0, at: this.now(), text: '', conflict: false,
        intact: !this.suppressNewAudio && !this.discardedAudioIds.has(id), final: false, order: ++this.order, revision: 0 };
      this.evidence.set(id, entry);
    }
    if (!entry.intact || entry.final || entry.speakerId !== speakerId) return;
    const part = Buffer.from(pcm);
    entry.parts.push(part); entry.bytes += part.length; entry.at = this.now(); this.totalBytes += part.length;
    this.prune();
  }

  transcript(id: string, speakerId: string, text: string, conflict = false): void {
    if (this.stopped) return;
    this.prune();
    let entry = this.evidence.get(id);
    if (!entry) {
      entry = { id, speakerId, parts: [], bytes: 0, at: this.now(), text: '', conflict: false,
        intact: false, final: false, order: ++this.order, revision: 0 };
      this.evidence.set(id, entry);
    }
    if (entry.speakerId !== speakerId) return;
    if (entry.text !== text) entry.revision += 1;
    entry.text = text.slice(0, 12_000); entry.conflict ||= conflict; entry.final = true; entry.at = this.now();
    for (const pending of this.pending.values()) {
      if (pending.caption.speakerId === speakerId && (conflict || entry.revision > 1)
        && (pending.caption.sourceSegmentIds ?? [pending.caption.segmentId]).includes(id)) pending.contextVersion += 1;
    }
    if (REVERSAL.test(text.trim())) {
      let matchedPending = false;
      for (const pending of this.pending.values()) {
        if (pending.caption.speakerId === speakerId && this.now() - pending.caption.createdAt < 8_000
          && !(pending.caption.sourceSegmentIds ?? [pending.caption.segmentId]).includes(id)) {
          pending.lateNegation = true; pending.contextVersion += 1;
          matchedPending = true;
        }
      }
      if (!matchedPending) this.markSpeakerRisk(speakerId);
    }
    this.prune();
  }

  markSpeakerRisk(speakerId: string): void {
    if (this.stopped) return;
    this.speakerRisks.set(speakerId, this.now());
    if (this.speakerRisks.size > 64) this.speakerRisks.delete(this.speakerRisks.keys().next().value!);
  }

  publish(caption: Caption): void {
    if (this.stopped || caption.status === 'final' || this.seen.has(caption.sequence)) return;
    // Sequence numbers are small and unique per meeting; remember emitted identities so
    // a repeated callback can never reopen a finalized caption.
    this.seen.add(caption.sequence);
    caption = { ...caption, translations: { ...caption.translations },
      ...(caption.sourceSegmentIds ? { sourceSegmentIds: [...caption.sourceSegmentIds] } : {}) };
    this.options.onCaption({ ...caption, translations: { ...caption.translations }, status: 'initial', revision: caption.revision ?? 0 });
    if (this.stopped) return;
    // Explicit callers can opt into a stabilization window; live captions add no fixed delay.
    if (this.pending.size >= 24) {
      this.finish(caption, 'skipped', ['review_capacity']); return;
    }
    const riskAt = this.speakerRisks.get(caption.speakerId);
    this.speakerRisks.delete(caption.speakerId);
    const entry: PendingCaption = { caption, lateNegation: riskAt !== undefined && this.now() - riskAt < 8_000, contextVersion: 0,
      timer: setTimeout(() => {
        if (this.stopped) return;
        const reasons = this.reasons(entry);
        if (!reasons.length) { this.finish(caption, 'not_needed', []); return; }
        if (this.queue.length >= 6) { this.finish(caption, 'skipped', ['review_capacity', ...reasons]); return; }
        this.queue.push(entry); this.pump();
      }, this.options.stabilityMs ?? 0) };
    entry.timer.unref(); this.pending.set(caption.sequence, entry);
  }

  stop(): void {
    this.stopped = true; this.controller.abort(); clearInterval(this.cleanup);
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear(); this.queue.length = 0;
    this.activePcm?.fill(0); this.activePcm = undefined;
    for (const id of this.evidence.keys()) this.remove(id);
    this.reread.clear(); this.speakerRisks.clear(); this.discardedAudioIds.clear(); this.seen.clear();
  }

  isSettled(): boolean { return this.pending.size === 0 && this.queue.length === 0 && !this.running; }

  private source(caption: Caption): Evidence[] {
    return [...new Set(caption.sourceSegmentIds ?? [caption.segmentId])].map((id) => this.evidence.get(id))
      .filter((x): x is Evidence => !!x && x.speakerId === caption.speakerId);
  }
  private reviewSources(entry: PendingCaption): Evidence[] {
    const sources = this.source(entry.caption);
    if (!entry.lateNegation) return sources;
    const ids = new Set(sources.map((source) => source.id));
    const lastOrder = Math.max(0, ...sources.map((source) => source.order));
    const earliest = Math.min(entry.caption.createdAt, ...sources.map((source) => source.at)) - 8_000;
    // Same-speaker later turns can already exist when an in-flight initial caption is
    // published. Include their text as scoped evidence, never another speaker's words.
    const following = [...this.evidence.values()].filter((source) => source.speakerId === entry.caption.speakerId
      && source.final && !!source.text && !ids.has(source.id) && source.order > lastOrder
      && source.at >= earliest && source.at <= entry.caption.createdAt + 8_000)
      .sort((a, b) => a.order - b.order).slice(0, 3);
    return [...sources, ...following];
  }
  private reasons(entry: PendingCaption): string[] {
    return reviewReasons(entry.caption, selectRelevantGlossary(this.options.glossary, [entry.caption.originalText]), {
      transcriptConflict: this.source(entry.caption).some((source) => source.conflict), lateNegation: entry.lateNegation,
    });
  }
  private pump(): void {
    if (this.stopped || this.running || !this.queue.length) return;
    const next = this.queue.shift()!; this.running = true;
    void this.review(next).finally(() => { this.running = false; this.pump(); });
  }
  private async review(entry: PendingCaption): Promise<void> {
    const { caption } = entry;
    let reasons = this.reasons(entry);
    let sources = this.reviewSources(entry);
    const requiredIds = [...new Set(caption.sourceSegmentIds ?? [caption.segmentId])];
    const key = sources.map((source) => `${source.id}:${source.revision}`).join('|');
    const completeSourceCoverage = requiredIds.every((id) => sources.some((source) => source.id === id))
      && sources.every((source) => source.final);
    let pcm: Buffer | undefined;
    try {
      let independentTranscript = completeSourceCoverage ? this.reread.get(key)?.text : undefined;
      const bytes = sources.reduce((sum, source) => sum + source.bytes, 0);
      // Never label a cropped/missing source span as complete independent audio evidence.
      if (!independentTranscript && completeSourceCoverage
        && sources.every((source) => source.intact && source.final && source.bytes >= 4_800)
        && bytes >= 4_800 && bytes <= 30 * 48_000) {
        pcm = Buffer.concat(sources.flatMap((source) => source.parts), bytes);
        this.activePcm = pcm;
        const reservation = this.options.usage.reserve({ audioMs: bytes / 48 }, { sttPerMinuteUsd: 0.0045 });
        try {
          const result = await this.options.retranscriber.transcribe({ pcm, signal: this.controller.signal, ...this.options.sttHints });
          if (this.stopped) return;
          reservation.settle({ audioMs: bytes / 48 });
          independentTranscript = result.text;
          this.reread.set(key, { text: result.text, at: this.now() });
          if (this.reread.size > 32) this.reread.delete(this.reread.keys().next().value!);
        } catch (error) {
          if (this.stopped) return;
          if (error instanceof UsageLimitError || error instanceof UsageStorageError || error instanceof RangeError) throw error;
          this.options.onDiagnostic('accuracy_audio_review_failed', { sequence: caption.sequence });
          // A missing independent transcript is explicit: continue only as a text review.
        } finally { pcm.fill(0); pcm = undefined; this.activePcm = undefined; }
      }
      if (this.stopped) return;
      reasons = this.reasons(entry);
      sources = this.reviewSources(entry);
      const contextVersion = entry.contextVersion;
      const conversation = this.options.getConversation();
      const input = { originalText: caption.originalText, translations: caption.translations,
        sourceTranscripts: sources.filter((source) => !!source.text.trim()).map(({ id, text }) => ({ id, text })),
        ...(independentTranscript ? { independentTranscript } : {}), conversation,
        glossary: selectRelevantGlossary(this.options.glossary, [caption.originalText, independentTranscript ?? '', ...conversation.recent.map((item) => item.text)]),
        reasons, signal: this.controller.signal };
      const reservation = this.options.usage.reserve(this.options.reviewer.estimateUsage(input));
      const result = await this.options.reviewer.review(input);
      if (this.stopped) return;
      reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      const lateEvidence = entry.contextVersion !== contextVersion;
      this.options.onDiagnostic('accuracy_review_finished', { sequence: caption.sequence,
        changed: result.changed && !result.uncertain && !lateEvidence,
        uncertain: result.uncertain || lateEvidence, audioEvidence: !!independentTranscript });
      this.finish({ ...caption, translations: lateEvidence || result.uncertain ? caption.translations : result.translations },
        lateEvidence || result.uncertain ? 'uncertain' : 'verified', lateEvidence ? [...reasons, 'late_context_after_review'] : reasons);
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof UsageLimitError || error instanceof UsageStorageError || error instanceof RangeError) {
        this.stop(); this.options.onFatal(error instanceof RangeError ? new UsageStorageError('invalid_data') : error); return;
      }
      this.options.onDiagnostic('accuracy_review_failed', { sequence: caption.sequence });
      this.finish(caption, 'failed', reasons);
    } finally { pcm?.fill(0); this.activePcm = undefined; }
  }

  private finish(caption: Caption, state: NonNullable<Caption['accuracy']>['state'], reasons: string[]): void {
    if (this.stopped) return;
    const pending = this.pending.get(caption.sequence);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(caption.sequence);
    const uncertain = caption.accuracy?.state === 'uncertain';
    this.options.onCaption({ ...caption, status: 'final', revision: (caption.revision ?? 0) + 1,
      accuracy: { state: uncertain ? 'uncertain' : state, reasons: [...new Set([...(caption.accuracy?.reasons ?? []), ...reasons])] } });
  }
  private prune(): void {
    for (const [id, entry] of this.evidence) {
      if (entry.at < this.now() - RETENTION_MS || this.evidence.size > 256) this.remove(id);
      else if (this.totalBytes > MAX_AUDIO_BYTES && entry.bytes) this.discardAudio(entry);
    }
    for (const [key, value] of this.reread) if (value.at < this.now() - RETENTION_MS) this.reread.delete(key);
    for (const [id, at] of this.speakerRisks) if (at < this.now() - 8_000) this.speakerRisks.delete(id);
  }
  private discardAudio(entry: Evidence): void {
    for (const part of entry.parts) part.fill(0);
    this.totalBytes -= entry.bytes; entry.parts.length = 0; entry.bytes = 0; entry.intact = false;
  }
  private remove(id: string): void {
    const entry = this.evidence.get(id); if (!entry) return;
    this.discardAudio(entry); this.evidence.delete(id);
    if (!this.stopped) {
      // A later packet for an evicted ID must never look like a complete new turn.
      if (this.discardedAudioIds.size < 10_000) this.discardedAudioIds.add(id);
      else this.suppressNewAudio = true;
    }
  }
}
