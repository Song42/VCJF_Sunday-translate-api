import { closeSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caption } from './types.js';
import { LocalAudioRecorder, RecordingError, recordingWavHeader, writeRecordingBytes } from './recording.js';

interface Cursor { chars: number; bytes: number }
interface Source {
  id: string; speakerId: string; path: string; fd?: number; bytes: number; startedAt: number;
  text: string; sealed: boolean; removed: boolean; cursors: Map<string, Cursor>;
}
interface Slice { source: Source; start: number; end: number; chars: number; estimated: boolean }
export interface CaptionRecording {
  path: string;
  metadataPath: string;
  alignment: 'stt-boundary' | 'estimated';
}
const compact = (text: string) => text.replace(/\s/gu, '');

/** One WAV per translated unit. Audio offsets come from source PCM, never API response arrival. */
export class CaptionAudioRecorder {
  readonly directory: string;
  private readonly rawDirectory: string;
  private readonly sources = new Map<string, Source>();
  private readonly saved = new Map<string, CaptionRecording>();
  private readonly variants: readonly string[];
  private readonly now: () => number;
  private stopped = false;
  private files = 0;
  private audioMs = 0;

  constructor(private readonly options: {
    directory?: string; now?: () => number; date?: () => Date; variants?: readonly string[];
    onDiagnostic: (event: string, fields: Record<string, string | number | boolean>) => void;
  }) {
    this.now = options.now ?? Date.now;
    this.variants = options.variants ?? ['default'];
    if (!this.variants.length || this.variants.some((id) => !/^[a-z0-9-]{1,40}$/.test(id))) throw new RecordingError();
    const session = new LocalAudioRecorder(options);
    this.directory = session.directory;
    session.stop();
    this.rawDirectory = join(this.directory, '_pending');
    try { mkdirSync(this.rawDirectory); } catch { throw new RecordingError(); }
  }

  audio(id: string, speakerId: string, pcm: Buffer): void {
    if (this.stopped || !pcm.length) return;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !/^\d{17,20}$/.test(speakerId) || pcm.length % 2) throw new RecordingError();
    try {
      let source = this.sources.get(id);
      if (!source) {
        if (this.sources.size >= 100_000) throw new RecordingError();
        const path = join(this.rawDirectory, `${id}.pcm`);
        source = { id, speakerId, path, fd: openSync(path, 'wx', 0o600), bytes: 0,
          startedAt: this.now(), text: '', sealed: false, removed: false, cursors: new Map() };
        this.sources.set(id, source);
      }
      if (source.sealed || source.fd === undefined || source.speakerId !== speakerId) throw new RecordingError();
      writeRecordingBytes(source.fd, pcm, 0, pcm.length, source.bytes);
      source.bytes += pcm.length;
    } catch { throw new RecordingError(); }
  }

  transcript(id: string, speakerId: string, text: string): void {
    if (this.stopped) return;
    const source = this.sources.get(id);
    if (!source) return; // The configured recording scope may exclude this speaker.
    if (source.speakerId !== speakerId || source.sealed) throw new RecordingError();
    source.text = compact(text); source.sealed = true;
    if (source.fd !== undefined) { closeSync(source.fd); delete source.fd; }
  }

  caption(caption: Caption): CaptionRecording | undefined {
    if (this.stopped) return;
    const variant = caption.comparison?.variantId ?? 'default';
    const key = `${variant}:${caption.sequence}`;
    const previous = this.saved.get(key);
    if (previous) {
      this.metadata(previous, caption); // Accuracy finalization updates metadata, not the WAV boundary.
      return previous;
    }
    if (!this.variants.includes(variant)) throw new RecordingError();
    const ids = caption.sourceSegmentIds ?? [caption.segmentId];
    const sources = ids.map((id) => this.sources.get(id));
    if (!sources.some(Boolean)) return;
    if (sources.some((source) => !source || source.removed || !source.sealed || source.speakerId !== caption.speakerId)) throw new RecordingError();
    let remaining = compact(caption.originalText);
    const slices: Slice[] = [];
    try {
      for (const source of sources as Source[]) {
        const cursor = source.cursors.get(variant) ?? { chars: 0, bytes: 0 };
        const tail = source.text.slice(cursor.chars);
        const count = Math.min(remaining.length, tail.length);
        if (!count) continue;
        if (remaining.slice(0, count) !== tail.slice(0, count)) throw new RecordingError();
        const chars = cursor.chars + count;
        let end = source.bytes;
        if (chars < source.text.length) {
          const estimated = Math.round(source.bytes / 2 * chars / source.text.length) * 2;
          end = this.quietBoundary(source, estimated, cursor.bytes);
        }
        if (end <= cursor.bytes) throw new RecordingError();
        slices.push({ source, start: cursor.bytes, end, chars,
          estimated: cursor.chars > 0 || chars < source.text.length });
        remaining = remaining.slice(count);
      }
      if (remaining || !slices.length) throw new RecordingError();
      const prefix = `${caption.speakerId}_${variant === 'default' ? '' : `${variant}_`}caption_${String(caption.sequence).padStart(6, '0')}`;
      const recording: CaptionRecording = { path: join(this.directory, `${prefix}.wav`),
        metadataPath: join(this.directory, `${prefix}.json`),
        alignment: slices.some((slice) => slice.estimated) ? 'estimated' : 'stt-boundary' };
      const audio = this.writeClip(recording.path, slices);
      this.metadata(recording, caption, { audioMs: audio / 48,
        sources: slices.map((slice) => ({ segmentId: slice.source.id, startMs: slice.start / 48, endMs: slice.end / 48 })) });
      for (const slice of slices) slice.source.cursors.set(variant, { chars: slice.chars, bytes: slice.end });
      this.saved.set(key, recording); this.files++; this.audioMs += audio / 48;
      for (const slice of slices) this.releaseIfConsumed(slice.source);
      this.options.onDiagnostic('recording_caption_saved', { sequence: caption.sequence, speakerId: caption.speakerId,
        path: recording.path, metadataPath: recording.metadataPath, alignment: recording.alignment, audioMs: audio / 48 });
      return recording;
    } catch { throw new RecordingError(); }
  }

  stop(): { files: number; audioMs: number } {
    if (!this.stopped) {
      this.stopped = true;
      let failed = false;
      for (const source of this.sources.values()) {
        try {
          if (source.fd !== undefined) { closeSync(source.fd); delete source.fd; }
          if (source.removed) continue;
          const consumed = Math.max(0, ...[...source.cursors.values()].map((cursor) => cursor.bytes));
          if (consumed < source.bytes) {
            const path = join(this.directory, `${source.speakerId}_untranslated_${source.id}.wav`);
            const bytes = this.writeClip(path, [{ source, start: consumed, end: source.bytes, chars: 0, estimated: false }]);
            this.files++; this.audioMs += bytes / 48;
            this.options.onDiagnostic('recording_untranslated_saved', { speakerId: source.speakerId, path, audioMs: bytes / 48 });
          }
          this.removeSource(source);
        } catch { failed = true; }
      }
      try { rmdirSync(this.rawDirectory); } catch { failed = true; }
      if (failed) throw new RecordingError();
    }
    return { files: this.files, audioMs: this.audioMs };
  }

  private quietBoundary(source: Source, center: number, start: number): number {
    const minimum = start + 2, maximum = source.bytes - 2;
    center = Math.min(maximum, Math.max(minimum, center));
    const left = Math.max(minimum, center - 9_600), right = Math.min(maximum, center + 9_600);
    const fd = openSync(source.path, 'r');
    const window = Buffer.alloc(480); // 10 ms. Only snap to a nearby genuinely quiet interval.
    let best = center, distance = Infinity;
    try {
      for (let position = left; position + window.length <= right; position += 240) {
        if (readSync(fd, window, 0, window.length, position) !== window.length) throw new RecordingError();
        let energy = 0;
        for (let offset = 0; offset < window.length; offset += 2) energy += Math.abs(window.readInt16LE(offset));
        const boundary = position + window.length / 2;
        if (energy / 240 < 120 && Math.abs(boundary - center) < distance) { best = boundary; distance = Math.abs(boundary - center); }
      }
    } finally { closeSync(fd); }
    return best - best % 2;
  }

  private writeClip(path: string, slices: readonly Slice[]): number {
    const gaps: number[] = [];
    let bytes = 0, previousEnd: number | undefined;
    for (const slice of slices) {
      const start = slice.source.startedAt + slice.start / 48;
      const gap = previousEnd === undefined || start - previousEnd < 50 ? 0 : Math.round((start - previousEnd) * 24) * 2;
      gaps.push(gap); bytes += gap + slice.end - slice.start;
      previousEnd = slice.source.startedAt + slice.end / 48;
    }
    const total = Math.max(4_800, bytes);
    const fd = openSync(path, 'wx', 0o600);
    const buffer = Buffer.alloc(48_000);
    let position = 44;
    try {
      writeRecordingBytes(fd, recordingWavHeader(total), 0, 44, 0);
      for (let index = 0; index < slices.length; index++) {
        const slice = slices[index]!;
        let gap = gaps[index]!;
        buffer.fill(0);
        while (gap) { const count = Math.min(gap, buffer.length); writeRecordingBytes(fd, buffer, 0, count, position); gap -= count; position += count; }
        const input = openSync(slice.source.path, 'r');
        try {
          for (let offset = slice.start; offset < slice.end;) {
            const count = Math.min(buffer.length, slice.end - offset);
            if (readSync(input, buffer, 0, count, offset) !== count) throw new RecordingError();
            writeRecordingBytes(fd, buffer, 0, count, position); position += count; offset += count;
          }
        } finally { closeSync(input); }
      }
      buffer.fill(0);
      if (position < 44 + total) writeRecordingBytes(fd, buffer, 0, 44 + total - position, position);
      fsyncSync(fd);
    } finally { buffer.fill(0); closeSync(fd); }
    return total;
  }

  private metadata(recording: CaptionRecording, caption: Caption, audio?: unknown): void {
    const temporary = `${recording.metadataPath}.tmp`;
    try {
      // Final revisions preserve the initial audio evidence without touching its WAV.
      const existing = this.saved.get(`${caption.comparison?.variantId ?? 'default'}:${caption.sequence}`);
      const detail = audio ?? (existing ? this.audioMetadata.get(recording.metadataPath) : undefined);
      if (audio) this.audioMetadata.set(recording.metadataPath, audio);
      writeFileSync(temporary, JSON.stringify({ ...caption, recording, audio: detail }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, recording.metadataPath);
    } catch { throw new RecordingError(); }
  }
  private readonly audioMetadata = new Map<string, unknown>();

  private releaseIfConsumed(source: Source): void {
    if (this.variants.every((variant) => (source.cursors.get(variant)?.chars ?? 0) >= source.text.length)) this.removeSource(source);
  }
  private removeSource(source: Source): void {
    if (source.removed) return;
    if (source.fd !== undefined) { closeSync(source.fd); delete source.fd; }
    unlinkSync(source.path); source.removed = true;
  }
}
