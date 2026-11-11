import { closeSync, ftruncateSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BYTES_PER_MS = 48; // 24 kHz, mono, signed PCM16 little-endian.
interface Part { fd: number; path: string; bytes: number; checkpoint: number }
interface Track { id: string; startedAt: number; bytes: number; inUtterance: boolean; index: number; part?: Part }

export class RecordingError extends Error {
  constructor() {
    super('로컬 음성 저장에 실패했습니다. recordings 폴더 권한과 디스크 공간을 확인하세요.');
    this.name = 'RecordingError';
  }
}

function header(bytes: number): Buffer {
  const out = Buffer.alloc(44);
  out.write('RIFF', 0); out.writeUInt32LE(bytes + 36, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24); out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(bytes, 40);
  return out;
}
function writeAll(fd: number, data: Buffer, offset: number, count: number, position: number): void {
  while (count) {
    const written = writeSync(fd, data, offset, count, position);
    if (!written) throw new RecordingError();
    offset += written; count -= written; position += written;
  }
}

export { header as recordingWavHeader, writeAll as writeRecordingBytes };

/** Records only already-authorized Discord PCM. Each speaker has an independent timeline. */
export class LocalAudioRecorder {
  readonly directory: string;
  private readonly tracks = new Map<string, Track>();
  private readonly now: () => number;
  private readonly partBytes: number;
  private stopped = false;
  private files = 0;

  constructor(private readonly options: {
    directory?: string;
    now?: () => number;
    date?: () => Date;
    partMs?: number;
    continuous?: boolean;
    onDiagnostic: (event: string, fields: Record<string, string | number | boolean>) => void;
  }) {
    this.now = options.now ?? Date.now;
    const partMs = options.partMs ?? 120_000;
    if (!Number.isSafeInteger(partMs) || partMs < 100 || partMs > 120_000) throw new RecordingError();
    this.partBytes = options.continuous ? Math.floor((0xffffffff - 44) / 2) * 2 : partMs * BYTES_PER_MS;
    try {
      const root = resolve(options.directory ?? 'recordings');
      mkdirSync(root, { recursive: true });
      const date = (options.date ?? (() => new Date()))();
      const pad = (n: number, width = 2) => String(n).padStart(width, '0');
      const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
        + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
      let directory: string | undefined;
      for (let suffix = 0; suffix < 1_000; suffix++) {
        const candidate = join(root, `${stamp}${suffix ? `-${suffix}` : ''}`);
        try { mkdirSync(candidate); directory = candidate; break; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      }
      if (!directory) throw new RecordingError();
      this.directory = directory;
    } catch { throw new RecordingError(); }
  }

  /** Writes borrowed bytes synchronously; caller may wipe PCM immediately afterward. */
  append(speakerId: string, pcm: Buffer): void {
    if (this.stopped || !pcm.length) return;
    if (!/^\d{17,20}$/.test(speakerId) || !Buffer.isBuffer(pcm) || pcm.length % 2) throw new RecordingError();
    try {
      let track = this.tracks.get(speakerId);
      if (!track) {
        if (this.tracks.size >= 64) throw new RecordingError();
        track = { id: speakerId, startedAt: this.now(), bytes: 0, inUtterance: false, index: 0 };
        this.tracks.set(speakerId, track);
      }
      if (!track.inUtterance) this.padToNow(track);
      track.inUtterance = true;
      this.write(track, pcm.length, pcm);
    } catch { throw new RecordingError(); }
  }

  end(speakerId: string): void {
    const track = this.tracks.get(speakerId);
    if (track) track.inUtterance = false;
  }

  recordedMs(speakerId: string): number { return (this.tracks.get(speakerId)?.bytes ?? 0) / BYTES_PER_MS; }

  ranges(speakerId: string, fromMs: number, toMs: number): { path: string; startMs: number; endMs: number }[] {
    const result: { path: string; startMs: number; endMs: number }[] = [];
    const limit = this.tracks.get(speakerId)?.bytes ?? 0;
    let offset = Math.max(0, Math.round(fromMs * BYTES_PER_MS));
    const end = Math.min(limit, Math.round(toMs * BYTES_PER_MS));
    while (offset < end) {
      const index = Math.floor(offset / this.partBytes) + 1;
      const start = offset % this.partBytes, count = Math.min(end - offset, this.partBytes - start);
      result.push({ path: this.partPath(speakerId, index), startMs: start / BYTES_PER_MS, endMs: (start + count) / BYTES_PER_MS });
      offset += count;
    }
    return result;
  }

  stop(): { files: number; audioMs: number } {
    if (!this.stopped) {
      this.stopped = true;
      let failed = false;
      for (const track of this.tracks.values()) {
        try { this.padToNow(track); } catch { failed = true; }
        try { if (track.part && track.part.bytes < 4_800) this.write(track, 4_800 - track.part.bytes); } catch { failed = true; }
        try { this.closePart(track); } catch { failed = true; }
      }
      if (failed) throw new RecordingError();
    }
    return { files: this.files, audioMs: [...this.tracks.values()].reduce((sum, track) => sum + track.bytes / BYTES_PER_MS, 0) };
  }

  private padToNow(track: Track): void {
    const target = Math.max(0, Math.round((this.now() - track.startedAt) * 24)) * 2;
    if (target > track.bytes) this.write(track, target - track.bytes);
  }

  private openPart(track: Track): Part {
    const path = this.partPath(track.id, ++track.index);
    const fd = openSync(path, 'wx', 0o600);
    try { writeAll(fd, header(0), 0, 44, 0); }
    catch (error) { closeSync(fd); throw error; }
    const part = { fd, path, bytes: 0, checkpoint: 0 };
    track.part = part;
    return part;
  }

  private write(track: Track, bytes: number, pcm?: Buffer): void {
    let offset = 0;
    while (bytes) {
      const part = track.part ?? this.openPart(track);
      const count = Math.min(bytes, this.partBytes - part.bytes);
      if (pcm) writeAll(part.fd, pcm, offset, count, 44 + part.bytes);
      else ftruncateSync(part.fd, 44 + part.bytes + count); // Extend gaps with silence without allocating a large PCM buffer.
      part.bytes += count; track.bytes += count; offset += count; bytes -= count;
      if (part.bytes === this.partBytes) this.closePart(track);
      else if (part.bytes - part.checkpoint >= 48_000) {
        writeAll(part.fd, header(part.bytes), 0, 44, 0); part.checkpoint = part.bytes;
      }
    }
  }

  private closePart(track: Track): void {
    const part = track.part;
    if (!part) return;
    delete track.part;
    try { writeAll(part.fd, header(part.bytes), 0, 44, 0); fsyncSync(part.fd); }
    finally { closeSync(part.fd); }
    this.files++;
    this.options.onDiagnostic('recording_file_saved', { speakerId: track.id, path: part.path,
      audioMs: part.bytes / BYTES_PER_MS, pcmBytes: part.bytes });
  }

  private partPath(speakerId: string, index: number): string {
    return join(this.directory, `${speakerId}_${this.options.continuous ? 'source_' : ''}${String(index).padStart(3, '0')}.wav`);
  }
}
