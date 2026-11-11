import { randomUUID } from 'node:crypto';
import { SttError, type Transcriber } from './stt.js';
import { TranslationError, type Translator } from './translate.js';
import { UsageLimitError, UsageStorageError, type UsageLedger, type UsageReservation, type UsageRates } from './usage.js';
import type { Caption, CaptionBoundary } from './types.js';
import { CaptionAssembler, type AssembledCaption, type TranscriptPiece } from './caption-assembler.js';
import { SegmentationError, type Segmenter } from './segment.js';
import { SemanticCaptionAssembler } from './semantic-captions.js';
import { InterpretationError, type Interpreter } from './interpret.js';
import { InterpretedCaptionAssembler, InterpretationFlowError } from './interpreted-captions.js';
import type { Translations } from './translate.js';
import { ModelComparisonAssembler, type ComparisonVariant } from './model-comparison.js';
import type { ConversationMemory } from './conversation-memory.js';
import { AccuracySession, type AccuracySessionOptions } from './accuracy-session.js';
import { StreamingCaptionCoordinator, StreamingCaptionError } from './streaming-captions.js';
import { VoiceActivityDetector } from './voice-activity.js';
import { endsWithSentenceBoundary } from './sentence-boundary.js';

const BYTES_PER_MS = 48;
const BATCH_BYTES = 4_800; // 100 ms; avoid empty/too-short commits.
const RETENTION_MS = 10 * 60_000;
const COALESCE_AFTER_JOBS = 12;
const MAX_TRANSLATION_JOBS = 192;
const MAX_TRANSLATION_QUEUE_CHARS = 96_000;
const MAX_TRANSLATION_TEXT_CHARS = 8_000;

interface Segment {
  id: string;
  sequence: number;
  speakerId: string;
  speakerName: string;
  parts: Buffer[];
  buffered: number;
  total: number;
  sent: number;
  reservation: UsageReservation;
  settled: boolean;
  timer: NodeJS.Timeout;
  partialText?: string;
}

interface SpeakerSession {
  id: string;
  stt: Transcriber;
  chain: Promise<void>;
  closed: boolean;
  current: Segment | undefined;
  segments: Set<Segment>;
  buffers: Set<Buffer>;
  heldBytes: number;
  pending: number;
  idleTimer: NodeJS.Timeout | undefined;
  turnOrder: number[];
  results: Map<number, TranscriptPiece | null | 'empty'>;
  commitIndex: number;
  commits: Map<number, Segment>;
  vad: VoiceActivityDetector;
  lastVoiceAt: number | undefined;
  silenceTimer: NodeJS.Timeout | undefined;
}

interface TranslationJob {
  segmentId: string;
  sequence: number;
  speakerId: string;
  speakerName: string;
  originalText: string;
  sourceSegmentIds?: string[];
  boundary?: CaptionBoundary;
  comparison?: NonNullable<Caption['comparison']>;
}

export interface PipelineOptions {
  segmentMs: number;
  sentenceCaptions?: boolean;
  captionHoldMs?: number;
  segmenter?: Segmenter;
  interpreter?: Interpreter;
  streamingCaptions?: boolean;
  draftIntervalMs?: number;
  speechSilenceMs?: number;
  memory?: ConversationMemory;
  accuracy?: Omit<AccuracySessionOptions, 'getConversation' | 'onCaption' | 'onFatal' | 'now'>;
  comparisonVariants?: ComparisonVariant[];
  segmentationRates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
  captionSilenceMs?: number;
  captionMaxHoldMs?: number;
  idleSessionMs?: number;
  createTranscriber: () => Transcriber;
  translator: Translator;
  usage: Pick<UsageLedger, 'reserve' | 'snapshot'>;
  speakerName: (speakerId: string) => string;
  onCaption: (caption: Caption) => void;
  onSourceAudio?: (segmentId: string, speakerId: string, pcm: Buffer) => void;
  onSourceTranscript?: (segmentId: string, speakerId: string, text: string) => void;
  onDiagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void;
  onTrace?: (event: string, fields: Record<string, unknown>) => void;
  onFatal?: (code: string) => void;
  now?: () => number;
}

/** One meeting. Each speaker owns a live STT session; viewers never start API work. */
export class LiveTranslationPipeline {
  private active = true;
  private readonly sessions = new Map<string, SpeakerSession>();
  private readonly cooldowns = new Map<string, number>();
  private readonly controller = new AbortController();
  private readonly meetingId = randomUUID();
  private sequence = 0;
  private captionSequence = 0;
  private readonly assembler: CaptionAssembler | SemanticCaptionAssembler | InterpretedCaptionAssembler | ModelComparisonAssembler | undefined;
  private readonly semanticAssembler: SemanticCaptionAssembler | InterpretedCaptionAssembler | ModelComparisonAssembler | undefined;
  private readonly idleSessionMs: number;
  private readonly captions: Caption[] = [];
  private readonly history: { sequence: number; speakerId: string; text: string; at: number }[] = [];
  private readonly jobs: TranslationJob[] = [];
  private translating = 0;
  private readonly translatingSpeakers = new Set<string>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly accuracy: AccuracySession | undefined;
  private readonly streaming: StreamingCaptionCoordinator | undefined;

  constructor(private readonly options: PipelineOptions) {
    if (!Number.isInteger(options.segmentMs) || options.segmentMs < 3_000 || options.segmentMs > 12_000) {
      throw new Error('Invalid segment duration');
    }
    this.now = options.now ?? Date.now;
    this.accuracy = options.accuracy ? new AccuracySession({ ...options.accuracy,
      now: this.now, getConversation: () => options.memory?.snapshot() ?? { recent: [], summary: '' },
      onCaption: (caption) => this.deliverCaption(caption), onFatal: (error) => this.handleFailure(error) }) : undefined;
    if (options.streamingCaptions && !options.segmenter) throw new Error('Streaming captions require a segmenter');
    this.streaming = options.streamingCaptions ? new StreamingCaptionCoordinator({
      translator: options.translator, segmenter: options.segmenter!, usage: options.usage,
      ...(options.segmentationRates ? { segmentationRates: options.segmentationRates } : {}),
      ...(options.draftIntervalMs ? { draftIntervalMs: options.draftIntervalMs } : {}),
      ...(options.onTrace ? { onTrace: options.onTrace } : {}),
      allocateSequence: () => ++this.captionSequence, getConversation: () => options.memory?.snapshot() ?? { recent: [], summary: '' },
      now: this.now, onDiagnostic: options.onDiagnostic, onError: (error) => this.handleFailure(error),
      onDraft: (caption) => this.deliverCaption(caption), onStable: (caption) => {
        if (!this.active) return;
        if (this.accuracy) this.accuracy.publish(caption);
        else this.deliverCaption({ ...caption, status: 'final' });
      },
    }) : undefined;
    this.idleSessionMs = options.idleSessionMs ?? 60_000;
    if (!Number.isInteger(this.idleSessionMs) || this.idleSessionMs < 10_000 || this.idleSessionMs > 300_000) {
      throw new Error('Invalid idle timeout');
    }
    const onCaption = (caption: AssembledCaption) => {
        if (!this.active) return;
        const sequence = ++this.captionSequence;
        this.options.onDiagnostic('caption_segment_ready', { sequence, boundary: caption.boundary });
        this.enqueueTranslation({ ...caption, sequence });
    };
    const onSemanticDiagnostic: PipelineOptions['onDiagnostic'] = (event, fields) => {
      if (event === 'interpretation_late_context_limit' && typeof fields?.speakerId === 'string') {
        this.accuracy?.markSpeakerRisk(fields.speakerId);
      }
      options.onDiagnostic(event, fields);
    };
    this.semanticAssembler = this.streaming ? undefined : options.comparisonVariants ? new ModelComparisonAssembler({
      variants: options.comparisonVariants, usage: options.usage,
      silenceMs: options.captionSilenceMs ?? 4_000, maxHoldMs: options.captionMaxHoldMs ?? 8_000,
      now: this.now, onDiagnostic: options.onDiagnostic,
      onError: (error) => this.handleFailure(error, 'interpretation_failed'),
      onCaption: (caption) => {
        if (!this.active) return;
        const { translations, ...source } = caption;
        this.publishCaption({ ...source, sequence: ++this.captionSequence }, translations);
      },
    }) : options.interpreter ? new InterpretedCaptionAssembler({
      interpreter: options.interpreter, usage: options.usage,
      ...(options.memory ? { getConversation: () => options.memory!.snapshot() } : {}),
      silenceMs: options.captionSilenceMs ?? 4_000,
      maxHoldMs: options.captionMaxHoldMs ?? 8_000,
      now: this.now,
      onCaption: (caption) => {
        if (!this.active) return;
        const sequence = ++this.captionSequence;
        this.options.onDiagnostic('caption_segment_ready', { sequence, boundary: caption.boundary });
        // The same API response already contains all four translations. Do not enqueue
        // another translation, reserve it again, or lose the assembler's source mapping.
        const { translations, ...source } = caption;
        this.publishCaption({ ...source, sequence }, translations);
      },
      onDiagnostic: onSemanticDiagnostic,
      onError: (error) => this.handleFailure(error, 'interpretation_failed'),
    }) : options.segmenter ? new SemanticCaptionAssembler({
      segmenter: options.segmenter, usage: options.usage,
      ...(options.segmentationRates ? { segmentationRates: options.segmentationRates } : {}),
      silenceMs: options.captionSilenceMs ?? 4_000,
      maxHoldMs: options.captionMaxHoldMs ?? 8_000,
      now: this.now, onCaption,
      onDiagnostic: onSemanticDiagnostic,
      onError: (error) => this.handleFailure(error, 'segmentation_failed'),
    }) : undefined;
    this.assembler = this.streaming ? undefined : this.semanticAssembler ?? (options.sentenceCaptions === false ? undefined
      : new CaptionAssembler({ holdMs: options.captionHoldMs ?? 12_000, onCaption }));
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    this.cleanupTimer.unref();
  }

  /** Borrows PCM during the call, copies retained bytes, never writes audio to disk. */
  push(speakerId: string, pcm: Buffer): void {
    if (!this.active || !pcm.length || pcm.length % 2) return;
    if ((this.cooldowns.get(speakerId) ?? 0) > this.now()) return;
    try {
      let entry = this.sessions.get(speakerId);
      if (!entry && this.streaming && !new VoiceActivityDetector().speech(pcm)) return;
      if (!entry) {
        if (this.sessions.size >= 3) {
          const idle = [...this.sessions.values()].find((item) => !item.current && !item.pending && !item.heldBytes);
          if (idle) this.closeSession(idle);
        }
        if (!this.active) return;
        if (this.sessions.size >= 3) {
          this.cooldowns.set(speakerId, this.now() + 1000);
          this.options.onDiagnostic('stt_capacity', { speakerId, limit: 3 });
          return;
        }
        entry = this.openSession(speakerId);
      }
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
      if (this.streaming) {
        const voiced = entry.vad.speech(pcm);
        if (voiced) { entry.lastVoiceAt = this.now(); this.scheduleSpeechSilence(entry); }
        else if (!entry.current && (entry.lastVoiceAt === undefined || this.now() - entry.lastVoiceAt >= (this.options.speechSilenceMs ?? 2_000))) return;
      }
      this.semanticAssembler?.activity(speakerId);
      let offset = 0;
      const maximumBytes = this.options.segmentMs * BYTES_PER_MS;
      while (offset < pcm.length && !entry.closed && this.active) {
        const segment = entry.current ?? this.newSegment(entry);
        const bytes = Math.min(pcm.length - offset, maximumBytes - segment.total);
        if (entry.heldBytes + bytes > maximumBytes) {
          this.failSession(entry, new Error('queue full'), 'audio_backpressure');
          return;
        }
        const part = Buffer.from(pcm.subarray(offset, offset + bytes));
        this.accuracy?.audio(segment.id, speakerId, part);
        this.options.onSourceAudio?.(segment.id, speakerId, part);
        segment.parts.push(part);
        segment.buffered += bytes;
        segment.total += bytes;
        entry.heldBytes += bytes;
        offset += bytes;
        if (segment.buffered >= BATCH_BYTES) this.flush(entry, segment);
        if (segment.total === maximumBytes) this.endSegment(entry);
      }
    } catch (error) {
      this.handleFailure(error);
      const entry = this.sessions.get(speakerId);
      if (entry) this.closeSession(entry);
    }
  }

  end(speakerId: string, reason: 'silence' | 'error' | 'left' | 'stop'): void {
    const entry = this.sessions.get(speakerId);
    if (!entry || !this.active) return;
    if (reason !== 'silence') {
      this.closeSession(entry);
      return;
    }
    if (this.streaming) { this.scheduleSpeechSilence(entry); return; }
    this.endSegment(entry);
    this.scheduleIdleClose(entry);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.cleanupTimer);
    this.controller.abort();
    this.assembler?.stop();
    this.streaming?.stop();
    this.accuracy?.stop();
    this.options.memory?.stop();
    this.jobs.length = 0;
    this.captions.length = 0;
    this.history.length = 0;
    this.cooldowns.clear();
    for (const entry of [...this.sessions.values()]) this.closeSession(entry);
  }

  recentCaptions(): Caption[] {
    this.prune();
    return this.captions.slice().sort((a, b) => a.sequence - b.sequence)
      .map((caption) => ({ ...caption, translations: { ...caption.translations },
        ...(caption.sourceSegmentIds ? { sourceSegmentIds: [...caption.sourceSegmentIds] } : {}) }));
  }

  /** Recording replay EOF. Normal live meetings use voice silence instead. */
  finishInput(speakerId: string): void {
    const entry = this.sessions.get(speakerId);
    if (!this.active || !entry) return;
    if (entry.silenceTimer) clearTimeout(entry.silenceTimer);
    entry.silenceTimer = undefined; entry.lastVoiceAt = undefined;
    this.streaming?.silence(speakerId); this.endSegment(entry);
  }

  isSettled(): boolean {
    return !this.active || ([...this.sessions.values()].every((entry) => !entry.current && !entry.pending && !entry.heldBytes)
      && !this.jobs.length && !this.translating && (!this.streaming || this.streaming.isSettled()) && (!this.accuracy || this.accuracy.isSettled()));
  }

  private openSession(id: string): SpeakerSession {
    const entry: SpeakerSession = {
      id, stt: this.options.createTranscriber(), chain: Promise.resolve(), closed: false,
      current: undefined, segments: new Set(), buffers: new Set(), heldBytes: 0,
      pending: 0, idleTimer: undefined,
      turnOrder: [], results: new Map(),
      commitIndex: 0, commits: new Map(),
      vad: new VoiceActivityDetector(), lastVoiceAt: undefined, silenceTimer: undefined,
    };
    this.sessions.set(id, entry);
    entry.stt.setPartialHandler?.((partial) => {
      if (!this.active || entry.closed) return;
      const segment = partial.commitIndex !== undefined ? entry.commits.get(partial.commitIndex)
        : entry.pending === 0 ? entry.current : undefined;
      if (!segment) return;
      segment.partialText = partial.text;
      if (this.streaming) {
        this.streaming.updateSource(segment.id, partial.text, false);
        // Close only the current audio segment. A late partial for a committed segment
        // must never commit the newer audio that is already being captured.
        if (partial.commitIndex === undefined && segment === entry.current && segment.total >= 24_000
          && endsWithSentenceBoundary(partial.text)) {
          this.options.onDiagnostic('stt_early_commit', { sequence: segment.sequence });
          this.endSegment(entry);
        }
        return;
      }
      // Commit a meaningful-looking live phrase early; the interpreter still decides
      // whether its meaning is complete. Never translate a raw delta as settled speech.
      if (partial.commitIndex === undefined && segment === entry.current && segment.total >= 24_000
        && partial.text.trim().length >= 8 && /[.!?。！？][”"']?\s*$/u.test(partial.text)) {
        this.options.onDiagnostic('stt_early_commit', { sequence: segment.sequence });
        this.endSegment(entry);
      }
    });
    entry.chain = entry.stt.connect().catch((error: unknown) => this.failSession(entry, error));
    return entry;
  }

  private newSegment(entry: SpeakerSession): Segment {
    const reservation = this.options.usage.reserve({ audioMs: this.options.segmentMs });
    const sequence = ++this.sequence;
    const segment: Segment = {
      id: `${this.meetingId}_${sequence}`, sequence, speakerId: entry.id,
      speakerName: this.options.speakerName(entry.id).slice(0, 80),
      parts: [], buffered: 0, total: 0, sent: 0, reservation, settled: false,
      timer: setTimeout(() => {
        if (entry.current === segment && !entry.closed) this.endSegment(entry);
      }, this.options.segmentMs),
    };
    segment.timer.unref();
    entry.current = segment;
    entry.segments.add(segment);
    this.streaming?.startSource(segment.id, entry.id, segment.speakerName);
    return segment;
  }

  private flush(entry: SpeakerSession, segment: Segment): void {
    if (!segment.buffered) return;
    const frame = Buffer.concat(segment.parts, segment.buffered);
    for (const part of segment.parts) part.fill(0);
    segment.parts = [];
    segment.buffered = 0;
    entry.buffers.add(frame);
    entry.chain = entry.chain.then(() => {
      if (!this.active || entry.closed) return;
      // Count conservatively even if the transport throws after sending.
      segment.sent += frame.length;
      entry.stt.append(frame);
    }).catch((error: unknown) => this.failSession(entry, error)).finally(() => {
      frame.fill(0);
      if (entry.buffers.delete(frame)) entry.heldBytes -= frame.length;
    });
  }

  private endSegment(entry: SpeakerSession): void {
    const segment = entry.current;
    if (!segment || entry.closed || !this.active) return;
    entry.current = undefined;
    clearTimeout(segment.timer);
    if (segment.total < BATCH_BYTES) {
      for (const part of segment.parts) part.fill(0);
      entry.heldBytes -= segment.buffered;
      segment.parts = [];
      segment.buffered = 0;
      this.settleAudio(segment);
      entry.segments.delete(segment);
      this.options.onDiagnostic('segment_too_short', { speakerId: entry.id });
      this.streaming?.updateSource(segment.id, '', true);
      return;
    }
    if (entry.pending >= 4) {
      this.failSession(entry, new Error('pending overflow'), 'stt_backpressure');
      return;
    }
    this.flush(entry, segment);
    entry.pending += 1;
    entry.turnOrder.push(segment.sequence);
    entry.chain = entry.chain.then(() => {
      if (!this.active || entry.closed) return;
      this.settleAudio(segment);
      if (!this.active || entry.closed) return;
      entry.segments.delete(segment);
      const committedAt = this.now();
      const commitIndex = ++entry.commitIndex;
      entry.commits.set(commitIndex, segment);
      // Do not wait for the final text here: later audio must keep streaming.
      void entry.stt.commit().then((text) => {
        if (!this.active || entry.closed) return;
        const originalText = text.trim();
        this.options.onSourceTranscript?.(segment.id, segment.speakerId, originalText);
        const normalize = (value: string) => value.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
        const conflict = !!segment.partialText && !normalize(originalText).startsWith(normalize(segment.partialText));
        this.accuracy?.transcript(segment.id, segment.speakerId, originalText, conflict);
        if (conflict) this.options.onDiagnostic('transcript_revision_conflict', { sequence: segment.sequence });
        if (!originalText) {
          this.options.onDiagnostic('transcript_empty', { sequence: segment.sequence });
          // A silent tail is not a failed/missing transcript. In particular, it must
          // not cancel semantic analysis of the preceding recognized sentence.
          this.completeTurn(entry, segment.sequence, 'empty');
          return;
        }
        if (originalText.length > 8000) {
          this.streaming?.updateSource(segment.id, '', true, true);
          this.options.onDiagnostic('transcript_too_long', { sequence: segment.sequence });
          this.completeTurn(entry, segment.sequence, null);
          return;
        }
        this.options.onDiagnostic('transcription_ready', { sequence: segment.sequence, latencyMs: this.now() - committedAt });
        this.completeTurn(entry, segment.sequence, { segmentId: segment.id, sequence: segment.sequence,
          speakerId: segment.speakerId, speakerName: segment.speakerName, text: originalText });
      }).catch((error: unknown) => {
        this.streaming?.updateSource(segment.id, segment.partialText ?? '', true, true);
        if (error instanceof SttError && error.code === 'stt_transcription_failed') {
          this.handleFailure(error);
          this.completeTurn(entry, segment.sequence, null);
        }
        else this.failSession(entry, error);
      }).finally(() => {
        entry.commits.delete(commitIndex);
        entry.pending -= 1;
        this.scheduleIdleClose(entry);
      });
    }).catch((error: unknown) => this.failSession(entry, error));
  }

  private settleAudio(segment: Segment): void {
    if (segment.settled) return;
    try {
      segment.reservation.settle({ audioMs: segment.sent / BYTES_PER_MS });
      segment.settled = true;
    } catch (error) {
      this.handleFailure(error instanceof RangeError ? new UsageStorageError('invalid_data') : error);
    }
  }

  private scheduleIdleClose(entry: SpeakerSession): void {
    if (entry.closed || entry.current || entry.pending || entry.heldBytes || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (!entry.current && !entry.pending && !entry.heldBytes) this.closeSession(entry);
    }, this.idleSessionMs);
    entry.idleTimer.unref();
  }

  private scheduleSpeechSilence(entry: SpeakerSession): void {
    if (!this.streaming || !this.active || entry.closed || entry.silenceTimer || entry.lastVoiceAt === undefined) return;
    entry.silenceTimer = setTimeout(() => {
      entry.silenceTimer = undefined;
      if (!this.active || entry.closed || entry.lastVoiceAt === undefined) return;
      if (this.now() - entry.lastVoiceAt < (this.options.speechSilenceMs ?? 2_000)) { this.scheduleSpeechSilence(entry); return; }
      this.options.onDiagnostic('speech_silence', { speakerId: entry.id, silenceMs: this.now() - entry.lastVoiceAt });
      this.streaming?.silence(entry.id);
      this.endSegment(entry); this.scheduleIdleClose(entry);
      entry.lastVoiceAt = undefined;
    }, Math.max(1, entry.lastVoiceAt + (this.options.speechSilenceMs ?? 2_000) - this.now()));
    entry.silenceTimer.unref();
  }

  private closeSession(entry: SpeakerSession): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.silenceTimer) clearTimeout(entry.silenceTimer);
    for (const segment of entry.segments) {
      clearTimeout(segment.timer);
      for (const part of segment.parts) part.fill(0);
      segment.parts = [];
      this.settleAudio(segment);
    }
    for (const buffer of entry.buffers) buffer.fill(0);
    entry.buffers.clear();
    entry.segments.clear();
    entry.current = undefined;
    entry.heldBytes = 0;
    entry.turnOrder.length = 0;
    entry.results.clear();
    entry.commits.clear();
    if (this.sessions.get(entry.id) === entry) this.sessions.delete(entry.id);
    entry.stt.close();
    // A transport gap cannot be silently joined to speech from a new session.
    if (this.active) this.assembler?.gap(entry.id);
    if (this.active) this.streaming?.gap(entry.id);
  }

  private completeTurn(entry: SpeakerSession, sequence: number, result: TranscriptPiece | null | 'empty'): void {
    if (!this.active || entry.closed) return;
    entry.results.set(sequence, result);
    // A later STT completion must never overtake an earlier phrase of the same speaker.
    while (entry.turnOrder.length && entry.results.has(entry.turnOrder[0]!)) {
      const next = entry.turnOrder.shift()!;
      const piece = entry.results.get(next)!;
      entry.results.delete(next);
      if (this.streaming) {
        if (piece && piece !== 'empty') this.streaming.updateSource(piece.segmentId, piece.text, true);
        else this.streaming.updateSource(`${this.meetingId}_${next}`, '', true, piece !== 'empty');
        continue;
      }
      if (piece === 'empty') continue;
      if (!piece) {
        this.assembler?.gap(entry.id);
      } else if (this.assembler) {
        this.assembler.accept(piece);
      } else {
        this.enqueueTranslation({ segmentId: piece.segmentId, sequence: piece.sequence,
          speakerId: piece.speakerId, speakerName: piece.speakerName, originalText: piece.text });
      }
    }
  }

  private failSession(entry: SpeakerSession, error: unknown, fallback = 'stt_failed'): void {
    if (entry.closed || !this.active) return;
    // Fatal failures stop first: flushing a pending caption must not start paid work.
    this.handleFailure(error, fallback);
    if (!this.active) return;
    this.closeSession(entry);
    this.cooldowns.set(entry.id, this.now() + 3000);
  }

  private handleFailure(error: unknown, fallback = 'pipeline_failed'): void {
    if (!this.active) return;
    const code = error instanceof UsageLimitError ? 'api_budget_limit'
      : error instanceof UsageStorageError ? 'usage_storage_error'
      : error instanceof SttError || error instanceof TranslationError || error instanceof SegmentationError
        || error instanceof InterpretationError || error instanceof InterpretationFlowError || error instanceof StreamingCaptionError ? error.code : fallback;
    this.options.onDiagnostic('pipeline_error', { code });
    if (['api_budget_limit', 'usage_storage_error', 'stt_auth', 'stt_model', 'stt_language_hint',
      'authentication', 'model_access', 'segmentation_auth', 'segmentation_model',
      'translation_backpressure', 'interpretation_auth', 'interpretation_model',
      'interpretation_backpressure', 'interpretation_failed', 'streaming_backpressure', 'streaming_translation_failed'].includes(code)) {
      this.stop();
      this.options.onFatal?.(code);
    }
  }

  private enqueueTranslation(job: TranslationJob): void {
    if (!this.active) return;
    const queuedChars = this.jobs.reduce((total, queued) => total + queued.originalText.length, 0);
    if (this.jobs.length >= COALESCE_AFTER_JOBS) {
      // Only merge into this speaker's last queued job, preserving their full order.
      // A valid semantic response can contain many sentences; none may be discarded.
      const last = this.jobs.findLast((queued) => queued.speakerId === job.speakerId);
      if (last && last.originalText.length + 1 + job.originalText.length <= MAX_TRANSLATION_TEXT_CHARS
        && queuedChars + 1 + job.originalText.length <= MAX_TRANSLATION_QUEUE_CHARS) {
        last.originalText += ` ${job.originalText}`;
        last.sourceSegmentIds = [...new Set([
          ...(last.sourceSegmentIds ?? [last.segmentId]), ...(job.sourceSegmentIds ?? [job.segmentId]),
        ])];
        last.boundary = 'limit';
        this.options.onDiagnostic('translation_coalesced', { sequence: job.sequence, intoSequence: last.sequence });
        return;
      }
    }
    if (this.jobs.length >= MAX_TRANSLATION_JOBS
      || queuedChars + job.originalText.length > MAX_TRANSLATION_QUEUE_CHARS) {
      this.options.onDiagnostic('translation_backpressure', { sequence: job.sequence });
      this.handleFailure(new Error('Translation queue capacity reached'), 'translation_backpressure');
      return;
    }
    this.jobs.push(job);
    this.pumpTranslations();
  }

  private pumpTranslations(): void {
    while (this.active && this.translating < 3 && this.jobs.length) {
      const next = this.jobs.findIndex((job) => !this.translatingSpeakers.has(job.speakerId));
      if (next === -1) return;
      const job = this.jobs.splice(next, 1)[0]!;
      this.translating += 1;
      this.translatingSpeakers.add(job.speakerId);
      void this.translate(job).finally(() => {
        this.translating -= 1;
        this.translatingSpeakers.delete(job.speakerId);
        this.pumpTranslations();
      });
    }
  }

  private async translate(job: TranslationJob): Promise<void> {
    try {
      const startedAt = this.now();
      this.prune();
      const context = this.history.filter((item) => item.speakerId === job.speakerId && item.sequence < job.sequence)
        .sort((a, b) => a.sequence - b.sequence).slice(-2).map((item) => item.text);
      this.history.push({ sequence: job.sequence, speakerId: job.speakerId,
        text: job.originalText.slice(-1000), at: this.now() });
      const input = { originalText: job.originalText, context, signal: this.controller.signal,
        ...(this.options.memory ? { conversation: this.options.memory.snapshot() } : {}) };
      const reservation = this.options.usage.reserve(this.options.translator.estimateUsage(input));
      const result = await this.options.translator.translate(input);
      if (!this.active) return; // Stop must never allow a late caption into a new meeting.
      try { reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }); }
      catch (error) { throw error instanceof RangeError ? new UsageStorageError('invalid_data') : error; }
      this.options.onDiagnostic('translation_ready', { sequence: job.sequence,
        speakerId: job.speakerId, latencyMs: this.now() - startedAt });
      this.publishCaption(job, result.translations);
    } catch (error) {
      // Unknown billing on failed/aborted API calls keeps the durable reservation.
      this.handleFailure(error, 'translation_failed');
    }
  }

  private publishCaption(job: TranslationJob, translations: Translations): void {
    if (!this.active) return;
    const caption: Caption = { type: 'caption', ...job, translations: { ...translations }, createdAt: this.now() };
    this.options.onDiagnostic('caption_ready', { sequence: job.sequence, speakerId: job.speakerId,
      mode: this.options.comparisonVariants ? 'compare' : this.options.interpreter ? 'combined' : 'separate',
      ...(job.comparison ? { variantId: job.comparison.variantId } : {}),
      estimatedUsd: this.options.usage.snapshot().estimatedUsd });
    if (this.accuracy && !job.comparison) this.accuracy.publish(caption);
    else this.deliverCaption({ ...caption, status: 'final', revision: 0 });
  }

  private deliverCaption(caption: Caption): void {
    if (!this.active) return;
    const previous = this.captions.findIndex((item) => item.sequence === caption.sequence);
    if (previous >= 0) this.captions[previous] = caption;
    else this.captions.push(caption);
    this.prune();
    if (caption.status === 'final' && !caption.comparison) {
      this.options.memory?.finalize({ id: `${caption.segmentId}:${caption.sequence}`, speakerId: caption.speakerId,
        speakerName: caption.speakerName, sequence: caption.sequence,
        text: (caption.accuracy?.state === 'uncertain' ? '[Uncertain source transcript] ' : '') + caption.originalText });
    }
    this.options.onCaption({ ...caption, translations: { ...caption.translations },
      ...(caption.sourceSegmentIds ? { sourceSegmentIds: [...caption.sourceSegmentIds] } : {}) });
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (let i = this.captions.length - 1; i >= 0; i -= 1) {
      if (this.captions[i]!.createdAt <= cutoff) this.captions.splice(i, 1);
    }
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i]!.at <= cutoff) this.history.splice(i, 1);
    }
    if (this.captions.length > 3000) this.captions.splice(0, this.captions.length - 3000);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    for (const [id, until] of this.cooldowns) if (until <= this.now()) this.cooldowns.delete(id);
  }
}
