import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import type { TranscriptionPartial } from '../src/stt.js';
import type { Caption } from '../src/types.js';

const drain = async () => { for (let turn = 0; turn < 8; turn++) await new Promise<void>((done) => setImmediate(done)); };
function punctuationHarness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  let partial: ((event: TranscriptionPartial) => void) | undefined;
  const commits: { resolve: (text: string) => void }[] = [];
  const captions: Caption[] = [];
  const diagnostics: string[] = [];
  let appendedBytes = 0;
  const pipeline = new LiveTranslationPipeline({ segmentMs: 5_000, streamingCaptions: true, speechSilenceMs: 2_000,
    createTranscriber: () => ({ connect: async () => {}, append: (pcm) => { appendedBytes += pcm.length; }, close: () => {},
      setPartialHandler: (handler) => { partial = handler; }, commit: () => new Promise<string>((resolve) => commits.push({ resolve })) }),
    translator: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), translate: async (input) => ({
      inputTokens: 10, outputTokens: 10, translations: { ko: input.originalText, ru: 'ru', kk: 'kk', en: 'en' } }) },
    segmenter: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), segment: async (input) => ({ completed: [], pending: input.text, inputTokens: 10, outputTokens: 10 }) },
    usage: { reserve: () => ({ settle: () => {} }), snapshot: () => ({ month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }) },
    speakerName: () => 'Test', onDiagnostic: (event) => diagnostics.push(event), onCaption: (caption) => captions.push(caption),
  });
  t.after(() => pipeline.stop());
  const speech = Buffer.alloc(24_000); for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(2_000, offset);
  const push = async () => { pipeline.push('A', speech); await drain(); };
  return { pipeline, push, commits, captions, diagnostics, partial: (event: TranscriptionPartial) => partial!(event), appended: () => appendedBytes };
}

test('punctuation commits streaming STT early, waits for final text, and leaves subsequent audio intact', async (t) => {
  const h = punctuationHarness(t); await h.push();
  h.partial({ itemId: 'first', text: '첫 문장입니다.' }); await drain();
  assert.equal(h.commits.length, 1);
  assert.equal(h.captions.some(caption => caption.status === 'final'), false);
  assert.equal(h.diagnostics.filter(event => event === 'stt_early_commit').length, 1);
  await h.push();
  h.partial({ itemId: 'first', commitIndex: 1, text: '첫 문장입니다.' }); await drain();
  assert.equal(h.commits.length, 1, 'a late partial for the first commit must not end the second audio segment');
  h.commits[0]!.resolve('첫 문장입니다.'); await drain();
  assert.equal(h.captions.filter(caption => caption.status === 'final')[0]?.originalText, '첫 문장입니다.');
  h.partial({ itemId: 'second', text: '두 번째 문장입니다.' }); await drain();
  assert.equal(h.commits.length, 2);
  h.commits[1]!.resolve('두 번째 문장입니다.'); await drain();
  assert.deepEqual(h.captions.filter(caption => caption.status === 'final').map(caption => caption.originalText), ['첫 문장입니다.', '두 번째 문장입니다.']);
  assert.equal(h.appended(), 48_000, 'each audio byte is appended once');
});

test('a provisional period removed by final STT does not finalize until two seconds of silence', async (t) => {
  const h = punctuationHarness(t); await h.push();
  h.partial({ itemId: 'first', text: '말씀을 전합니다.' }); await drain();
  h.commits[0]!.resolve('말씀을 전하고'); await drain();
  assert.equal(h.captions.some(caption => caption.status === 'final'), false);
  t.mock.timers.tick(1_999); await drain();
  assert.equal(h.captions.some(caption => caption.status === 'final'), false);
  t.mock.timers.tick(1); await drain();
  assert.equal(h.captions.at(-1)?.status, 'final');
  assert.equal(h.captions.at(-1)?.originalText, '말씀을 전하고');
  assert.equal(h.commits.length, 1, 'silence must not recommit an already closed audio segment');
});

test('final STT tail after a delayed period becomes the next caption and silence flushes the unfinished tail', async (t) => {
  const h = punctuationHarness(t); await h.push();
  h.partial({ itemId: 'first', text: '첫 문장입니다.' }); await drain();
  h.commits[0]!.resolve('첫 문장입니다. 다음 이야기는'); await drain();
  assert.deepEqual(h.captions.filter(caption => caption.status === 'final').map(caption => caption.originalText), ['첫 문장입니다.']);
  t.mock.timers.tick(2_000); await drain();
  assert.deepEqual(h.captions.filter(caption => caption.status === 'final').map(caption => caption.originalText), ['첫 문장입니다.', '다음 이야기는']);
});

test('ambiguous dots do not repeatedly commit streaming audio', async (t) => {
  const h = punctuationHarness(t); await h.push();
  for (const text of ['Dr.', '3.14', '잠시...', '2026 г.', 'мысалы т.б.']) h.partial({ itemId: 'first', text });
  await drain();
  assert.equal(h.commits.length, 0);
  assert.equal(h.diagnostics.includes('stt_early_commit'), false);
});

test('quiet packets and the Discord stream end do not finalize speech before two seconds of silence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  let partial: ((event: TranscriptionPartial) => void) | undefined, commits = 0;
  const captions: Caption[] = [];
  const pipeline = new LiveTranslationPipeline({ segmentMs: 5_000, streamingCaptions: true, speechSilenceMs: 2_000,
    createTranscriber: () => ({ connect: async () => {}, append: () => {}, close: () => {},
      setPartialHandler: (handler) => { partial = handler; }, commit: async () => { commits++; return '번역을 시작했습니다.'; } }),
    translator: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), translate: async (input) => ({
      inputTokens: 10, outputTokens: 10, translations: { ko: input.originalText, ru: 'ru', kk: 'kk', en: 'en' } }) },
    segmenter: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), segment: async (input) => ({ completed: [], pending: input.text, inputTokens: 10, outputTokens: 10 }) },
    usage: { reserve: () => ({ settle: () => {} }), snapshot: () => ({ month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }) },
    speakerName: () => 'Test', onDiagnostic: () => {}, onCaption: (caption) => captions.push(caption),
  });
  t.after(() => pipeline.stop());
  const speech = Buffer.alloc(4_800); for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(2_000, offset);
  pipeline.push('A', speech); await new Promise<void>((done) => setImmediate(done));
  partial!({ itemId: 'item-1', text: '번역을 시작' });
  pipeline.end('A', 'silence');
  assert.equal(commits, 0);
  t.mock.timers.tick(1_000); await new Promise<void>((done) => setImmediate(done));
  assert.equal(captions[0]?.status, 'draft');
  pipeline.push('A', Buffer.alloc(4_800)); // Packets exist, but contain no speech.
  t.mock.timers.tick(999); assert.equal(commits, 0);
  t.mock.timers.tick(1);
  for (let turn = 0; turn < 10; turn++) await new Promise<void>((done) => setImmediate(done));
  assert.equal(commits, 1);
  assert.equal(captions.at(-1)?.status, 'final');
  assert.equal(captions.at(-1)?.sequence, captions[0]?.sequence);
  assert.equal(captions.at(-1)?.originalText, '번역을 시작했습니다.');
});
