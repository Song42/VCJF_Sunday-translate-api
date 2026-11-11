import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Usage {
  audioMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageRates {
  sttPerMinuteUsd: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface UsageReservation {
  /** Failed/unknown requests keep their reservation. Settle only known usage. */
  settle(actual: Usage): void;
}

export interface UsageSnapshot {
  month: string;
  estimatedUsd: number;
  audioMs: number;
  inputTokens: number;
  outputTokens: number;
  limitUsd: number;
}

type StorageCode = 'locked' | 'lock_lost' | 'read_failed' | 'invalid_data' |
  'write_failed' | 'closed' | 'clock_rollback';

export class UsageLimitError extends Error {
  readonly code = 'monthly_limit';
  constructor() {
    super('월 API 예상 사용량 한도에 도달했습니다. 새 요청을 중지합니다.');
    this.name = 'UsageLimitError';
  }
}

export class UsageStorageError extends Error {
  constructor(readonly code: StorageCode) {
    super(`사용량 기록을 안전하게 사용할 수 없습니다 (${code}). API 요청을 중지합니다.`);
    this.name = 'UsageStorageError';
  }
}

interface Counts {
  audioMs: number;
  inputTokens: number;
  outputTokens: number;
}
interface MonthRecord extends Counts { costNanoUsd: number }
interface LedgerData {
  version: 1;
  latestMonth: number;
  months: Record<string, MonthRecord>;
}
interface LockIdentity { pid: number; owner: number }

const NANO_USD = 1_000_000_000;
const MAX_FILE_BYTES = 1_048_576;
const EMPTY: MonthRecord = { audioMs: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validNumber(value: unknown, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value));
}
function normalize(usage: Usage): Counts {
  const counts = {
    audioMs: usage.audioMs ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  if (!validNumber(counts.audioMs) || !validNumber(counts.inputTokens, true) || !validNumber(counts.outputTokens, true)) {
    throw new RangeError('Usage requires finite nonnegative audio duration and integer token counts.');
  }
  return counts;
}
function monthNumber(month: string): number {
  return Number(month.replace('-', ''));
}
function isMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1970;
}
function isFsCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

/** Single-process, durable, conservative estimate. No audio or text is persisted. */
export class UsageLedger {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly limitNanoUsd: number;
  private readonly rates: Readonly<UsageRates>;
  private readonly now: () => Date;
  private readonly lockEnabled: boolean;
  private readonly identity: LockIdentity = { pid: process.pid, owner: randomBytes(6).readUIntBE(0, 6) };
  private ownsLock = false;
  private closed = false;
  private failed = false;
  private data: LedgerData;

  constructor(options: {
    filePath: string;
    limitUsd: number;
    rates: UsageRates;
    now?: () => Date;
    /** Test-only opt-out. Production must retain the process lock. */
    lock?: boolean;
  }) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.limitNanoUsd = Math.floor(options.limitUsd * NANO_USD);
    if (!Number.isFinite(options.limitUsd) || options.limitUsd <= 0 ||
        !Number.isSafeInteger(this.limitNanoUsd) || this.limitNanoUsd < 1) {
      throw new RangeError('The monthly budget must be a finite positive amount within supported precision.');
    }
    if (!validNumber(options.rates.sttPerMinuteUsd) || !validNumber(options.rates.inputPerMillionUsd) ||
        !validNumber(options.rates.outputPerMillionUsd)) {
      throw new RangeError('Usage prices must be finite nonnegative numbers.');
    }
    this.rates = Object.freeze({ ...options.rates });
    this.now = options.now ?? (() => new Date());
    this.lockEnabled = options.lock ?? true;
    this.data = { version: 1, latestMonth: 0, months: {} };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (this.lockEnabled) this.acquireLock();
      this.data = this.load();
      this.currentMonth();
    } catch (error) {
      this.releaseLock();
      if (error instanceof UsageStorageError) throw error;
      throw new UsageStorageError('read_failed');
    }
  }

  reserve(usage: Usage, tokenRates?: Partial<UsageRates>): UsageReservation {
    this.assertOpen();
    const reserved = normalize(usage);
    let reservationRates = this.rates;
    if (tokenRates !== undefined) {
      const hasTokens = tokenRates?.inputPerMillionUsd !== undefined || tokenRates?.outputPerMillionUsd !== undefined;
      const inputPerMillionUsd = hasTokens ? tokenRates?.inputPerMillionUsd : this.rates.inputPerMillionUsd;
      const outputPerMillionUsd = hasTokens ? tokenRates?.outputPerMillionUsd : this.rates.outputPerMillionUsd;
      const sttPerMinuteUsd = tokenRates?.sttPerMinuteUsd === undefined ? this.rates.sttPerMinuteUsd : tokenRates.sttPerMinuteUsd;
      if (!tokenRates || (!hasTokens && tokenRates.sttPerMinuteUsd === undefined)
        || !validNumber(inputPerMillionUsd) || !validNumber(outputPerMillionUsd) || !validNumber(sttPerMinuteUsd)) {
        throw new RangeError('Usage prices must be finite nonnegative numbers.');
      }
      // Capture prices per request so independent audio verification/direct benchmarks
      // share the same monthly budget without repricing earlier usage.
      reservationRates = Object.freeze({ sttPerMinuteUsd,
        inputPerMillionUsd, outputPerMillionUsd });
    }
    const month = this.currentMonth();
    const cost = this.cost(reserved, reservationRates);
    const previous = this.data.months[month] ?? EMPTY;
    if (previous.costNanoUsd + cost > this.limitNanoUsd) throw new UsageLimitError();
    const next: MonthRecord = {
      audioMs: previous.audioMs + reserved.audioMs,
      inputTokens: previous.inputTokens + reserved.inputTokens,
      outputTokens: previous.outputTokens + reserved.outputTokens,
      costNanoUsd: previous.costNanoUsd + cost,
    };
    this.validateRecord(next);
    this.persist({ ...this.data, latestMonth: monthNumber(month), months: { ...this.data.months, [month]: next } });
    let settled = false;
    return {
      settle: (actual: Usage): void => {
        this.assertOpen();
        if (settled) return;
        const used = normalize(actual);
        if (used.audioMs > reserved.audioMs || used.inputTokens > reserved.inputTokens || used.outputTokens > reserved.outputTokens) {
          throw new RangeError('Actual usage exceeds the reserved maximum; the reservation remains charged.');
        }
        const current = this.data.months[month]!;
        // Use the reservation's original month and its captured, immutable prices.
        const adjusted: MonthRecord = {
          audioMs: Math.max(0, current.audioMs - reserved.audioMs + used.audioMs),
          inputTokens: current.inputTokens - reserved.inputTokens + used.inputTokens,
          outputTokens: current.outputTokens - reserved.outputTokens + used.outputTokens,
          costNanoUsd: current.costNanoUsd - cost + this.cost(used, reservationRates),
        };
        this.validateRecord(adjusted);
        this.persist({ ...this.data, months: { ...this.data.months, [month]: adjusted } });
        settled = true;
      },
    };
  }

  snapshot(): UsageSnapshot {
    this.assertOpen();
    const month = this.currentMonth();
    const record = this.data.months[month] ?? EMPTY;
    return {
      month, estimatedUsd: record.costNanoUsd / NANO_USD,
      audioMs: record.audioMs, inputTokens: record.inputTokens, outputTokens: record.outputTokens,
      limitUsd: this.limitNanoUsd / NANO_USD,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseLock();
  }

  private cost(usage: Counts, rates: Readonly<UsageRates>): number {
    const result = Math.ceil((usage.audioMs / 60_000 * rates.sttPerMinuteUsd +
      usage.inputTokens / 1_000_000 * rates.inputPerMillionUsd +
      usage.outputTokens / 1_000_000 * rates.outputPerMillionUsd) * NANO_USD);
    if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Usage cost exceeds supported precision.');
    return result;
  }

  private currentMonth(): string {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new UsageStorageError('clock_rollback');
    const month = date.toISOString().slice(0, 7);
    if (!isMonth(month) || monthNumber(month) < this.data.latestMonth) throw new UsageStorageError('clock_rollback');
    return month;
  }

  private assertOpen(): void {
    if (this.closed) throw new UsageStorageError('closed');
    if (this.failed) throw new UsageStorageError('write_failed');
    if (this.lockEnabled && (!this.ownsLock || !this.ownsFile(this.lockPath))) {
      this.failed = true;
      throw new UsageStorageError('lock_lost');
    }
  }

  private validateRecord(value: unknown): asserts value is MonthRecord {
    if (!isObject(value) || !hasKeys(value, ['audioMs', 'inputTokens', 'outputTokens', 'costNanoUsd']) ||
        !validNumber(value.audioMs) || !validNumber(value.inputTokens, true) ||
        !validNumber(value.outputTokens, true) || !validNumber(value.costNanoUsd, true)) {
      throw new UsageStorageError('invalid_data');
    }
  }

  private load(): LedgerData {
    try {
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new UsageStorageError('invalid_data');
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isObject(value) || !hasKeys(value, ['version', 'latestMonth', 'months']) || value.version !== 1 ||
          !Number.isSafeInteger(value.latestMonth) || typeof value.latestMonth !== 'number' || !isObject(value.months)) {
        throw new UsageStorageError('invalid_data');
      }
      const keys = Object.keys(value.months);
      if (keys.length > 1200 || value.latestMonth < 0 || value.latestMonth > 999912) throw new UsageStorageError('invalid_data');
      for (const month of keys) {
        if (!isMonth(month) || monthNumber(month) > value.latestMonth) throw new UsageStorageError('invalid_data');
        this.validateRecord(value.months[month]);
      }
      if (keys.length === 0 || value.latestMonth !== Math.max(...keys.map(monthNumber))) throw new UsageStorageError('invalid_data');
      return value as unknown as LedgerData;
    } catch (error) {
      if (isFsCode(error, 'ENOENT')) return { version: 1, latestMonth: 0, months: {} };
      if (error instanceof UsageStorageError) throw error;
      throw new UsageStorageError('invalid_data');
    }
  }

  private persist(next: LedgerData): void {
    this.assertOpen();
    const temporary = `${this.filePath}.tmp-${this.identity.pid}-${this.identity.owner}`;
    let descriptor: number | undefined;
    try {
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new UsageStorageError('write_failed');
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, text, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
      // Windows does not provide portable directory fsync through Node's API.
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.filePath), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.data = next;
    } catch {
      this.failed = true;
      throw new UsageStorageError('write_failed');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* no retained audio/text in temporary files */ }
    }
  }

  private acquireLock(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.writeLock(this.lockPath);
        this.ownsLock = true;
        return;
      } catch (error) {
        if (!isFsCode(error, 'EEXIST')) throw new UsageStorageError('locked');
        if (attempt > 0) throw new UsageStorageError('locked');
      }
      // Serialize stale-lock reclamation. A crashed reclamation guard intentionally
      // requires operator inspection instead of risking removal of a new owner's lock.
      const guard = `${this.lockPath}.reclaim`;
      try { this.writeLock(guard); } catch { throw new UsageStorageError('locked'); }
      try {
        if (!existsSync(this.lockPath)) continue;
        const owner = this.readLock(this.lockPath);
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (error) { dead = isFsCode(error, 'ESRCH'); }
        if (!dead) throw new UsageStorageError('locked');
        // Other reclaimers cannot unlink while the guard is held; the dead owner
        // cannot release it. Fresh acquirers only create after this unlink.
        unlinkSync(this.lockPath);
      } finally {
        if (this.ownsFile(guard)) unlinkSync(guard);
      }
    }
    throw new UsageStorageError('locked');
  }

  private writeLock(path: string): void {
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(this.identity), 'utf8');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
  }

  private readLock(path: string): LockIdentity {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) throw new Error();
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isObject(value) || !hasKeys(value, ['pid', 'owner']) ||
          !validNumber(value.pid, true) || value.pid < 1 || !validNumber(value.owner, true)) throw new Error();
      return value as unknown as LockIdentity;
    } catch { throw new UsageStorageError('locked'); }
  }

  private ownsFile(path: string): boolean {
    try {
      const owner = this.readLock(path);
      return owner.pid === this.identity.pid && owner.owner === this.identity.owner;
    } catch { return false; }
  }

  private releaseLock(): void {
    if (!this.ownsLock) return;
    if (this.ownsFile(this.lockPath)) {
      try { unlinkSync(this.lockPath); } catch { /* fail closed on subsequent open */ }
    }
    this.ownsLock = false;
  }
}
