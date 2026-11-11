import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline, type PipelineOptions } from '../src/pipeline.js';
import { SttError, type Transcriber } from '../src/stt.js';
import type { TranslationRequest, TranslationResult, Translator } from '../src/translate.js';
import type { Caption } from '../src/types.js';
import { UsageLimitError, type Usage, type UsageLedger, type UsageReservation } from '../src/usage.js';

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
  settlePendingOnClose = true;

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
    if (this.settlePendingOnClose) for (const turn of this.commits) turn.reject(new SttError('stt_closed'));
  }
}

class FakeTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];
  readonly pending: ReturnType<typeof deferred<TranslationResult>>[] = [];
  defer = false;
  estimateUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: 2_000, outputTokens: 2_048 };
  }
  async translate(input: TranslationRequest): Promise<TranslationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    if (this.defer) {
      const pending = deferred<TranslationResult>();
      this.pending.push(pending);
      return pending.promise;
    }
    return translation(input.originalText);
  }
}

function translation(text: string): TranslationResult {
  return {
    translations: { ko: `ko:${text}`, ru: `ru:${text}`, kk: `kk:${text}`, en: `en:${text}` },
    inputTokens: 100, outputTokens: 50,
  };
}

class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; actual?: Usage }[] = [];
  failTranslation = false;
  reserve(maximum: Usage): UsageReservation {
    if (maximum.inputTokens && this.failTranslation) throw new UsageLimitError();
    const entry: { maximum: Usage; actual?: Usage } = { maximum: { ...maximum } };
    this.reservations.push(entry);
    return { settle: (actual) => { entry.actual = { ...actual }; } };
  }
  snapshot() {
    return { month: '2026-11', estimatedUsd: 0.01, audioMs: 100, inputTokens: 100, outputTokens: 50, limitUsd: 10 };
  }
}

function harness(t: TestContext, options: Pick<PipelineOptions, 'captionHoldMs' | 'idleSessionMs'> = {}) {
  let now = Date.UTC(2026, 10, 4, 20);
  const stts: FakeTranscriber[] = [];
  const translator = new FakeTranslator();
  const usage = new FakeUsage();
  const captions: Caption[] = [];
  const fatal: string[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const pipeline = new LiveTranslationPipeline({
    ...options,
    segmentMs: 10_000,
    createTranscriber: () => {
      const stt = new FakeTranscriber();
      stts.push(stt);
      return stt;
    },
    translator, usage,
    speakerName: (id) => `Speaker ${id}`,
    onCaption: (caption) => captions.push(caption),
    onDiagnostic: (event, fields) => diagnostics.push(fields ? { event, fields } : { event }),
    onFatal: (code) => fatal.push(code),
    now: () => now,
  });
  t.after(() => pipeline.stop());
  return { pipeline, stts, translator, usage, captions, diagnostics, fatal, advance: (ms: number) => { now += ms; } };
}

function pcm(milliseconds: number): Buffer {
  return Buffer.alloc(milliseconds * 48, 17);
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function commit(h: ReturnType<typeof harness>, speaker = 'A', sttIndex = 0, milliseconds = 100) {
  h.pipeline.push(speaker, pcm(milliseconds));
  h.pipeline.end(speaker, 'silence');
  await drain();
  const turn = h.stts[sttIndex]?.commits.at(-1);
  assert.ok(turn);
  return turn;
}

async function utterance(h: ReturnType<typeof harness>, text: string, speaker = 'A', sttIndex = 0) {
  const turn = await commit(h, speaker, sttIndex);
  turn.resolve(text);
  await drain();
}

test('a pause inside an unfinished sentence waits for the next finalized turn', async (t) => {
  const h = harness(t);
  await utterance(h, '왜 하나님이');
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.pipeline.recentCaptions().length, 0);

  await utterance(h, '아담과 하와에게 선택하게 하셨을까요?');
  assert.deepEqual(h.translator.calls.map((call) => call.originalText), [
    '왜 하나님이 아담과 하와에게 선택하게 하셨을까요?',
  ]);
  assert.equal(h.captions[0]?.boundary, 'sentence');
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 2);
  assert.equal(h.stts.length, 1);
  assert.equal(h.stts[0]?.commits.length, 2);
});

test('a ten-second audio cut rejoins the sentence without retranscribing or rebilling audio', async (t) => {
  const h = harness(t);
  for (let index = 0; index < 105; index += 1) {
    h.pipeline.push('A', pcm(100));
    await drain();
  }
  assert.equal(h.stts[0]?.commits.length, 1);
  h.stts[0]!.commits[0]!.resolve('왜 하나님이');
  await drain();
  assert.equal(h.translator.calls.length, 0);
  h.pipeline.end('A', 'silence');
  await drain();
  h.stts[0]!.commits[1]!.resolve('아담과 하와에게 그렇게 하셨을까요?');
  await drain();

  assert.deepEqual(h.captions.map((caption) => caption.originalText), [
    '왜 하나님이 아담과 하와에게 그렇게 하셨을까요?',
  ]);
  assert.equal(h.translator.calls.length, 1);
  assert.equal(h.stts[0]?.sentBytes.reduce((total, bytes) => total + bytes, 0), 10_500 * 48);
  assert.deepEqual(h.usage.reservations.filter((entry) => entry.maximum.audioMs)
    .map((entry) => entry.actual?.audioMs), [10_000, 500]);
  assert.equal(h.usage.reservations.filter((entry) => entry.maximum.inputTokens).length, 1);
});

test('same-speaker final results are assembled in commit order even when completed out of order', async (t) => {
  const h = harness(t);
  const first = await commit(h);
  const second = await commit(h);
  second.resolve('말씀을 살펴보겠습니다.');
  await drain();
  assert.equal(h.translator.calls.length, 0);
  first.resolve('첫 문장입니다. 이어서');
  await drain();

  assert.deepEqual(h.translator.calls.map((call) => call.originalText), [
    '첫 문장입니다.', '이어서 말씀을 살펴보겠습니다.',
  ]);
  assert.deepEqual(h.translator.calls[1]?.context, ['첫 문장입니다.']);
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 1);
  assert.equal(h.captions[1]?.sourceSegmentIds?.length, 2);
});

test('a completed sentence is published while its unfinished following sentence remains held', async (t) => {
  const h = harness(t);
  await utterance(h, '첫 문장입니다. 그런데 왜');
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['첫 문장입니다.']);
  const second = await commit(h);
  assert.equal(h.translator.calls.length, 1);
  second.resolve('이런 일이 있었을까요?');
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.originalText), [
    '첫 문장입니다.', '그런데 왜 이런 일이 있었을까요?',
  ]);
});

test('unfinished text and sentence order are isolated between speakers', async (t) => {
  const h = harness(t);
  await utterance(h, '오늘 우리는');
  await utterance(h, 'Сейчас мы поговорим.', 'B', 1);
  assert.deepEqual(h.captions.map((caption) => [caption.speakerId, caption.originalText]), [
    ['B', 'Сейчас мы поговорим.'],
  ]);
  await utterance(h, '함께 배웁니다.');
  assert.deepEqual(h.captions.map((caption) => [caption.speakerId, caption.originalText]), [
    ['B', 'Сейчас мы поговорим.'], ['A', '오늘 우리는 함께 배웁니다.'],
  ]);
  assert.deepEqual(h.translator.calls[1]?.context, []);
});

test('a failed turn creates a gap instead of attaching later speech to an incomplete sentence', async (t) => {
  const h = harness(t);
  await utterance(h, '이 설명은');
  const failed = await commit(h);
  const later = await commit(h);
  later.resolve('다음 주제로 넘어갑니다.');
  await drain();
  assert.equal(h.translator.calls.length, 0);
  failed.reject(new SttError('stt_transcription_failed'));
  await drain();

  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['이 설명은', 'gap'], ['다음 주제로 넘어갑니다.', 'sentence'],
  ]);
  assert.equal(h.stts[0]?.closed, false);
  assert.equal(h.captions[0]?.sourceSegmentIds?.length, 1);
  assert.equal(h.captions[1]?.sourceSegmentIds?.length, 1);
});

test('stop discards held fragments and ignores late transcription and timeout callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await utterance(h, '아직 끝나지 않은');
  const late = await commit(h);
  h.stts[0]!.settlePendingOnClose = false;
  h.pipeline.stop();
  late.resolve('문장입니다.');
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.equal(h.pipeline.recentCaptions().length, 0);
  assert.ok(h.stts.every((stt) => stt.closed));
});

test('the bounded wait publishes a raw fragment without inventing punctuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await utterance(h, '그 이유를 설명하자면');
  t.mock.timers.tick(11_999);
  await drain();
  assert.equal(h.translator.calls.length, 0);
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['그 이유를 설명하자면', 'timeout'],
  ]);
  t.mock.timers.tick(12_000);
  await drain();
  assert.equal(h.translator.calls.length, 1);
});

test('the STT session retains context over a ten-second pause and closes after sixty idle seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await utterance(h, '하와에 관해 알아보겠습니다.');
  t.mock.timers.tick(10_001);
  h.advance(10_001);
  await drain();
  assert.equal(h.stts[0]?.closed, false);
  await utterance(h, '그녀는 어떤 선택을 했을까요?');
  assert.equal(h.stts.length, 1);
  assert.equal(h.stts[0]?.commits.length, 2);
  assert.deepEqual(h.translator.calls[1]?.context, ['하와에 관해 알아보겠습니다.']);
  t.mock.timers.tick(59_999);
  await drain();
  assert.equal(h.stts[0]?.closed, false);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(h.stts[0]?.closed, true);
});

test('longer idle retention still evicts an idle session at the three-speaker cap', async (t) => {
  const h = harness(t);
  await utterance(h, '마쳤습니다.');
  h.pipeline.push('B', pcm(100));
  h.pipeline.push('C', pcm(100));
  await drain();
  assert.equal(h.stts.filter((stt) => !stt.closed).length, 3);
  h.pipeline.push('D', pcm(100));
  await drain();
  assert.equal(h.stts[0]?.closed, true);
  assert.equal(h.stts.length, 4);
  assert.equal(h.stts.filter((stt) => !stt.closed).length, 3);
  assert.equal(h.stts[3]?.sentBytes.length, 1);
  assert.ok(!h.diagnostics.some((entry) => entry.event === 'stt_capacity'));
});

test('one transcript can publish distinct sentence IDs, each translated exactly once', async (t) => {
  const h = harness(t);
  const turn = await commit(h, 'A', 0, 500);
  turn.resolve('첫 문장입니다. 다음 문장입니다!');
  await drain();
  const recent = h.pipeline.recentCaptions();
  assert.deepEqual(recent.map((caption) => caption.originalText), ['첫 문장입니다.', '다음 문장입니다!']);
  assert.equal(new Set(recent.map((caption) => caption.segmentId)).size, 2);
  assert.equal(new Set(recent.map((caption) => caption.sequence)).size, 2);
  assert.equal(recent[0]?.sourceSegmentIds?.length, 1);
  assert.deepEqual(recent[0]?.sourceSegmentIds, recent[1]?.sourceSegmentIds);
  assert.equal(h.stts[0]?.commits.length, 1);
  assert.deepEqual(h.usage.reservations.filter((entry) => entry.maximum.audioMs)
    .map((entry) => entry.actual?.audioMs), [500]);
  assert.equal(h.usage.reservations.filter((entry) => entry.maximum.inputTokens).length, 2);
  for (let index = 0; index < 20; index += 1) h.pipeline.recentCaptions();
  assert.equal(h.translator.calls.length, 2);
  recent[0]!.sourceSegmentIds![0] = 'tampered';
  assert.notEqual(h.pipeline.recentCaptions()[0]?.sourceSegmentIds?.[0], 'tampered');
  h.captions[0]!.sourceSegmentIds![0] = 'callback-tampered';
  assert.notEqual(h.pipeline.recentCaptions()[0]?.sourceSegmentIds?.[0], 'callback-tampered');
});

test('caption assembly diagnostics expose boundaries without recording speech', async (t) => {
  const h = harness(t);
  await utterance(h, '비공개 발언을 로그에 기록하면 안 됩니다.');
  const encoded = JSON.stringify(h.diagnostics);
  assert.ok(!encoded.includes('비공개 발언'));
  assert.ok(!encoded.includes('ko:'));
  assert.ok(h.diagnostics.some((entry) => entry.event === 'caption_segment_ready' && entry.fields?.boundary === 'sentence'));
});

test('translation preserves each speaker order while another speaker can complete independently', async (t) => {
  const h = harness(t);
  h.translator.defer = true;
  await utterance(h, '첫 번째 문장입니다. 두 번째 문장입니다.');
  assert.deepEqual(h.translator.calls.map((call) => call.originalText), ['첫 번째 문장입니다.']);
  await utterance(h, 'Другой человек говорит.', 'B', 1);
  assert.equal(h.translator.calls.length, 2);
  h.translator.pending[1]!.resolve(translation('Другой человек говорит.'));
  await drain();
  assert.deepEqual(h.captions.map((caption) => caption.speakerId), ['B']);
  h.translator.pending[0]!.resolve(translation('첫 번째 문장입니다.'));
  await drain();
  assert.equal(h.translator.calls[2]?.originalText, '두 번째 문장입니다.');
  assert.deepEqual(h.translator.calls[2]?.context, ['첫 번째 문장입니다.']);
  h.translator.pending[2]!.resolve(translation('두 번째 문장입니다.'));
  await drain();
  assert.deepEqual(h.captions.filter((caption) => caption.speakerId === 'A')
    .map((caption) => caption.originalText), ['첫 번째 문장입니다.', '두 번째 문장입니다.']);
});

test('a fatal STT error discards a held fragment before closing the session', async (t) => {
  const h = harness(t);
  await utterance(h, '완성되지 않은');
  const failed = await commit(h);
  failed.reject(new SttError('stt_auth'));
  await drain();
  assert.deepEqual(h.fatal, ['stt_auth']);
  assert.equal(h.translator.calls.length, 0);
  assert.equal(h.captions.length, 0);
  assert.equal(h.stts[0]?.closed, true);
});

test('a budget failure while evicting a held fragment cannot open a replacement STT session', async (t) => {
  const h = harness(t);
  await utterance(h, '아직 끝나지 않은');
  await utterance(h, '두 번째 화자입니다.', 'B', 1);
  await utterance(h, '세 번째 화자입니다.', 'C', 2);
  const captionCount = h.captions.length;
  const translationCount = h.translator.calls.length;
  h.usage.failTranslation = true;
  h.pipeline.push('D', pcm(100));
  await drain();
  assert.deepEqual(h.fatal, ['api_budget_limit']);
  assert.equal(h.stts.length, 3);
  assert.ok(h.stts.every((stt) => stt.closed));
  assert.equal(h.captions.length, captionCount);
  assert.equal(h.translator.calls.length, translationCount);
  assert.equal(h.pipeline.recentCaptions().length, 0);
});
