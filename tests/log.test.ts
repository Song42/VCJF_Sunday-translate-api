import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { captionPreview, closeRunLog, diagnostic, LogStorageError, RunLog, startRunLog } from '../src/log.js';
import type { Caption } from '../src/types.js';

function directory(t: TestContext): string {
  const root = resolve('.tools/log-tests');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'run-'));
  t.after(() => {
    assert.equal(dirname(path), root);
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('run file preserves Unicode and embedded newlines as complete JSON lines before shutdown', (t) => {
  const dir = directory(t);
  const time = new Date(2026, 10, 5, 16, 7, 8, 9);
  const log = new RunLog(dir, () => time);
  assert.equal(basename(log.filePath), '2026-11-05_16-07-08-009.log');
  log.write({ event: 'capture_summary', speakers: 2 });
  log.write({ type: 'caption', originalText: '안녕.\nПривет. Сәлем.', translations: { en: 'Hello.' } });
  const live = records(log.filePath);
  assert.equal(live.length, 3);
  assert.equal(live[0]?.event, 'run_started');
  assert.equal(live[1]?.at, time.toISOString());
  assert.equal(live[2]?.originalText, '안녕.\nПривет. Сәлем.');
  log.close();
  const after = records(log.filePath);
  assert.equal(after.at(-1)?.event, 'run_finished');
  log.close();
  log.write({ event: 'late' });
  assert.deepEqual(records(log.filePath), after);
});

test('same-millisecond runs get separate files and never overwrite existing logs', (t) => {
  const dir = directory(t);
  const now = () => new Date(2026, 10, 5, 16, 7, 8, 9);
  const first = new RunLog(dir, now);
  const second = new RunLog(dir, now);
  try {
    assert.notEqual(first.filePath, second.filePath);
    assert.equal(basename(second.filePath), '2026-11-05_16-07-08-009-1.log');
    first.write({ event: 'first_run' });
    second.write({ event: 'second_run' });
    assert.equal(records(first.filePath).at(-1)?.event, 'first_run');
    assert.equal(records(second.filePath).at(-1)?.event, 'second_run');
  } finally { first.close(); second.close(); }
});

test('bot routing keeps speech off the terminal and saves diagnostics, full captions and final usage', (t) => {
  const dir = directory(t);
  const terminal: unknown[][] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { terminal.push(args); });
  const path = startRunLog({ directory: dir });
  const caption: Caption = { type: 'caption', sequence: 1, segmentId: 'segment-1', speakerId: 'speaker-1',
    speakerName: '화자', originalText: '원문만 표시해 주세요.', createdAt: Date.now(),
    translations: { ko: '원문만 표시해 주세요.', ru: 'Покажите только оригинал.', kk: 'Тек түпнұсқаны көрсетіңіз.', en: 'Show only the original.' } };
  try {
    diagnostic('bot_ready');
    captionPreview(caption);
    diagnostic('usage_summary', { estimatedUsd: 0.1 });
  } finally { closeRunLog(); }
  assert.deepEqual(terminal, []);
  const rows = records(path);
  assert.ok(rows.some((row) => row.event === 'bot_ready'));
  const saved = rows.find((row) => row.type === 'caption')!;
  assert.equal(saved.originalText, caption.originalText);
  assert.deepEqual(saved.translations, caption.translations);
  assert.equal(saved.speakerName, '화자');
  assert.equal(rows.at(-2)?.event, 'usage_summary');
  assert.equal(rows.at(-1)?.event, 'run_finished');
  diagnostic('late_shutdown_event');
  assert.deepEqual(terminal, [], 'late diagnostics do not fall back to terminal output');
  assert.deepEqual(records(path), rows);
});

test('unwritable log destination fails with an actionable message without exposing raw file errors', (t) => {
  const dir = directory(t);
  const path = join(dir, 'private-path-token');
  writeFileSync(path, 'a file blocks this directory');
  assert.throws(() => new RunLog(path), (error) => {
    assert.ok(error instanceof LogStorageError);
    assert.match(error.message, /logs/);
    assert.ok(!error.message.includes('private-path-token'));
    assert.equal(error.cause, undefined);
    return true;
  });
});
