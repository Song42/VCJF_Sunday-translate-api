import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LocalAudioRecorder, RecordingError } from '../src/recording.js';
import { parseBenchmarkWav } from '../src/audio-benchmark-core.js';

const A = '111111111111111111';
const B = '222222222222222222';
function fixture(t: TestContext, partMs = 120_000) {
  const root = resolve('.tools/recording-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  let time = 0;
  const events: { event: string; fields: Record<string, string | number | boolean> }[] = [];
  const create = () => new LocalAudioRecorder({ directory, partMs, now: () => time,
    date: () => new Date(2026, 10, 5, 16, 7, 8, 9), onDiagnostic: (event, fields) => events.push({ event, fields }) });
  const recorders: LocalAudioRecorder[] = [];
  const recorder = create(); recorders.push(recorder);
  t.after(() => {
    for (const item of recorders) item.stop();
    assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true });
  });
  return { recorder, events, directory, setTime: (value: number) => { time = value; },
    another: () => { const next = create(); recorders.push(next); return next; },
    audio: (name: string) => parseBenchmarkWav(readFileSync(join(recorder.directory, name))) };
}

test('recorded Discord PCM survives caller wiping and opens directly in the benchmark WAV decoder', (t) => {
  const f = fixture(t);
  const borrowed = Buffer.alloc(4_800, 0x2a);
  f.recorder.append(A, borrowed);
  borrowed.fill(0);
  f.setTime(100);
  assert.deepEqual(f.recorder.stop(), { files: 1, audioMs: 100 });
  assert.deepEqual(f.audio(`${A}_001.wav`), Buffer.alloc(4_800, 0x2a));
  assert.equal(f.events[0]?.event, 'recording_file_saved');
  assert.equal(f.events[0]?.fields.audioMs, 100);
  f.recorder.append(A, Buffer.alloc(4_800, 0x7f));
  assert.deepEqual(f.recorder.stop(), { files: 1, audioMs: 100 });
  assert.equal(readdirSync(f.recorder.directory).length, 1);
});

test('recording preserves pauses and the final quiet interval for a meaningful live replay', (t) => {
  const f = fixture(t);
  f.recorder.append(A, Buffer.alloc(4_800, 1));
  f.recorder.end(A);
  f.setTime(600);
  f.recorder.append(A, Buffer.alloc(4_800, 2));
  f.recorder.end(A);
  f.setTime(1_000);
  f.recorder.stop();
  const pcm = f.audio(`${A}_001.wav`);
  assert.equal(pcm.length, 48_000);
  assert.deepEqual(pcm.subarray(0, 4_800), Buffer.alloc(4_800, 1));
  assert.deepEqual(pcm.subarray(4_800, 28_800), Buffer.alloc(24_000));
  assert.deepEqual(pcm.subarray(28_800, 33_600), Buffer.alloc(4_800, 2));
  assert.deepEqual(pcm.subarray(33_600), Buffer.alloc(14_400));
});

test('rotation preserves every source byte in order and isolates different speakers', (t) => {
  const f = fixture(t, 1_000);
  const source = Buffer.alloc(57_600);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  f.recorder.append(A, source);
  f.recorder.append(B, Buffer.alloc(4_800, 3));
  const summary = f.recorder.stop();
  assert.equal(summary.files, 3);
  assert.equal(f.audio(`${A}_001.wav`).length, 48_000);
  assert.equal(f.audio(`${A}_002.wav`).length, 9_600);
  assert.deepEqual(Buffer.concat([f.audio(`${A}_001.wav`), f.audio(`${A}_002.wav`)]), source);
  assert.deepEqual(f.audio(`${B}_001.wav`), Buffer.alloc(4_800, 3));
});

test('same-time meetings get separate directories without overwriting older recordings', (t) => {
  const f = fixture(t);
  const next = f.another();
  assert.notEqual(next.directory, f.recorder.directory);
  f.recorder.append(A, Buffer.alloc(4_800, 1));
  next.append(A, Buffer.alloc(4_800, 2));
  f.recorder.stop(); next.stop();
  assert.deepEqual(f.audio(`${A}_001.wav`), Buffer.alloc(4_800, 1));
  assert.deepEqual(parseBenchmarkWav(readFileSync(join(next.directory, `${A}_001.wav`))), Buffer.alloc(4_800, 2));
});

test('unsafe IDs and invalid destinations fail without exposing raw paths or creating outside files', (t) => {
  const f = fixture(t);
  assert.throws(() => f.recorder.append('../private-name', Buffer.alloc(4_800)), RecordingError);
  assert.throws(() => f.recorder.append(A, Buffer.alloc(3)), RecordingError);
  assert.deepEqual(readdirSync(f.recorder.directory), []);
  const blocked = join(f.directory, 'private-path');
  writeFileSync(blocked, 'not a directory');
  assert.throws(() => new LocalAudioRecorder({ directory: blocked, onDiagnostic: () => {} }), (error) => {
    assert.ok(error instanceof RecordingError);
    assert.ok(!error.message.includes('private-path'));
    assert.equal(error.cause, undefined);
    return true;
  });
});
