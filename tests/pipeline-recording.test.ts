import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { CaptionAudioRecorder } from '../src/caption-recording.js';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import { parseBenchmarkWav } from '../src/audio-benchmark-core.js';
import type { Caption } from '../src/types.js';

test('the live pipeline records exactly the two GPT translation units from a single audio commit', async (t) => {
  const root = resolve('.tools/pipeline-recording-tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  const recorder = new CaptionAudioRecorder({ directory, now: () => 0, onDiagnostic: () => {} });
  const captions: Caption[] = [];
  const translations: string[] = [];
  const speakerId = '111111111111111111';
  const text = '첫째 문장. 둘째 문장.';
  const pipeline = new LiveTranslationPipeline({ segmentMs: 4_000,
    createTranscriber: () => ({ connect: async () => {}, append: () => {}, commit: async () => text, close: () => {} }),
    segmenter: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }),
      segment: async () => ({ completed: ['첫째 문장.', '둘째 문장.'], pending: '', inputTokens: 10, outputTokens: 10 }) },
    translator: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }),
      translate: async (input) => { translations.push(input.originalText); return { inputTokens: 10, outputTokens: 10,
        translations: { ko: input.originalText, ru: 'Перевод', kk: 'Аударма', en: 'Translation' } }; } },
    usage: { reserve: () => ({ settle: () => {} }), snapshot: () => ({ month: '2026-11', estimatedUsd: 0,
      audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }) },
    speakerName: () => 'Test', onDiagnostic: () => {},
    onSourceAudio: (id, speaker, pcm) => recorder.audio(id, speaker, pcm),
    onSourceTranscript: (id, speaker, source) => recorder.transcript(id, speaker, source),
    onCaption: (caption) => { const recording = recorder.caption(caption); captions.push({ ...caption, ...(recording ? { recording } : {}) }); },
  });
  t.after(() => { pipeline.stop(); recorder.stop(); assert.equal(dirname(directory), root); rmSync(directory, { recursive: true, force: true }); });
  const pcm = Buffer.alloc(48_000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4_000, i);
  pipeline.push(speakerId, pcm); pipeline.end(speakerId, 'silence');
  for (let i = 0; i < 20 && captions.length < 2; i++) await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(translations, ['첫째 문장.', '둘째 문장.']);
  assert.equal(captions.length, 2);
  assert.notEqual(captions[0]?.recording?.path, captions[1]?.recording?.path);
  const clips = captions.map((caption) => parseBenchmarkWav(readFileSync(caption.recording!.path)));
  assert.deepEqual(Buffer.concat(clips), pcm);
  pipeline.stop(); recorder.stop();
  assert.equal(readdirSync(recorder.directory).filter((file) => file.endsWith('.wav')).length, 2);
});
