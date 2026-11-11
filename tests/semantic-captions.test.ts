import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { SemanticCaptionAssembler } from '../src/semantic-captions.js';
import { SegmentationError, type SegmentationRequest, type SegmentationResult, type Segmenter } from '../src/segment.js';
import type { AssembledCaption } from '../src/caption-assembler.js';
import { UsageLimitError, UsageStorageError, type Usage, type UsageLedger, type UsageRates, type UsageReservation } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeSegmenter implements Segmenter {
  readonly calls: SegmentationRequest[] = [];
  readonly gates: ReturnType<typeof deferred<SegmentationResult>>[] = [];
  estimateUsage() { return { inputTokens: 5_000, outputTokens: 5_000 }; }
  segment(input: SegmentationRequest): Promise<SegmentationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    const gate = deferred<SegmentationResult>();
    this.gates.push(gate);
    return gate.promise;
  }
}

class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; rates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>; actual?: Usage }[] = [];
  failReserve = false;
  failSettle = false;
  reserve(maximum: Usage, rates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>): UsageReservation {
    if (this.failReserve) throw new UsageLimitError();
    const entry = { maximum, ...(rates ? { rates } : {}) } as typeof this.reservations[number];
    this.reservations.push(entry);
    return { settle: (actual) => {
      if (this.failSettle) throw new UsageStorageError('write_failed');
      entry.actual = actual;
    } };
  }
  snapshot() { return { month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }; }
}

async function drain(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('a late negation rechecks the expanded source before releasing a misleading assertion', async (t) => {
  const h = harness(t);
  h.accept('하고 싶을 때만 하는 일입니다.');
  h.accept('아니라 명령입니다.');
  await h.resolve(0, ['하고 싶을 때만 하는 일입니다.']);
  assert.equal(h.captions.length, 0);
  assert.equal(h.segmenter.calls.length, 2);
  await h.resolve(1, ['하고 싶을 때만 하는 일입니다. 아니라 명령입니다.']);
  assert.equal(h.captions.length, 1);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, ['source-1', 'source-2']);
});

function harness(t: TestContext, options: { stopOnCaption?: boolean; silenceMs?: number; maxHoldMs?: number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  const segmenter = new FakeSegmenter();
  const usage = new FakeUsage();
  const captions: AssembledCaption[] = [];
  const errors: unknown[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const assembler = new SemanticCaptionAssembler({ segmenter, usage,
    silenceMs: options.silenceMs ?? 10_000, maxHoldMs: options.maxHoldMs ?? 30_000,
    segmentationRates: { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
    onCaption: (caption) => { captions.push(caption); if (options.stopOnCaption) assembler.stop(); },
    onError: (error) => errors.push(error),
    onDiagnostic: (event, fields) => diagnostics.push(fields ? { event, fields } : { event }),
  });
  t.after(() => assembler.stop());
  let sequence = 0;
  const accept = (text: string, speakerId = 'A') => {
    const segmentId = `source-${++sequence}`;
    assembler.accept({ text, segmentId, sequence, speakerId, speakerName: `Speaker ${speakerId}` });
    return segmentId;
  };
  const resolve = async (index: number, completed: string[], pending = '') => {
    segmenter.gates[index]!.resolve({ completed, pending, inputTokens: 100, outputTokens: 50 });
    await drain();
  };
  return { assembler, segmenter, usage, captions, errors, diagnostics, accept, resolve };
}

test('semantic decisions hold artificial final periods and join the next transcript literally', async (t) => {
  const h = harness(t);
  const first = h.accept('여기서 아담과 하와.');
  assert.equal(h.captions.length, 0);
  await h.resolve(0, [], '여기서 아담과 하와.');
  assert.equal(h.captions.length, 0);
  const second = h.accept('왜 선악과를 먹었을까요?');
  assert.equal(h.segmenter.calls[1]?.text, '여기서 아담과 하와. 왜 선악과를 먹었을까요?');
  await h.resolve(1, ['여기서 아담과 하와. 왜 선악과를 먹었을까요?']);
  assert.equal(h.captions[0]?.boundary, 'semantic');
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.equal(h.captions[0]?.originalText, h.segmenter.calls[1]?.text);
});

test('completed prefixes emit immediately and unchanged pending text never triggers a paid retry', async (t) => {
  const h = harness(t);
  h.accept('오늘 시작합니다. 그런데 왜');
  await h.resolve(0, ['오늘 시작합니다.'], '그런데 왜');
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['오늘 시작합니다.']);
  t.mock.timers.tick(2_000);
  await drain();
  assert.equal(h.segmenter.calls.length, 1);
  assert.equal(h.usage.reservations.length, 1);
  assert.deepEqual(h.usage.reservations[0]?.actual, { inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(h.usage.reservations[0]?.rates, { inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
  h.accept('그렇게 되었을까요?');
  assert.equal(h.segmenter.calls[1]?.text, '그런데 왜 그렇게 되었을까요?');
  assert.deepEqual(h.segmenter.calls[1]?.context, ['오늘 시작합니다.']);
});

test('new text during an in-flight request is coalesced without losing or duplicating spans', async (t) => {
  const h = harness(t);
  const first = h.accept('First sentence. Then');
  const second = h.accept('we continue');
  const third = h.accept('with another sentence.');
  assert.equal(h.segmenter.calls.length, 1);
  await h.resolve(0, ['First sentence.'], 'Then');
  assert.equal(h.segmenter.calls.length, 2);
  assert.equal(h.segmenter.calls[1]?.text, 'Then we continue with another sentence.');
  await h.resolve(1, ['Then we continue with another sentence.']);
  assert.deepEqual(h.captions.map((caption) => caption.sourceSegmentIds), [[first], [first, second, third]]);
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, 2);
});

test('three requests run globally while a queued speaker coalesces new text', async (t) => {
  const h = harness(t);
  for (const id of ['A', 'B', 'C']) h.accept(`${id} finished.`, id);
  h.accept('D first', 'D');
  h.accept('and second.', 'D');
  assert.equal(h.segmenter.calls.length, 3);
  await h.resolve(1, ['B finished.']);
  assert.equal(h.segmenter.calls.length, 4);
  assert.equal(h.segmenter.calls[3]?.text, 'D first and second.');
  assert.deepEqual(h.segmenter.calls[3]?.context, []);
  await h.resolve(3, ['D first and second.']);
  await h.resolve(0, ['A finished.']);
  await h.resolve(2, ['C finished.']);
  assert.deepEqual(h.captions.map((caption) => caption.speakerId), ['B', 'D', 'A', 'C']);
});

test('silence is measured from received audio rather than transcript arrival', async (t) => {
  const h = harness(t);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.accept('Незаконченная фраза');
  await h.resolve(0, [], 'Незаконченная фраза');
  t.mock.timers.tick(6_999);
  assert.equal(h.captions.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['Незаконченная фраза', 'silence'],
  ]);
  assert.equal(h.segmenter.calls.length, 1);
});

test('new audio postpones silence but cannot extend the oldest fragment beyond eight seconds', async (t) => {
  const h = harness(t, { silenceMs: 4_000, maxHoldMs: 8_000 });
  h.assembler.activity('A');
  h.accept('Әлі аяқталмаған ой');
  await h.resolve(0, [], 'Әлі аяқталмаған ой');
  for (let i = 0; i < 2; i += 1) {
    t.mock.timers.tick(3_000);
    h.assembler.activity('A');
    assert.equal(h.captions.length, 0);
  }
  t.mock.timers.tick(1_999);
  assert.equal(h.captions.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.captions[0]?.boundary, 'timeout');
  assert.equal(h.captions[0]?.originalText, 'Әлі аяқталмаған ой');
});

test('late STT after ten seconds of silence flushes literal text without another AI call', (t) => {
  const h = harness(t);
  h.assembler.activity('A');
  t.mock.timers.tick(11_000);
  h.accept('A late fragment');
  assert.equal(h.segmenter.calls.length, 0);
  assert.equal(h.captions[0]?.boundary, 'silence');
});

test('silence aborts in-flight work and a stale response cannot duplicate a caption', async (t) => {
  const h = harness(t);
  h.accept('Still pending.');
  t.mock.timers.tick(10_000);
  assert.equal(h.segmenter.calls[0]?.signal.aborted, true);
  assert.equal(h.captions.length, 1);
  h.assembler.activity('A');
  h.accept('A new sentence.');
  assert.equal(h.segmenter.calls.length, 1, 'same speaker waits for the cancelled request to settle');
  await h.resolve(0, ['Still pending.']);
  assert.equal(h.captions.length, 1);
  assert.equal(h.segmenter.calls[1]?.text, 'A new sentence.');
  await h.resolve(1, ['A new sentence.']);
  assert.equal(h.captions.length, 2);
  assert.equal(h.usage.reservations[0]?.actual, undefined, 'cancelled request keeps its reservation');
});

test('gaps invalidate in-flight results and cannot join speech across missing audio', async (t) => {
  const h = harness(t);
  h.accept('Before missing audio');
  h.assembler.gap('A');
  h.accept('After missing audio.');
  await h.resolve(0, ['Before missing audio']);
  assert.equal(h.segmenter.calls[1]?.text, 'After missing audio.');
  assert.deepEqual(h.segmenter.calls[1]?.context, []);
  await h.resolve(1, ['After missing audio.']);
  assert.deepEqual(h.captions.map((caption) => caption.boundary), ['gap', 'semantic']);
});

test('an invalid partition falls back to original text without adopting rewritten model output', async (t) => {
  const h = harness(t);
  h.accept('하와가 발매 꽤 넘어가서');
  await h.resolve(0, ['하와가 뱀의 꾀에 넘어가서']);
  assert.equal(h.errors.length, 1);
  assert.equal(h.captions[0]?.boundary, 'fallback');
  assert.equal(h.captions[0]?.originalText, '하와가 발매 꽤 넘어가서');
  assert.equal(h.usage.reservations[0]?.actual, undefined);
  t.mock.timers.tick(20_000);
  assert.equal(h.segmenter.calls.length, 1);
});

test('nonfatal API failure flushes original text once and does not retry automatically', async (t) => {
  const h = harness(t);
  h.accept('An incomplete phrase');
  h.segmenter.gates[0]!.reject(new SegmentationError('segmentation_rate_limit'));
  await drain();
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['An incomplete phrase', 'fallback'],
  ]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.segmenter.calls.length, 1);
  h.accept('A following sentence.');
  assert.equal(h.segmenter.calls.length, 2);
});

test('budget and storage failures stop before publishing fallback captions or starting more calls', async (t) => {
  const h = harness(t);
  h.usage.failReserve = true;
  h.accept('Never sent.');
  assert.equal(h.errors.length, 1);
  assert.equal(h.segmenter.calls.length, 0);
  assert.equal(h.captions.length, 0);
  h.usage.failReserve = false;
  h.accept('Still stopped.');
  assert.equal(h.segmenter.calls.length, 0);
});

test('settlement failure and fatal model errors discard pending text before caption emission', async (t) => {
  const h = harness(t);
  h.accept('Do not publish.');
  h.usage.failSettle = true;
  await h.resolve(0, ['Do not publish.']);
  assert.equal(h.errors.length, 1);
  assert.equal(h.captions.length, 0);
  h.accept('Stopped.');
  assert.equal(h.segmenter.calls.length, 1);
});

test('authentication failure cannot flush held speech into translation', async (t) => {
  const h = harness(t);
  h.accept('Private pending speech');
  h.segmenter.gates[0]!.reject(new SegmentationError('segmentation_auth'));
  await drain();
  t.mock.timers.tick(30_000);
  h.accept('Another utterance.');
  assert.equal(h.captions.length, 0);
  assert.equal(h.segmenter.calls.length, 1);
});

test('stop aborts requests, discards fragments and ignores late replies and timers', async (t) => {
  const h = harness(t);
  h.accept('Private text');
  h.assembler.stop();
  assert.equal(h.segmenter.calls[0]?.signal.aborted, true);
  await h.resolve(0, ['Private text']);
  t.mock.timers.tick(60_000);
  h.accept('Late text.');
  h.assembler.activity('B');
  h.assembler.gap('A');
  assert.equal(h.captions.length, 0);
  assert.equal(h.segmenter.calls.length, 1);
});

test('reentrant stop during caption delivery suppresses later completed sentences', async (t) => {
  const h = harness(t, { stopOnCaption: true });
  h.accept('First sentence. Second sentence.');
  await h.resolve(0, ['First sentence.', 'Second sentence.']);
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['First sentence.']);
});

test('forced captions are bounded and preserve surrogate pairs and provenance', (t) => {
  const h = harness(t);
  const text = 'x'.repeat(3_999) + '😀' + 'y'.repeat(2_001);
  const source = h.accept(text);
  h.assembler.gap('A');
  assert.ok(h.captions.every((caption) => caption.originalText.length <= 4_000));
  assert.equal(h.captions.map((caption) => caption.originalText).join(''), text);
  assert.ok(h.captions.every((caption) => caption.sourceSegmentIds[0] === source));
});

test('queued-speaker limit flushes evicted text while retaining the global request bound', (t) => {
  const h = harness(t);
  for (let i = 0; i < 65; i += 1) {
    h.accept(`Pending ${i}`, `speaker-${i}`);
    t.mock.timers.tick(1);
  }
  assert.equal(h.segmenter.calls.length, 3);
  assert.equal(h.captions[0]?.speakerId, 'speaker-0');
  assert.equal(h.captions[0]?.boundary, 'limit');
  assert.equal(h.segmenter.calls[0]?.signal.aborted, true);
});

test('diagnostics report latency and lengths without exposing transcript content', async (t) => {
  const h = harness(t);
  h.accept('Private phrase. Pending words');
  await h.resolve(0, ['Private phrase.'], 'Pending words');
  const encoded = JSON.stringify(h.diagnostics);
  assert.ok(!encoded.includes('Private phrase'));
  assert.ok(!encoded.includes('Pending words'));
  const ready = h.diagnostics.find((item) => item.event === 'segmentation_ready');
  assert.equal(ready?.fields?.completedCount, 1);
  assert.equal(ready?.fields?.pendingChars, 13);
  assert.equal(typeof ready?.fields?.latencyMs, 'number');
});

test('completed context is erased after ten minutes even when no further transcript arrives', async (t) => {
  const h = harness(t);
  h.accept('Private prior sentence.');
  await h.resolve(0, ['Private prior sentence.']);
  // Inspect retained state because merely filtering a future request would still retain private text.
  const retained = (h.assembler as unknown as { speakers: Map<string, { context: unknown[] }> }).speakers;
  assert.equal(retained.get('A')?.context.length, 1);
  t.mock.timers.tick(600_000);
  assert.equal(retained.size, 0);
  h.assembler.activity('A');
  h.accept('A new meeting topic.');
  assert.deepEqual(h.segmenter.calls[1]?.context, []);
});
