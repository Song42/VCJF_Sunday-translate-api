import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CaptionAudioRecorder } from '../src/caption-recording.js';
import { RecordingError } from '../src/recording.js';
import { parseBenchmarkWav } from '../src/audio-benchmark-core.js';
import type { Caption } from '../src/types.js';

const A = '111111111111111111';
function caption(sequence: number, originalText: string, ids = ['source-1']): Caption {
  return { type: 'caption', sequence, originalText, segmentId: `caption-${sequence}`, sourceSegmentIds: ids,
    speakerId: A, speakerName: 'Test', status: 'initial', revision: 0, createdAt: Date.now(),
    translations: { ko: originalText, ru: 'Перевод', kk: 'Аударма', en: 'Translation' } };
}
function fixture(t: TestContext) {
  const root = resolve('.tools/caption-recording-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  let now = 0;
  const events: string[] = [];
  const recorder = new CaptionAudioRecorder({ directory, now: () => now, onDiagnostic: (event) => events.push(event) });
  t.after(() => { recorder.stop(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  return { recorder, events, setTime: (value: number) => { now = value; } };
}
const audio = (path: string) => parseBenchmarkWav(readFileSync(path));

test('two translated units from one STT turn produce separate WAVs without duplicated or lost PCM', (t) => {
  const f = fixture(t);
  const pcm = Buffer.alloc(48_000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i < 24_000 ? 4_000 : 8_000, i);
  f.recorder.audio('source-1', A, pcm);
  f.recorder.transcript('source-1', A, '첫째 문장. 둘째 문장.');
  f.setTime(20_000); // Translation latency must not move the cut into later live audio.
  const first = f.recorder.caption(caption(1, '첫째 문장.'))!;
  const second = f.recorder.caption(caption(2, '둘째 문장.'))!;
  assert.notEqual(first.path, second.path);
  assert.equal(first.alignment, 'estimated'); assert.equal(second.alignment, 'estimated');
  assert.deepEqual(Buffer.concat([audio(first.path), audio(second.path)]), pcm);
  assert.equal(audio(first.path).length, 24_000);
  assert.deepEqual(f.recorder.stop(), { files: 2, audioMs: 1_000 });
  assert.equal(readdirSync(f.recorder.directory).filter((file) => file.endsWith('.wav')).length, 2);
});

test('one translated unit joins multiple STT turns and preserves their actual pause', (t) => {
  const f = fixture(t);
  f.recorder.audio('source-1', A, Buffer.alloc(4_800, 1));
  f.recorder.transcript('source-1', A, '미완성');
  f.setTime(300);
  f.recorder.audio('source-2', A, Buffer.alloc(4_800, 2));
  f.recorder.transcript('source-2', A, '문장입니다.');
  const recording = f.recorder.caption(caption(1, '미완성 문장입니다.', ['source-1', 'source-2']))!;
  assert.equal(recording.alignment, 'stt-boundary');
  const pcm = audio(recording.path);
  assert.deepEqual(pcm, Buffer.concat([Buffer.alloc(4_800, 1), Buffer.alloc(9_600), Buffer.alloc(4_800, 2)]));
  f.recorder.stop();
  assert.equal(readdirSync(f.recorder.directory).length, 2, 'one WAV and its caption JSON only');
});

test('nearby quiet intervals refine estimated cuts while keeping adjacent clips contiguous', (t) => {
  const f = fixture(t);
  const pcm = Buffer.alloc(48_000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(i >= 520 * 48 && i < 540 * 48 ? 0 : 5_000, i);
  f.recorder.audio('source-1', A, pcm); f.recorder.transcript('source-1', A, '첫째 문장. 둘째 문장.');
  const first = f.recorder.caption(caption(1, '첫째 문장.'))!;
  const second = f.recorder.caption(caption(2, '둘째 문장.'))!;
  const duration = audio(first.path).length / 48;
  assert.ok(duration >= 520 && duration <= 540, `cut ${duration}ms should be inside the actual quiet interval`);
  assert.deepEqual(Buffer.concat([audio(first.path), audio(second.path)]), pcm);
});

test('accuracy finalization updates the companion JSON without creating another audio file', (t) => {
  const f = fixture(t);
  f.recorder.audio('source-1', A, Buffer.alloc(4_800, 1));
  f.recorder.transcript('source-1', A, '안녕하세요.');
  const initial = caption(1, '안녕하세요.');
  const recording = f.recorder.caption(initial)!;
  const before = readFileSync(recording.path);
  const final = { ...initial, status: 'final' as const, revision: 1,
    translations: { ...initial.translations, en: 'Hello.' } };
  assert.deepEqual(f.recorder.caption(final), recording);
  assert.deepEqual(readFileSync(recording.path), before);
  const saved = JSON.parse(readFileSync(recording.metadataPath, 'utf8'));
  assert.equal(saved.status, 'final'); assert.equal(saved.translations.en, 'Hello.');
  assert.equal(saved.audio.audioMs, 100); assert.equal(saved.recording.alignment, 'stt-boundary');
  assert.deepEqual(f.recorder.stop(), { files: 1, audioMs: 100 });
});

test('stopping before translation preserves unrecognized and unconsumed source audio', (t) => {
  const f = fixture(t);
  const pcm = Buffer.alloc(4_800, 3);
  f.recorder.audio('source-1', A, pcm);
  assert.deepEqual(f.recorder.stop(), { files: 1, audioMs: 100 });
  const path = join(f.recorder.directory, `${A}_untranslated_source-1.wav`);
  assert.deepEqual(audio(path), pcm);
  f.recorder.audio('source-2', A, Buffer.alloc(4_800));
  assert.deepEqual(f.recorder.stop(), { files: 1, audioMs: 100 });
});

test('unmatched text cannot silently consume unrelated audio or be labeled as an exact boundary', (t) => {
  const f = fixture(t);
  f.recorder.audio('source-1', A, Buffer.alloc(4_800, 3));
  f.recorder.transcript('source-1', A, '실제 원문');
  assert.throws(() => f.recorder.caption(caption(1, '다른 원문')), RecordingError);
  f.recorder.stop();
  assert.ok(readdirSync(f.recorder.directory).some((file) => file.includes('untranslated')));
  assert.ok(!readdirSync(f.recorder.directory).some((file) => file.includes('caption_')));
});
