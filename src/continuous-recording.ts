import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caption } from './types.js';
import { LocalAudioRecorder, RecordingError } from './recording.js';

interface Span { path: string; startMs: number; endMs: number }
/** Lossless per-speaker source WAV plus caption revision metadata; never guesses word times. */
export class ContinuousCaptionRecorder {
  readonly directory: string;
  private readonly raw: LocalAudioRecorder;
  private readonly packets = new Map<string, { start: number; consumed: number }>();
  private readonly sourceRanges = new Map<string, Span[]>();
  private readonly captions = new Map<number, Caption>();
  private stopped = false;
  constructor(private readonly options: {
    directory?: string; now?: () => number; date?: () => Date;
    onDiagnostic: (event: string, fields: Record<string, string | number | boolean>) => void;
  }) {
    this.raw = new LocalAudioRecorder({ ...options, continuous: true });
    this.directory = this.raw.directory;
  }
  append(speakerId: string, pcm: Buffer): void {
    if (this.stopped) return;
    this.raw.append(speakerId, pcm);
    this.packets.set(speakerId, { start: this.raw.recordedMs(speakerId) - pcm.length / 48, consumed: 0 });
  }
  sourceAudio(id: string, speakerId: string, pcm: Buffer): void {
    if (this.stopped) return;
    const packet = this.packets.get(speakerId);
    if (!packet) return;
    const start = packet.start + packet.consumed / 48;
    const ranges = this.raw.ranges(speakerId, start, start + pcm.length / 48);
    packet.consumed += pcm.length;
    const previous = this.sourceRanges.get(id) ?? [];
    for (const range of ranges) {
      const last = previous.at(-1);
      if (last?.path === range.path && Math.abs(last.endMs - range.startMs) < 0.01) last.endMs = range.endMs;
      else previous.push(range);
    }
    this.sourceRanges.set(id, previous);
  }
  end(speakerId: string): void { this.raw.end(speakerId); }
  caption(caption: Caption): Caption['recording'] {
    if (this.stopped) return;
    const ranges = (caption.sourceSegmentIds ?? [caption.segmentId]).flatMap((id) => this.sourceRanges.get(id) ?? []);
    if (!ranges.length) return;
    const metadataPath = join(this.directory, `${caption.speakerId}_caption_${String(caption.sequence).padStart(6, '0')}.json`);
    const recording: NonNullable<Caption['recording']> = { path: ranges[0]!.path, metadataPath,
      alignment: 'source-turn', audioSpans: ranges.map((span) => ({ ...span })) };
    const snapshot: Caption = { ...caption, translations: { ...caption.translations }, recording };
    this.write(snapshot);
    this.captions.set(caption.sequence, snapshot);
    return recording;
  }
  stop(): { files: number; audioMs: number } {
    if (this.stopped) return this.raw.stop();
    this.stopped = true;
    const summary = this.raw.stop();
    for (const caption of this.captions.values()) if (caption.status !== 'final') this.write(caption, true);
    this.packets.clear(); this.sourceRanges.clear(); this.captions.clear();
    return summary;
  }
  private write(caption: Caption, interrupted = false): void {
    const path = caption.recording!.metadataPath, temporary = `${path}.tmp`;
    try {
      const record = { ...caption, interrupted,
        audioNote: 'Audio spans cover STT source turns, not exact word or sentence timings. Source audio is continuous.' };
      writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
      appendFileSync(path.replace(/\.json$/u, '.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { throw new RecordingError(); }
  }
}
