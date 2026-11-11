import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { UsageLedger, UsageLimitError, UsageStorageError, type UsageRates } from '../src/usage.js';

const rates: UsageRates = { sttPerMinuteUsd: 0.017, inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 };
const november = () => new Date('2026-11-04T20:00:00Z');

test('live STT, independent retranscription and direct translation keep separate audio prices in one budget', (t) => {
  const ledger = fixture(t).create();
  ledger.reserve({ audioMs: 60_000 }).settle({ audioMs: 30_000 });
  const reread = ledger.reserve({ audioMs: 60_000 }, { sttPerMinuteUsd: 0.0045 });
  ledger.reserve({ audioMs: 60_000 }, { sttPerMinuteUsd: 0.034 });
  reread.settle({ audioMs: 30_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.04475);
  assert.equal(ledger.snapshot().audioMs, 120_000);
  assert.throws(() => ledger.reserve({ audioMs: 100 }, { sttPerMinuteUsd: -1 }), RangeError);
});

function fixture(t: TestContext) {
  const root = resolve('.tools');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'usage-test-'));
  const filePath = join(directory, 'usage.json');
  const ledgers: UsageLedger[] = [];
  t.after(() => {
    for (const ledger of ledgers) ledger.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), realpathSync(root));
    assert.ok(target.startsWith(realpathSync(root) + sep));
    rmSync(target, { recursive: true, force: true });
  });
  return {
    directory, filePath,
    create(options: Partial<ConstructorParameters<typeof UsageLedger>[0]> = {}) {
      const ledger = new UsageLedger({ filePath, limitUsd: 10, rates, now: november, ...options });
      ledgers.push(ledger);
      return ledger;
    },
  };
}

test('reserves before requests, settles known audio, and repeated settlement cannot refund twice', (t) => {
  const f = fixture(t);
  const ledger = f.create();
  const reservation = ledger.reserve({ audioMs: 60_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.017);
  const persisted = JSON.parse(readFileSync(f.filePath, 'utf8'));
  assert.equal(persisted.months['2026-11'].audioMs, 60_000);
  assert.equal(persisted.months['2026-11'].costNanoUsd, 17_000_000);
  reservation.settle({ audioMs: 30_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.0085);
  assert.equal(ledger.snapshot().audioMs, 30_000);
  reservation.settle({ audioMs: 0 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.0085);
});

test('overlapping reservations cannot exceed the monthly cap', (t) => {
  const ledger = fixture(t).create({ limitUsd: 0.03 });
  const first = ledger.reserve({ audioMs: 60_000 });
  assert.throws(() => ledger.reserve({ audioMs: 60_000 }), UsageLimitError);
  assert.equal(ledger.snapshot().audioMs, 60_000);
  first.settle({ audioMs: 30_000 });
  ledger.reserve({ audioMs: 60_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.0255);
  assert.throws(() => ledger.reserve({ audioMs: 60_000 }), UsageLimitError);
});

test('unsettled reservations survive restart and old costs survive price changes', (t) => {
  const f = fixture(t);
  const first = f.create();
  first.reserve({ inputTokens: 1_000, outputTokens: 2_000 });
  const oldCost = first.snapshot().estimatedUsd;
  first.close();
  const second = f.create({ rates: { sttPerMinuteUsd: 1, inputPerMillionUsd: 10, outputPerMillionUsd: 20 } });
  assert.equal(second.snapshot().estimatedUsd, oldCost);
  second.reserve({ audioMs: 60_000 });
  assert.equal(second.snapshot().estimatedUsd, oldCost + 1);
  assert.equal(second.snapshot().inputTokens, 1_000);
  assert.equal(second.snapshot().outputTokens, 2_000);
});

test('translation and segmentation token prices share one ledger without changing the audio price', (t) => {
  const ledger = fixture(t).create();
  const segmentationRates = { inputPerMillionUsd: 1, outputPerMillionUsd: 5 };
  ledger.reserve({ inputTokens: 1_000_000 });
  ledger.reserve({ outputTokens: 1_000_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 0.6);
  const segmentation = ledger.reserve({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, segmentationRates);
  assert.equal(ledger.snapshot().estimatedUsd, 6.6);
  ledger.reserve({ audioMs: 60_000 }, segmentationRates);
  assert.equal(ledger.snapshot().estimatedUsd, 6.617);
  segmentation.settle({ inputTokens: 500_000, outputTokens: 500_000 });
  assert.deepEqual(ledger.snapshot(), {
    month: '2026-11', estimatedUsd: 3.617, audioMs: 60_000,
    inputTokens: 1_500_000, outputTokens: 1_500_000, limitUsd: 10,
  });
});

test('overlapping differently priced requests are limited by the same monthly budget', (t) => {
  const f = fixture(t);
  const ledger = f.create({ limitUsd: 0.01 });
  const segmentationRates = { inputPerMillionUsd: 1, outputPerMillionUsd: 5 };
  ledger.reserve({ inputTokens: 1_000, outputTokens: 2_000 });
  const segmentation = ledger.reserve({ inputTokens: 1_000, outputTokens: 1_000 }, segmentationRates);
  const before = readFileSync(f.filePath, 'utf8');
  assert.throws(() => ledger.reserve({ inputTokens: 1_000, outputTokens: 1_000 }, segmentationRates), UsageLimitError);
  assert.equal(readFileSync(f.filePath, 'utf8'), before);
  segmentation.settle({ inputTokens: 0, outputTokens: 0 });
  assert.doesNotThrow(() => ledger.reserve({ inputTokens: 1_000, outputTokens: 1_000 }, segmentationRates));
  assert.ok(ledger.snapshot().estimatedUsd <= 0.01);
});

test('settlement snapshots overridden prices and later reservations still use default prices', (t) => {
  const ledger = fixture(t).create();
  const mutableRates = { inputPerMillionUsd: 1, outputPerMillionUsd: 5 };
  const reservation = ledger.reserve({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, mutableRates);
  mutableRates.inputPerMillionUsd = 0;
  mutableRates.outputPerMillionUsd = 0;
  reservation.settle({ inputTokens: 500_000, outputTokens: 500_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 3);
  ledger.reserve({ inputTokens: 1_000_000 });
  ledger.reserve({ outputTokens: 1_000_000 });
  assert.equal(ledger.snapshot().estimatedUsd, 3.6);
});

test('invalid price overrides cannot write or change usage and zero token prices are allowed', (t) => {
  const f = fixture(t);
  const ledger = f.create();
  const badRates: unknown[] = [null, {}, { inputPerMillionUsd: 1 },
    { inputPerMillionUsd: NaN, outputPerMillionUsd: 5 },
    { inputPerMillionUsd: 1, outputPerMillionUsd: Infinity },
    { inputPerMillionUsd: -1, outputPerMillionUsd: 5 },
    { inputPerMillionUsd: '1', outputPerMillionUsd: 5 },
    { inputPerMillionUsd: 1, outputPerMillionUsd: Number.MAX_SAFE_INTEGER + 1 }];
  for (const value of badRates) {
    assert.throws(() => ledger.reserve({ inputTokens: 10 }, value as Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>), RangeError);
  }
  assert.equal(existsSync(f.filePath), false);
  ledger.reserve({ inputTokens: 10 }, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
  const before = readFileSync(f.filePath, 'utf8');
  assert.equal(ledger.snapshot().estimatedUsd, 0);
  for (const value of badRates) {
    assert.throws(() => ledger.reserve({ outputTokens: 10 }, value as Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>), RangeError);
    assert.equal(readFileSync(f.filePath, 'utf8'), before);
  }
});

test('mixed-price reservations survive restart without repricing or changing the stored schema', (t) => {
  const f = fixture(t);
  const first = f.create();
  first.reserve({ inputTokens: 1_000_000 });
  first.reserve({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
  const before = readFileSync(f.filePath, 'utf8');
  const oldCost = first.snapshot().estimatedUsd;
  first.close();
  const second = f.create({ rates: { sttPerMinuteUsd: 1, inputPerMillionUsd: 2, outputPerMillionUsd: 10 } });
  assert.equal(second.snapshot().estimatedUsd, oldCost);
  assert.equal(readFileSync(f.filePath, 'utf8'), before);
  const persisted = JSON.parse(before);
  assert.equal(persisted.version, 1);
  assert.deepEqual(Object.keys(persisted.months['2026-11']).sort(), ['audioMs', 'costNanoUsd', 'inputTokens', 'outputTokens']);
  second.reserve({ inputTokens: 1_000_000 }, { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 });
  assert.equal(second.snapshot().estimatedUsd, 6.2);
});

test('corrupt or unexpected data fails closed and releases the constructor lock', (t) => {
  const f = fixture(t);
  for (const value of ['{broken', '{}', '{"transcript":"must-not-appear"}',
    '{"version":1,"latestMonth":202611,"months":{"2026-11":{"audioMs":-1,"inputTokens":0,"outputTokens":0,"costNanoUsd":0}}}']) {
    writeFileSync(f.filePath, value);
    assert.throws(() => f.create(), (error) => {
      assert.ok(error instanceof UsageStorageError);
      assert.equal(error.code, 'invalid_data');
      assert.ok(!error.message.includes('must-not-appear'));
      assert.ok(!error.message.includes(f.filePath));
      return true;
    });
    assert.equal(existsSync(`${f.filePath}.lock`), false);
    assert.equal(readFileSync(f.filePath, 'utf8'), value);
  }
});

test('failed durable writes poison the instance before any further request reservation', (t) => {
  const f = fixture(t);
  const ledger = f.create();
  const identity = JSON.parse(readFileSync(`${f.filePath}.lock`, 'utf8'));
  const temporary = `${f.filePath}.tmp-${identity.pid}-${identity.owner}`;
  mkdirSync(temporary);
  assert.throws(() => ledger.reserve({ audioMs: 1000 }), UsageStorageError);
  assert.throws(() => ledger.reserve({ audioMs: 1000 }), UsageStorageError);
  assert.throws(() => ledger.snapshot(), UsageStorageError);
  assert.equal(existsSync(f.filePath), false);
});

test('in-flight reservations settle their original UTC month and clock rollback cannot reopen spending', (t) => {
  const f = fixture(t);
  let now = new Date('2026-11-30T23:59:59Z');
  const ledger = f.create({ now: () => now });
  const earlier = ledger.reserve({ audioMs: 60_000 });
  now = new Date('2026-12-01T00:00:01Z');
  assert.equal(ledger.snapshot().estimatedUsd, 0);
  ledger.reserve({ audioMs: 60_000 });
  earlier.settle({ audioMs: 30_000 });
  assert.equal(ledger.snapshot().month, '2026-12');
  assert.equal(ledger.snapshot().estimatedUsd, 0.017);
  const persisted = JSON.parse(readFileSync(f.filePath, 'utf8'));
  assert.equal(persisted.months['2026-11'].audioMs, 30_000);
  assert.equal(persisted.months['2026-12'].audioMs, 60_000);
  now = new Date('2026-11-30T23:59:59Z');
  assert.throws(() => ledger.reserve({ audioMs: 1 }), (error) => error instanceof UsageStorageError && error.code === 'clock_rollback');
  ledger.close();
  assert.throws(() => f.create(), UsageStorageError);
});

test('live-process lock excludes another ledger and close permits reopening', (t) => {
  const f = fixture(t);
  const first = f.create();
  first.reserve({ audioMs: 1000 });
  assert.throws(() => f.create(), (error) => error instanceof UsageStorageError && error.code === 'locked');
  assert.equal(first.snapshot().audioMs, 1000);
  first.close();
  const second = f.create();
  assert.equal(second.snapshot().audioMs, 1000);
});

test('a definitively dead process lock can be reclaimed', (t) => {
  const f = fixture(t);
  let deadPid: number | undefined;
  for (let candidate = 999_999; candidate < 1_000_020; candidate += 1) {
    try { process.kill(candidate, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { deadPid = candidate; break; }
    }
  }
  assert.notEqual(deadPid, undefined, 'a known-dead PID must be found for the fixture');
  writeFileSync(`${f.filePath}.lock`, JSON.stringify({ pid: deadPid, owner: 1 }));
  const ledger = f.create();
  ledger.reserve({ audioMs: 1000 });
  assert.equal(ledger.snapshot().audioMs, 1000);
  assert.equal(existsSync(`${f.filePath}.lock.reclaim`), false);
});

test('lost lock stops spending and close never removes a replacement owner lock', (t) => {
  const f = fixture(t);
  const ledger = f.create();
  const replacement = JSON.stringify({ pid: process.pid, owner: 0 });
  writeFileSync(`${f.filePath}.lock`, replacement);
  assert.throws(() => ledger.reserve({ audioMs: 1000 }), (error) => error instanceof UsageStorageError && error.code === 'lock_lost');
  ledger.close();
  assert.equal(readFileSync(`${f.filePath}.lock`, 'utf8'), replacement);
});

test('invalid units and oversettlement cannot reduce durable charges', (t) => {
  const ledger = fixture(t).create();
  for (const usage of [{ audioMs: -1 }, { audioMs: Infinity }, { inputTokens: 0.5 }, { outputTokens: NaN }]) {
    assert.throws(() => ledger.reserve(usage), RangeError);
  }
  const reservation = ledger.reserve({ audioMs: 60_000 });
  assert.throws(() => reservation.settle({ audioMs: 60_001 }), RangeError);
  assert.equal(ledger.snapshot().estimatedUsd, 0.017);
  ledger.close();
  assert.throws(() => ledger.reserve({ audioMs: 0 }), UsageStorageError);
  assert.throws(() => reservation.settle({ audioMs: 0 }), UsageStorageError);
});

test('ledger payload contains numeric usage and metadata only', (t) => {
  const f = fixture(t);
  f.create().reserve({ audioMs: 2.5, inputTokens: 100, outputTokens: 200 });
  const payload: unknown = JSON.parse(readFileSync(f.filePath, 'utf8'));
  function numericLeaves(value: unknown): void {
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) numericLeaves(item);
    } else {
      assert.equal(typeof value, 'number');
      assert.ok(Number.isFinite(value));
    }
  }
  numericLeaves(payload);
});
