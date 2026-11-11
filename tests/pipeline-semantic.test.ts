import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import { SegmentationError, type SegmentationRequest, type SegmentationResult, type Segmenter } from '../src/segment.js';
import { SttError, type Transcriber } from '../src/stt.js';
import type { TranslationRequest, TranslationResult, Translator } from '../src/translate.js';
import type { Caption } from '../src/types.js';
import { UsageLimitError, type Usage, type UsageLedger, type UsageRates, type UsageReservation } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeTranscriber implements Transcriber {
  readonly commits: ReturnType<typeof deferred<string>>[] = [];
  readonly sentBytes: number[] = [];
  closed = false;
  async connect(): Promise<void> {}
  append(pcm: Buffer): void {
    assert.equal(this.closed, false);
    this.sentBytes.push(pcm.length);
  }
  commit(): Promise<string> {
    assert.equal(this.closed, false);
    const turn = deferred<string>();
    this.commits.push(turn);
    return turn.promise;
  }
  close(): void {
    this.closed = true;
    for (const turn of this.commits) turn.reject(new SttError('stt_closed'));
  }
}

class FakeSegmenter implements Segmenter {
  readonly calls: SegmentationRequest[] = [];
  readonly pending: ReturnType<typeof deferred<SegmentationResult>>[] = [];
  estimateUsage() { return { inputTokens: 3_000, outputTokens: 1_000 }; }
  segment(input: SegmentationRequest): Promise<SegmentationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    const request = deferred<SegmentationResult>();
    this.pending.push(request);
    return request.promise;
  }
  answer(index: number, completed: string[], pending = ''): void {
    assert.ok(this.pending[index], `segmentation request ${index} exists`);
    this.pending[index]!.resolve({ completed, pending, inputTokens: 100, outputTokens: 20 });
  }
}

class FakeTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];
  readonly pending: ReturnType<typeof deferred<TranslationResult>>[] = [];
  deferFirst = false;
  estimateUsage() { return { inputTokens: 2_000, outputTokens: 2_048 }; }
  async translate(input: TranslationRequest): Promise<TranslationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    if (this.deferFirst && this.calls.length === 1) {
      const request = deferred<TranslationResult>();
      this.pending.push(request);
      return request.promise;
    }
    return translated(input.originalText);
  }
}

function translated(text: string): TranslationResult {
  return { translations: { ko: `ko:${text}`, ru: `ru:${text}`, kk: `kk:${text}`, en: `en:${text}` },
    inputTokens: 100, outputTokens: 50 };
}

type TokenRates = Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; actual?: Usage; rates?: TokenRates }[] = [];
  failSegmentation = false;
  reserve(maximum: Usage, rates?: TokenRates): UsageReservation {
    if (rates && this.failSegmentation) throw new UsageLimitError();
    const entry: { maximum: Usage; actual?: Usage; rates?: TokenRates } = {
      maximum: { ...maximum }, ...(rates ? { rates: { ...rates } } : {}),
    };
    this.reservations.push(entry);
    return { settle: (actual) => { entry.actual = { ...actual }; } };
  }
  snapshot() {
    return { month: '2026-11', estimatedUsd: 0.01, audioMs: 100, inputTokens: 100, outputTokens: 50, limitUsd: 10 };
  }
}

function harness(t: TestContext) {
  const stts: FakeTranscriber[] = [];
  const segmenter = new FakeSegmenter();
  const translator = new FakeTranslator();
  const usage = new FakeUsage();
  const captions: Caption[] = [];
  const fatal: string[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const pipeline = new LiveTranslationPipeline({
    segmentMs: 4_000, segmenter, translator, usage,
    segmentationRates: { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
    createTranscriber: () => { const stt = new FakeTranscriber(); stts.push(stt); return stt; },
    speakerName: (id) => `Speaker ${id}`,
    onCaption: (caption) => captions.push(caption),
    onDiagnostic: (event, fields) => diagnostics.push(fields ? { event, fields } : { event }),
    onFatal: (code) => fatal.push(code),
    now: () => Date.now(),
  });
  t.after(() => pipeline.stop());
  return { pipeline, stts, segmenter, translator, usage, captions, fatal, diagnostics };
}

function pcm(milliseconds: number): Buffer { return Buffer.alloc(milliseconds * 48, 17); }
async function drain(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function commit(h: ReturnType<typeof harness>, speaker = 'A', sttIndex = 0, milliseconds = 100) {
  h.pipeline.push(speaker, pcm(milliseconds));
  h.pipeline.end(speaker, 'silence');
  await drain();
  const turn = h.stts[sttIndex]?.commits.at(-1);
  assert.ok(turn);
  return turn;
}
async function utterance(h: ReturnType<typeof harness>, text: string, speaker = 'A', sttIndex = 0, milliseconds = 100) {
  (await commit(h, speaker, sttIndex, milliseconds)).resolve(text);
  await drain();
}

test('semantic stage holds an artificial period at an audio limit and translates only the completed combination', async (t) => {
  const h = harness(t);
  await utterance(h, '여기서 아담과 하와.', 'A', 0, 4_000);
  assert.equal(h.segmenter.calls[0]?.text, '여기서 아담과 하와.');
  assert.equal(h.translator.calls.length, 0);
  h.segmenter.answer(0, [], '여기서 아담과 하와.');
  await drain();
  assert.equal(h.captions.length, 0);
  await utterance(h, '왜 선악과를 먹었는지 살펴봅시다.');
  const combined = '여기서 아담과 하와. 왜 선악과를 먹었는지 살펴봅시다.';
  assert.equal(h.segmenter.calls[1]?.text, combined);
  h.segmenter.answer(1, [combined]);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), [combined]);
  assert.equal(h.captions[0]?.boundary, 'semantic');
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 2);
  assert.equal(h.translator.calls.length, 1);
  assert.deepEqual(h.usage.reservations.filter((entry) => entry.maximum.audioMs)
    .map((entry) => entry.actual?.audioMs), [4_000, 100]);
  assert.equal(h.stts[0]?.sentBytes.reduce((sum, bytes) => sum + bytes, 0), 4_100 * 48);
});

test('a complete sentence is translated while the semantic trailing fragment stays pending', async (t) => {
  const h = harness(t);
  await utterance(h, '오늘은 창세기를 봅니다. 여기서 아담과 하와.');
  h.segmenter.answer(0, ['오늘은 창세기를 봅니다.'], '여기서 아담과 하와.');
  await drain();
  assert.deepEqual(h.translator.calls.map((call) => call.originalText), ['오늘은 창세기를 봅니다.']);
  await utterance(h, '어떤 선택을 했는지 살펴봅시다.');
  assert.equal(h.segmenter.calls[1]?.text, '여기서 아담과 하와. 어떤 선택을 했는지 살펴봅시다.');
  h.segmenter.answer(1, [h.segmenter.calls[1]!.text]);
  await drain();
  assert.equal(h.captions.length, 2);
  assert.deepEqual(h.translator.calls[1]?.context, ['오늘은 창세기를 봅니다.']);
});

test('out-of-order STT finals coalesce behind a pending semantic request without losing text', async (t) => {
  const h = harness(t);
  await utterance(h, '먼저');
  const second = await commit(h);
  const third = await commit(h);
  third.resolve('살펴봅시다.');
  second.resolve('함께');
  await drain();
  assert.equal(h.segmenter.calls.length, 1);
  h.segmenter.answer(0, [], '먼저');
  await drain();
  assert.equal(h.segmenter.calls.length, 2);
  assert.equal(h.segmenter.calls[1]?.text, '먼저 함께 살펴봅시다.');
  h.segmenter.answer(1, ['먼저 함께 살펴봅시다.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['먼저 함께 살펴봅시다.']);
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 3);
  assert.equal(h.usage.reservations.filter((entry) => entry.maximum.audioMs).length, 3);
  assert.equal(h.usage.reservations.filter((entry) => entry.rates).length, 2);
});

test('an empty STT tail does not abort or flush the preceding semantic request', async (t) => {
  const h = harness(t);
  await utterance(h, '첫 문장입니다. 다음 문장도 완성됐습니다.');
  assert.equal(h.segmenter.calls.length, 1);
  await utterance(h, '');
  assert.equal(h.segmenter.calls[0]?.signal.aborted, false);
  assert.equal(h.segmenter.calls.length, 1);
  assert.equal(h.translator.calls.length, 0, 'an empty tail must not force premature fallback');
  assert.equal(h.captions.length, 0);
  h.segmenter.answer(0, ['첫 문장입니다.', '다음 문장도 완성됐습니다.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['첫 문장입니다.', 'semantic'], ['다음 문장도 완성됐습니다.', 'semantic'],
  ]);
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 1);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, h.captions[1]?.sourceSegmentIds);
  assert.ok(h.diagnostics.some((entry) => entry.event === 'transcript_empty'));
});

test('semantic requests preserve speaker isolation and ordered multi-sentence captions', async (t) => {
  const h = harness(t);
  await utterance(h, '첫 문장입니다. 다음 문장입니다.');
  await utterance(h, 'Мы уже начали.', 'B', 1);
  assert.equal(h.segmenter.calls.length, 2);
  h.segmenter.answer(1, ['Мы уже начали.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.speakerId), ['B']);
  h.segmenter.answer(0, ['첫 문장입니다.', '다음 문장입니다.']);
  await drain();
  assert.deepEqual(h.captions.filter((caption) => caption.speakerId === 'A')
    .map((caption) => caption.originalText), ['첫 문장입니다.', '다음 문장입니다.']);
  assert.deepEqual(h.translator.calls.map((call) => call.context), [[], [], ['첫 문장입니다.']]);
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, 3);
});

test('stop aborts semantic work and a late model reply cannot start translation', async (t) => {
  const h = harness(t);
  await utterance(h, '아직 처리 중인 문장입니다.');
  h.pipeline.stop();
  assert.equal(h.segmenter.calls[0]?.signal.aborted, true);
  h.segmenter.answer(0, ['아직 처리 중인 문장입니다.']);
  await drain();
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.deepEqual(h.pipeline.recentCaptions(), []);
  assert.ok(h.stts.every((stt) => stt.closed));
});

test('new audio activity resets the default four-second silence deadline independently of held transcript age', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 4, 20) });
  const h = harness(t);
  await utterance(h, '말씀드리려던 것은');
  h.segmenter.answer(0, [], '말씀드리려던 것은');
  await drain();
  t.mock.timers.tick(3_000);
  // A short received sound is below the STT commit minimum but is still audio activity.
  h.pipeline.push('A', pcm(80));
  h.pipeline.end('A', 'silence');
  await drain();
  t.mock.timers.tick(3_999);
  await drain();
  assert.equal(h.translator.calls.length, 0);
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['말씀드리려던 것은', 'silence'],
  ]);
  assert.equal(h.segmenter.calls.length, 1, 'silence does not repeatedly call the model on unchanged text');
});

test('segmentation is reserved and settled at its own rates before normal translation billing', async (t) => {
  const h = harness(t);
  await utterance(h, '완성된 문장입니다.');
  assert.equal(h.usage.reservations.length, 2);
  assert.deepEqual(h.usage.reservations[1]?.rates, { inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
  assert.equal(h.usage.reservations[1]?.actual, undefined);
  h.segmenter.answer(0, ['완성된 문장입니다.']);
  await drain();
  assert.deepEqual(h.usage.reservations[0]?.actual, { audioMs: 100 });
  assert.deepEqual(h.usage.reservations[1]?.actual, { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(h.usage.reservations[2]?.actual, { inputTokens: 100, outputTokens: 50 });
  assert.equal(h.usage.reservations[2]?.rates, undefined);
});

test('fatal segmentation authentication failure stops capture before translation', async (t) => {
  const h = harness(t);
  await utterance(h, '번역하면 안 되는 대기 문장입니다.');
  h.segmenter.pending[0]!.reject(new SegmentationError('segmentation_auth'));
  await drain();
  assert.deepEqual(h.fatal, ['segmentation_auth']);
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.equal(h.usage.reservations[1]?.actual, undefined, 'unknown billed usage remains reserved');
});

test('segmentation budget exhaustion stops before any model or translation request', async (t) => {
  const h = harness(t);
  h.usage.failSegmentation = true;
  await utterance(h, '예산 한도 시험 문장입니다.');
  assert.deepEqual(h.fatal, ['api_budget_limit']);
  assert.equal(h.segmenter.calls.length, 0);
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.ok(h.stts.every((stt) => stt.closed));
});

test('a model rewrite is rejected and fallback preserves the literal transcript', async (t) => {
  const h = harness(t);
  await utterance(h, '원래 발언 그대로.');
  h.segmenter.answer(0, ['모델이 꾸며낸 발언.']);
  await drain();
  assert.deepEqual(h.translator.calls.map((call) => call.originalText), ['원래 발언 그대로.']);
  assert.equal(h.captions[0]?.boundary, 'fallback');
  assert.ok(h.diagnostics.some((entry) => entry.fields?.code === 'segmentation_invalid_response'));
});

test('a 64-sentence semantic result coalesces translation backlog without losing or repeating speech', async (t) => {
  const h = harness(t);
  h.translator.deferFirst = true;
  const sentences = Array.from({ length: 64 }, (_, index) => `Sentence ${index + 1}.`);
  await utterance(h, sentences.join(' '));
  h.segmenter.answer(0, sentences);
  await drain();
  assert.equal(h.translator.calls.length, 1, 'later jobs wait behind the first same-speaker translation');
  assert.equal(h.captions.length, 0);
  assert.deepEqual(h.fatal, []);
  const continuation = 'One more sentence from a different audio segment.';
  await utterance(h, continuation);
  h.segmenter.answer(1, [continuation]);
  await drain();
  assert.ok(h.diagnostics.some((entry) => entry.event === 'translation_coalesced'
    && typeof entry.fields?.sequence === 'number' && typeof entry.fields?.intoSequence === 'number'));
  h.translator.pending[0]!.resolve(translated(sentences[0]!));
  await drain();
  assert.equal(h.captions.map((caption) => caption.originalText).join(' '), [...sentences, continuation].join(' '));
  assert.equal(h.translator.calls.length, 13, 'one active and twelve queued requests bound the short-sentence burst');
  assert.ok(h.translator.calls.every((call) => call.originalText.length <= 8_000));
  assert.equal(h.captions.at(-1)?.boundary, 'limit');
  assert.equal(h.captions.at(-1)?.sourceSegmentIds?.length, 2, 'coalescing retains both contributing audio segments');
  assert.equal(h.captions.at(-1)?.sequence, 13, 'the merged job retains its first sequence');
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, h.captions.length);
  assert.deepEqual(h.fatal, []);
  assert.ok(!h.diagnostics.some((entry) => entry.event === 'translation_backpressure'));
});

test('exhausting the bounded translation backlog stops explicitly instead of silently dropping sentences', async (t) => {
  const h = harness(t);
  h.translator.deferFirst = true;
  for (let index = 0; index < 26; index += 1) {
    // Two such sentences cannot fit in a single 8000-character translation request.
    const sentence = `Sentence ${index + 1}: `.padEnd(3_999, 'x') + '.';
    await utterance(h, sentence);
    h.segmenter.answer(index, [sentence]);
    await drain();
  }
  assert.deepEqual(h.fatal, ['translation_backpressure']);
  assert.equal(h.translator.calls.length, 1);
  assert.equal(h.translator.calls[0]?.signal.aborted, true);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.ok(h.diagnostics.some((entry) => entry.event === 'translation_backpressure'));
  assert.ok(h.diagnostics.some((entry) => entry.event === 'pipeline_error' && entry.fields?.code === 'translation_backpressure'));
  h.translator.pending[0]!.resolve(translated(h.translator.calls[0]!.originalText));
  await drain();
  assert.equal(h.captions.length, 0, 'a reply after fatal shutdown cannot revive queued captions');
});
