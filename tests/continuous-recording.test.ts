import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { ContinuousCaptionRecorder } from '../src/continuous-recording.js';
import { parseBenchmarkWav } from '../src/audio-benchmark-core.js';
import type { Caption } from '../src/types.js';

test('caption revisions retain one continuous source WAV and an append-only revision history', (t) => {
  const root = resolve('.tools/continuous-recording-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  const recorder = new ContinuousCaptionRecorder({ directory, now: () => 0, onDiagnostic: () => {} });
  t.after(() => { recorder.stop(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const speakerId = '111111111111111111', first = Buffer.alloc(4_800, 1), second = Buffer.alloc(4_800, 2);
  recorder.append(speakerId, first); recorder.sourceAudio('source-1', speakerId, first);
  const base: Caption = { type: 'caption', sequence: 1, segmentId: 'live-1', speakerId, speakerName: 'Test',
    originalText: '시작', sourceSegmentIds: ['source-1'], createdAt: 0, status: 'draft', revision: 0,
    translations: { ko: '시작', ru: 'ru', kk: 'kk', en: 'en' } };
  const recording = recorder.caption(base)!;
  recorder.append(speakerId, second); recorder.sourceAudio('source-2', speakerId, second);
  const final = { ...base, originalText: '시작했습니다.', sourceSegmentIds: ['source-1', 'source-2'], status: 'final' as const, revision: 2 };
  const updated = recorder.caption(final)!;
  assert.equal(updated.path, recording.path); assert.equal(updated.alignment, 'source-turn');
  const summary = recorder.stop(); assert.equal(summary.files, 1);
  assert.deepEqual(parseBenchmarkWav(readFileSync(recording.path)), Buffer.concat([first, second]));
  const history = readFileSync(recording.metadataPath.replace(/\.json$/u, '.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(history.map((entry) => entry.status), ['draft', 'final']);
  assert.equal(JSON.parse(readFileSync(recording.metadataPath, 'utf8')).originalText, '시작했습니다.');
  assert.equal(readdirSync(recorder.directory).filter((file) => file.endsWith('.wav')).length, 1);
});

test('interrupted drafts remain explicitly unfinished while their original audio is preserved', (t) => {
  const root = resolve('.tools/continuous-recording-tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  const recorder = new ContinuousCaptionRecorder({ directory, now: () => 0, onDiagnostic: () => {} });
  t.after(() => { recorder.stop(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const speakerId = '111111111111111111', pcm = Buffer.alloc(4_800, 3);
  recorder.append(speakerId, pcm); recorder.sourceAudio('source-1', speakerId, pcm);
  const recording = recorder.caption({ type: 'caption', sequence: 1, segmentId: 'live-1', speakerId, speakerName: 'Test',
    sourceSegmentIds: ['source-1'], originalText: '제가 아직', createdAt: 0, status: 'draft', revision: 0,
    translations: { ko: '제가 아직', ru: 'ru', kk: 'kk', en: 'I still' } })!;
  recorder.stop();
  const saved = JSON.parse(readFileSync(recording.metadataPath, 'utf8'));
  assert.equal(saved.interrupted, true); assert.equal(saved.status, 'draft');
  assert.deepEqual(parseBenchmarkWav(readFileSync(recording.path)), pcm);
});
