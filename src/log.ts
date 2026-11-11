import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Caption } from './types.js';

export class LogStorageError extends Error {
  constructor() {
    super('로그 파일을 만들거나 기록할 수 없습니다. logs 폴더 권한과 디스크 공간을 확인하세요.');
    this.name = 'LogStorageError';
  }
}

/** One UTF-8 JSON-lines file per process. Local-time filename and UTC event timestamps. */
export class RunLog {
  readonly filePath: string;
  private readonly fd: number;
  private closed = false;

  constructor(directory = resolve('logs'), private readonly now: () => Date = () => new Date()) {
    try {
      mkdirSync(directory, { recursive: true });
      const date = now();
      const pad = (n: number, width = 2) => String(n).padStart(width, '0');
      const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
        + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
      let created: { fd: number; path: string } | undefined;
      for (let suffix = 0; suffix < 1000; suffix += 1) {
        const path = join(directory, `${stamp}${suffix ? `-${suffix}` : ''}.log`);
        try { created = { fd: openSync(path, 'wx', 0o600), path }; break; }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      if (!created) throw new LogStorageError();
      this.fd = created.fd;
      this.filePath = created.path;
      try {
        this.write({ event: 'run_started', pid: process.pid, localUtcOffsetMinutes: -date.getTimezoneOffset() });
      } catch (error) {
        closeSync(this.fd);
        throw error;
      }
    } catch { throw new LogStorageError(); }
  }

  write(record: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      appendFileSync(this.fd, `${JSON.stringify({ at: this.now().toISOString(), ...record })}\n`, 'utf8');
    } catch { throw new LogStorageError(); }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.write({ event: 'run_finished' });
      fsyncSync(this.fd);
    } catch { throw new LogStorageError(); }
    finally {
      this.closed = true;
      try { closeSync(this.fd); } catch { /* Preserve an earlier write failure. */ }
    }
  }
}

let runLog: RunLog | undefined;
let onFailure: (() => void) | undefined;
let failureReported = false;

export function startRunLog(options: { directory?: string; onFailure?: () => void } = {}): string {
  runLog?.close();
  runLog = new RunLog(options.directory);
  onFailure = options.onFailure;
  failureReported = false;
  return runLog.filePath;
}

function reportFailure(): void {
  if (failureReported) return;
  failureReported = true;
  console.error(new LogStorageError().message);
  onFailure?.();
}

function writeRecord(record: Record<string, unknown>): void {
  if (!runLog) {
    // Standalone utilities such as register keep their existing terminal output.
    console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));
    return;
  }
  try { runLog.write(record); } catch { reportFailure(); }
}

export function closeRunLog(): void {
  try { runLog?.close(); } catch { reportFailure(); }
}

// Diagnostic callers still pass only explicit events and primitive metadata.
// Never pass Error objects, interactions, configuration, credentials, or audio.
export function diagnostic(event: string,
  fields: Record<string, string | number | boolean | undefined> = {}): void {
  writeRecord({ event, ...fields });
}

/** Enabled local preview: full caption to the run log only; never print speech. */
export function captionPreview(caption: Caption): void {
  if (!runLog) return;
  writeRecord({ ...caption, preview: true });
}

export function captionTrace(event: string, fields: Record<string, unknown>): void { writeRecord({ event, ...fields }); }
