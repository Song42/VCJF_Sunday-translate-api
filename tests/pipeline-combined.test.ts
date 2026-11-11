import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import { InterpretationError, type InterpretationRequest, type InterpretationResult, type Interpreter } from '../src/interpret.js';
import type { Segmenter } from '../src/segment.js';
import { SttError, type Transcriber } from '../src/stt.js';
import type { Translator, Translations } from '../src/translate.js';
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

function translations(text: string): Translations {
  return { ko: `ko:${text}`, ru: `ru:${text}`, kk: `kk:${text}`, en: `en:${text}` };
}

class FakeInterpreter implements Interpreter {
  readonly calls: InterpretationRequest[] = [];
  readonly pending: ReturnType<typeof deferred<InterpretationResult>>[] = [];
  estimateUsage() { return { inputTokens: 3_000, outputTokens: 2_048 }; }
  interpret(input: InterpretationRequest): Promise<InterpretationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    const request = deferred<InterpretationResult>();
    this.pending.push(request);
    return request.promise;
  }
  answer(index: number, completed: string[], pending = ''): void {
    assert.ok(this.pending[index], `combined request ${index} exists`);
    this.pending[index]!.resolve({
      completed: completed.map((originalText) => ({ originalText, translations: translations(originalText) })),
      pending, inputTokens: 100, outputTokens: 80,
    });
  }
}

type TokenRates = Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; actual?: Usage; rates?: TokenRates }[] = [];
  failTokens = false;
  reserve(maximum: Usage, rates?: TokenRates): UsageReservation {
    if (maximum.inputTokens && this.failTokens) throw new UsageLimitError();
    const entry: { maximum: Usage; actual?: Usage; rates?: TokenRates } = {
      maximum: { ...maximum }, ...(rates ? { rates: { ...rates } } : {}),
    };
    this.reservations.push(entry);
    return { settle: (actual) => { entry.actual = { ...actual }; } };
  }
  snapshot() {
    return { month: '2026-11', estimatedUsd: 0.01, audioMs: 100, inputTokens: 100, outputTokens: 80, limitUsd: 10 };
  }
}

function harness(t: TestContext) {
  const stts: FakeTranscriber[] = [];
  const interpreter = new FakeInterpreter();
  const legacyCalls = { segmentation: 0, translation: 0 };
  // Inject both legacy services to prove combined mode does not accidentally use them.
  const segmenter: Segmenter = {
    estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }),
    segment: async () => { legacyCalls.segmentation += 1; throw new Error('Unexpected separate segmentation'); },
  };
  const translator: Translator = {
    estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }),
    translate: async () => { legacyCalls.translation += 1; throw new Error('Unexpected separate translation'); },
  };
  const usage = new FakeUsage();
  const captions: Caption[] = [];
  const fatal: string[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const pipeline = new LiveTranslationPipeline({
    segmentMs: 4_000, interpreter, segmenter, translator, usage,
    segmentationRates: { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
    createTranscriber: () => { const stt = new FakeTranscriber(); stts.push(stt); return stt; },
    speakerName: (id) => `Speaker ${id}`,
    onCaption: (caption) => captions.push(caption),
    onDiagnostic: (event, fields) => diagnostics.push(fields ? { event, fields } : { event }),
    onFatal: (code) => fatal.push(code), now: () => Date.now(),
  });
  t.after(() => pipeline.stop());
  return { pipeline, stts, interpreter, legacyCalls, usage, captions, fatal, diagnostics };
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
async function audioActivity(h: ReturnType<typeof harness>): Promise<void> {
  // The sound is below the STT minimum, but it still resets real audio silence.
  h.pipeline.push('A', pcm(80));
  h.pipeline.end('A', 'silence');
  await drain();
}

test('combined mode publishes completed translations immediately with one token reservation and no legacy API calls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 4, 20) });
  const h = harness(t);
  await utterance(h, '오늘 모임을 시작합니다.', 'A', 0, 4_000);
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.interpreter.calls[0]?.flush, false);
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
  assert.equal(h.captions.length, 0);
  h.interpreter.answer(0, ['오늘 모임을 시작합니다.']);
  await drain();
  assert.equal(h.captions.length, 1, 'no silence or hold timer needs to advance');
  assert.deepEqual(h.captions[0]?.translations, translations('오늘 모임을 시작합니다.'));
  assert.equal(h.captions[0]?.boundary, 'semantic');
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 1);
  assert.equal(h.captions[0]?.speakerName, 'Speaker A');
  const tokens = h.usage.reservations.filter((entry) => entry.maximum.inputTokens);
  assert.equal(tokens.length, 1, 'the completed unit does not reserve a second translation');
  assert.equal(tokens[0]?.rates, undefined, 'combined work uses the ledger translation rates');
  assert.deepEqual(tokens[0]?.actual, { inputTokens: 100, outputTokens: 80 });
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
  assert.equal(h.stts[0]?.sentBytes.reduce((total, bytes) => total + bytes, 0), 4_000 * 48);
  assert.equal(h.pipeline.recentCaptions().length, 1);
  assert.ok(h.diagnostics.some((entry) => entry.event === 'caption_ready'));
});

test('combined mode emits the completed prefix and preserves the unfinished source for the next request', async (t) => {
  const h = harness(t);
  await utterance(h, '오늘은 창세기를 봅니다. 여기서 아담과 하와.');
  h.interpreter.answer(0, ['오늘은 창세기를 봅니다.'], '여기서 아담과 하와.');
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['오늘은 창세기를 봅니다.']);
  await utterance(h, '어떤 선택을 했는지 살펴봅시다.');
  const combined = '여기서 아담과 하와. 어떤 선택을 했는지 살펴봅시다.';
  assert.equal(h.interpreter.calls[1]?.text, combined);
  assert.deepEqual(h.interpreter.calls[1]?.context, ['오늘은 창세기를 봅니다.']);
  h.interpreter.answer(1, [combined]);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['오늘은 창세기를 봅니다.', combined]);
  assert.equal(h.captions[1]?.sourceSegmentIds?.length, 2);
  assert.equal(h.captions[0]?.sourceSegmentIds?.[0], h.captions[1]?.sourceSegmentIds?.[0]);
  assert.deepEqual(h.captions.map((caption) => caption.sequence), [1, 2]);
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});

test('out-of-order STT results remain ordered per speaker while another speaker can finish independently', async (t) => {
  const h = harness(t);
  await utterance(h, '먼저');
  const second = await commit(h);
  const third = await commit(h);
  third.resolve('살펴봅시다.');
  await drain();
  assert.equal(h.interpreter.calls.length, 1);
  second.resolve('함께');
  await drain();
  assert.equal(h.interpreter.calls.length, 1, 'only one same-speaker request may be active');
  h.interpreter.answer(0, [], '먼저');
  await drain();
  assert.equal(h.interpreter.calls[1]?.text, '먼저 함께 살펴봅시다.');
  await utterance(h, 'Мы уже начали.', 'B', 1);
  assert.deepEqual(h.interpreter.calls[2]?.context, []);
  h.interpreter.answer(2, ['Мы уже начали.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.speakerId), ['B']);
  h.interpreter.answer(1, ['먼저 함께 살펴봅시다.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.speakerId, caption.originalText]), [
    ['B', 'Мы уже начали.'], ['A', '먼저 함께 살펴봅시다.'],
  ]);
  assert.equal(h.captions[1]?.sourceSegmentIds?.length, 3);
  await utterance(h, 'Келесі тақырып.', 'B', 1);
  assert.deepEqual(h.interpreter.calls[3]?.context, ['Мы уже начали.']);
  h.interpreter.answer(3, ['Келесі тақырып.']);
  await drain();
  assert.deepEqual(h.fatal, []);
});

test('an empty transcription does not flush or cancel a combined request', async (t) => {
  const h = harness(t);
  await utterance(h, '첫 문장입니다. 다음 문장입니다.');
  await utterance(h, '');
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.interpreter.calls[0]?.signal.aborted, false);
  h.interpreter.answer(0, ['첫 문장입니다.', '다음 문장입니다.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['첫 문장입니다.', '다음 문장입니다.']);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, h.captions[1]?.sourceSegmentIds);
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, 2);
  assert.ok(h.diagnostics.some((entry) => entry.event === 'transcript_empty'));
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});

test('four seconds of actual audio silence forces only the remaining fragment through the combined API', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 4, 20) });
  const h = harness(t);
  await utterance(h, '말씀드리려던 것은');
  h.interpreter.answer(0, [], '말씀드리려던 것은');
  await drain();
  t.mock.timers.tick(3_000);
  await audioActivity(h);
  t.mock.timers.tick(3_999);
  await drain();
  assert.equal(h.interpreter.calls.length, 1, 'activity resets silence without retriggering unchanged pending text');
  t.mock.timers.tick(1);
  await drain();
  assert.equal(h.interpreter.calls[1]?.flush, true);
  assert.equal(h.interpreter.calls[1]?.text, '말씀드리려던 것은');
  h.interpreter.answer(1, ['말씀드리려던 것은']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['말씀드리려던 것은', 'silence'],
  ]);
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});

test('eight-second pending bound forces a fragment even while new audio keeps arriving', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 4, 20) });
  const h = harness(t);
  await utterance(h, '계속 설명하려는 것은');
  h.interpreter.answer(0, [], '계속 설명하려는 것은');
  await drain();
  t.mock.timers.tick(3_000);
  await audioActivity(h);
  t.mock.timers.tick(3_000);
  await audioActivity(h);
  t.mock.timers.tick(1_999);
  await drain();
  assert.equal(h.interpreter.calls.length, 1);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(h.interpreter.calls[1]?.flush, true);
  h.interpreter.answer(1, ['계속 설명하려는 것은']);
  await drain();
  assert.equal(h.captions[0]?.boundary, 'timeout');
  assert.equal(h.captions[0]?.originalText, '계속 설명하려는 것은');
  assert.deepEqual(h.fatal, []);
});

test('a silence deadline during combined work preserves a complete result without requesting its translation again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 10, 4, 20) });
  const h = harness(t);
  await utterance(h, '이미 완성된 문장입니다.');
  t.mock.timers.tick(4_000);
  await drain();
  assert.equal(h.interpreter.calls[0]?.signal.aborted, false, 'a hold deadline must not discard an in-flight translation');
  assert.equal(h.interpreter.calls.length, 1);
  h.interpreter.answer(0, ['이미 완성된 문장입니다.']);
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['이미 완성된 문장입니다.']);
  assert.equal(h.interpreter.calls.length, 1, 'the deadline cannot double-translate an already completed unit');
  assert.equal(h.usage.reservations.filter((entry) => entry.maximum.inputTokens).length, 1);
});

test('stop aborts combined work and late responses cannot publish or retain captions', async (t) => {
  const h = harness(t);
  await utterance(h, '아직 처리 중인 문장입니다.');
  h.pipeline.stop();
  assert.equal(h.interpreter.calls[0]?.signal.aborted, true);
  h.interpreter.answer(0, ['아직 처리 중인 문장입니다.']);
  await drain();
  assert.equal(h.captions.length, 0);
  assert.deepEqual(h.pipeline.recentCaptions(), []);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});

test('combined authentication failure stops capture before another paid request', async (t) => {
  const h = harness(t);
  await utterance(h, '인증 오류 시험입니다.');
  h.interpreter.pending[0]!.reject(new InterpretationError('interpretation_auth'));
  await drain();
  assert.deepEqual(h.fatal, ['interpretation_auth']);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.equal(h.captions.length, 0);
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.usage.reservations.find((entry) => entry.maximum.inputTokens)?.actual, undefined,
    'failed requests retain their conservative reservation');
  h.pipeline.push('A', pcm(100));
  await drain();
  assert.equal(h.stts.length, 1);
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});

test('the shared budget stops combined inference before the API call begins', async (t) => {
  const h = harness(t);
  h.usage.failTokens = true;
  await utterance(h, '예산 한도 시험입니다.');
  assert.deepEqual(h.fatal, ['api_budget_limit']);
  assert.equal(h.interpreter.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.deepEqual(h.legacyCalls, { segmentation: 0, translation: 0 });
});
