import type { CaptionBoundary } from './types.js';

export interface TranscriptPiece {
  segmentId: string;
  sequence: number;
  speakerId: string;
  speakerName: string;
  text: string;
}

export interface AssembledCaption {
  segmentId: string;
  speakerId: string;
  speakerName: string;
  originalText: string;
  sourceSegmentIds: string[];
  boundary: CaptionBoundary;
}

interface Span {
  text: string;
  sourceId: string;
  speakerName: string;
  receivedAt: number;
}

interface PendingSpeaker {
  speakerId: string;
  spans: Span[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.',
  'e.g.', 'i.e.', 'a.m.', 'p.m.', 'inc.', 'ltd.', 'no.',
  'г.', 'ул.', 'им.', 'т.е.', 'т.д.', 'т.п.', 'т.н.', 'т.к.', 'см.',
]);
const CLOSING_PUNCTUATION = /["'’”»›」』）)\]}]/u;
const TERMINAL = /[.?!。！？]/u;

/** A punctuation heuristic, not a semantic rewrite or a paragraph detector. */
function sentenceEnd(text: string): number | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (!TERMINAL.test(character)) continue;
    if (character === '.') {
      const previous = text[index - 1] ?? '';
      const next = text[index + 1] ?? '';
      if (/\d/u.test(previous) && /\d/u.test(next)) continue;
      // Dotted abbreviations, URLs and initials cannot safely end at their interior dots.
      if (/\p{L}/u.test(previous) && /[\p{L}\d]/u.test(next)) continue;
      const token = text.slice(0, index + 1).match(/[\p{L}.]+$/u)?.[0] ?? '';
      if (ABBREVIATIONS.has(token.toLocaleLowerCase())) continue;
      if (/^\p{Lu}\.$/u.test(token)) continue;
      if (/^(?:\p{L}\.){2,}$/u.test(token)) continue;
    }
    let end = index + 1;
    while (end < text.length && TERMINAL.test(text[end]!)) end += 1;
    while (end < text.length && CLOSING_PUNCTUATION.test(text[end]!)) end += 1;
    return end;
  }
  return undefined;
}

export class CaptionAssembler {
  private readonly pending = new Map<string, PendingSpeaker>();
  private readonly holdMs: number;
  private readonly maxChars: number;
  private readonly onCaption: (caption: AssembledCaption) => void;
  private stopped = false;
  private captionSequence = 0;

  constructor(options: {
    holdMs: number;
    onCaption: (caption: AssembledCaption) => void;
    maxChars?: number;
  }) {
    this.holdMs = options.holdMs;
    this.maxChars = options.maxChars ?? 4_000;
    if (!Number.isSafeInteger(this.holdMs) || this.holdMs <= 0 || this.holdMs > 2_147_483_647) {
      throw new RangeError('holdMs must be a positive timer duration');
    }
    if (!Number.isSafeInteger(this.maxChars) || this.maxChars < 2) {
      throw new RangeError('maxChars must be an integer of at least 2');
    }
    this.onCaption = options.onCaption;
  }

  accept(piece: TranscriptPiece): void {
    if (this.stopped) return;
    const text = piece.text.trim();
    if (!text) return;
    let speaker = this.pending.get(piece.speakerId);
    if (!speaker) {
      if (this.pending.size >= 64) {
        const oldest = [...this.pending.values()].reduce((left, right) =>
          left.spans[0]!.receivedAt <= right.spans[0]!.receivedAt ? left : right);
        this.emit(oldest, this.content(oldest).length, 'limit');
        if (this.stopped) return;
      }
      speaker = { speakerId: piece.speakerId, spans: [], timer: undefined };
      this.pending.set(piece.speakerId, speaker);
    }
    speaker.spans.push({
      text: (speaker.spans.length ? ' ' : '') + text,
      sourceId: piece.segmentId,
      speakerName: piece.speakerName,
      receivedAt: Date.now(),
    });
    while (!this.stopped && speaker.spans.length) {
      const content = this.content(speaker);
      const end = sentenceEnd(content);
      if (end !== undefined && end <= this.maxChars) {
        this.emit(speaker, end, 'sentence');
      } else if (content.length >= this.maxChars) {
        let count = this.maxChars;
        // Keep a surrogate pair intact without exceeding the configured cap.
        if (/[\uD800-\uDBFF]/u.test(content[count - 1]!) && /[\uDC00-\uDFFF]/u.test(content[count] ?? '')) count -= 1;
        this.emit(speaker, count, 'limit');
      } else break;
    }
    if (!this.stopped && speaker.spans.length) this.schedule(speaker);
  }

  gap(speakerId: string): void {
    if (this.stopped) return;
    const speaker = this.pending.get(speakerId);
    if (speaker) this.emit(speaker, this.content(speaker).length, 'gap');
  }

  stop(): void {
    this.stopped = true;
    for (const speaker of this.pending.values()) this.clearTimer(speaker);
    this.pending.clear();
  }

  private content(speaker: PendingSpeaker): string {
    return speaker.spans.map((span) => span.text).join('');
  }

  private clearTimer(speaker: PendingSpeaker): void {
    if (speaker.timer !== undefined) clearTimeout(speaker.timer);
    speaker.timer = undefined;
  }

  private schedule(speaker: PendingSpeaker): void {
    this.clearTimer(speaker);
    const remainingMs = Math.max(0, speaker.spans[0]!.receivedAt + this.holdMs - Date.now());
    speaker.timer = setTimeout(() => {
      speaker.timer = undefined;
      if (!this.stopped && this.pending.get(speaker.speakerId) === speaker) {
        this.emit(speaker, this.content(speaker).length, 'timeout');
      }
    }, remainingMs);
    speaker.timer.unref();
  }

  private emit(speaker: PendingSpeaker, count: number, boundary: AssembledCaption['boundary']): void {
    this.clearTimer(speaker);
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
    while (speaker.spans.length) {
      const first = speaker.spans[0]!;
      first.text = first.text.trimStart();
      if (first.text) break;
      speaker.spans.shift();
    }
    if (!speaker.spans.length) this.pending.delete(speaker.speakerId);
    originalText = originalText.trim();
    if (originalText && !this.stopped) {
      this.captionSequence += 1;
      this.onCaption({
        segmentId: `${sourceSegmentIds[0]}:caption:${this.captionSequence}`,
        speakerId: speaker.speakerId,
        speakerName,
        originalText,
        sourceSegmentIds,
        boundary,
      });
    }
  }
}
