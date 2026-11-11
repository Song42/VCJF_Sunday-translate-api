import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { InterpretedCaptionAssembler, InterpretationFlowError, type InterpretedCaption } from '../src/interpreted-captions.js';
import { InterpretationError, type InterpretationRequest, type InterpretationResult, type Interpreter } from '../src/interpret.js';
import type { Translations } from '../src/translate.js';
import type { ConversationSnapshot } from '../src/conversation-memory.js';
import { UsageLimitError, UsageStorageError, type Usage, type UsageLedger, type UsageReservation } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeInterpreter implements Interpreter {
  readonly calls: InterpretationRequest[] = [];
  readonly gates: ReturnType<typeof deferred<InterpretationResult>>[] = [];
  estimateUsage() { return { inputTokens: 5_000, outputTokens: 5_000 }; }
  interpret(input: InterpretationRequest): Promise<InterpretationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    const gate = deferred<InterpretationResult>();
    this.gates.push(gate);
    return gate.promise;
  }
}

class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; actual?: Usage }[] = [];
  failReserve = false;
  failSettle = false;
  reserve(maximum: Usage): UsageReservation {
    if (this.failReserve) throw new UsageLimitError();
    const entry = { maximum } as typeof this.reservations[number];
    this.reservations.push(entry);
    return { settle: (actual) => {
      if (this.failSettle) throw new UsageStorageError('write_failed');
      entry.actual = actual;
    } };
  }
  snapshot() { return { month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }; }
}

async function drain(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
function translations(text: string): Translations { return { ko: `ko:${text}`, ru: `ru:${text}`, kk: `kk:${text}`, en: `en:${text}` }; }

function harness(t: TestContext, options: { stopOnCaption?: boolean; silenceMs?: number; maxHoldMs?: number;
  getConversation?: () => ConversationSnapshot } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  const interpreter = new FakeInterpreter();
  const usage = new FakeUsage();
  const captions: InterpretedCaption[] = [];
  const errors: unknown[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const assembler = new InterpretedCaptionAssembler({ interpreter, usage,
    silenceMs: options.silenceMs ?? 4_000, maxHoldMs: options.maxHoldMs ?? 8_000,
    ...(options.getConversation ? { getConversation: options.getConversation } : {}),
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
    interpreter.gates[index]!.resolve({ completed: completed.map((originalText) => ({ originalText, translations: translations(originalText) })),
      pending, inputTokens: 100, outputTokens: 50 });
    await drain();
  };
  return { assembler, interpreter, usage, captions, errors, diagnostics, accept, resolve };
}

test('completed translations emit from one request immediately without the eight-second hold', async (t) => {
  const h = harness(t);
  h.accept('오늘 시작합니다. 그런데 왜');
  await h.resolve(0, ['오늘 시작합니다.'], '그런데 왜');
  assert.equal(h.captions[0]?.boundary, 'semantic');
  assert.deepEqual(h.captions[0]?.translations, translations('오늘 시작합니다.'));
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.interpreter.calls[0]?.flush, false);
  assert.deepEqual(h.usage.reservations[0]?.actual, { inputTokens: 100, outputTokens: 50 });
  t.mock.timers.tick(2_000);
  assert.equal(h.interpreter.calls.length, 1, 'unchanged pending text is not sent repeatedly');
  h.accept('그렇게 되었을까요?');
  assert.equal(h.interpreter.calls[1]?.text, '그런데 왜 그렇게 되었을까요?');
  assert.deepEqual(h.interpreter.calls[1]?.context, ['오늘 시작합니다.']);
});

test('artificial punctuation is held and source provenance survives a later join', async (t) => {
  const h = harness(t);
  const first = h.accept('여기서 가장 중요한 것은.');
  await h.resolve(0, [], '여기서 가장 중요한 것은.');
  const second = h.accept('아담과 하와가 어떤 선택을 했는지입니다.');
  const text = h.interpreter.calls[1]!.text;
  await h.resolve(1, [text]);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.equal(h.captions[0]?.originalText, text);
  assert.equal(h.captions.length, 1);
});

test('new text arriving during a request is coalesced with its pending tail exactly once', async (t) => {
  const h = harness(t);
  const first = h.accept('First sentence. Then');
  const second = h.accept('we continue');
  const third = h.accept('with another sentence.');
  assert.equal(h.interpreter.calls.length, 1);
  await h.resolve(0, ['First sentence.'], 'Then');
  assert.equal(h.interpreter.calls[1]?.text, 'Then we continue with another sentence.');
  await h.resolve(1, ['Then we continue with another sentence.']);
  assert.deepEqual(h.captions.map((caption) => caption.sourceSegmentIds), [[first], [first, second, third]]);
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, 2);
});

test('assembler snapshots the latest shared finalized conversation when each translation request starts', async (t) => {
  let conversation: ConversationSnapshot = { recent: [{ id: 'other-1', speakerId: 'B', speakerName: 'B', text: '은혜에 관한 질문입니다.' }], summary: 'Earlier discussion' };
  const h = harness(t, { getConversation: () => conversation });
  h.accept('첫 문장입니다.');
  assert.deepEqual(h.interpreter.calls[0]?.conversation, conversation);
  await h.resolve(0, ['첫 문장입니다.']);
  conversation = { recent: [{ id: 'other-2', speakerId: 'C', speakerName: 'C', text: '그 질문은 부정 표현에 관한 것입니다.' }], summary: 'Updated discussion' };
  h.accept('다음 문장입니다.');
  assert.deepEqual(h.interpreter.calls[1]?.conversation, conversation);
});

test('late Korean negation received during inference is re-evaluated before an old affirmative can be published', async (t) => {
  const h = harness(t);
  const first = h.accept('하고 싶을 때만 할 수 있는 일이야.');
  const second = h.accept('아니라 명령이에요, 명령.');
  await h.resolve(0, ['하고 싶을 때만 할 수 있는 일이야.']);
  assert.equal(h.captions.length, 0, 'stale affirmative must not reach the audience');
  assert.equal(h.interpreter.calls.length, 2);
  assert.equal(h.interpreter.calls[1]?.text, '하고 싶을 때만 할 수 있는 일이야. 아니라 명령이에요, 명령.');
  await h.resolve(1, [h.interpreter.calls[1]!.text]);
  assert.equal(h.captions.length, 1);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.equal(h.usage.reservations.length, 2);
  assert.ok(h.usage.reservations.every((entry) => entry.actual?.inputTokens === 100));
  assert.ok(h.diagnostics.some((item) => item.event === 'interpretation_late_context_deferred'));
});

test('continuous correction prefixes cause at most one pre-publication retry before progress and review diagnostics', async (t) => {
  const h = harness(t);
  h.accept('It is necessary.');
  h.accept('But not today.');
  await h.resolve(0, ['It is necessary.']);
  h.accept('Actually, tomorrow.');
  await h.resolve(1, ['It is necessary. But not today.']);
  assert.equal(h.captions.length, 1);
  assert.equal(h.interpreter.calls[2]?.text, 'Actually, tomorrow.');
  assert.ok(h.diagnostics.some((item) => item.event === 'interpretation_late_context_limit'));
});

test('late correction beyond a hold timeout rejoins connected source and preserves the forced deadline', async (t) => {
  const h = harness(t, { silenceMs: 30000, maxHoldMs: 8000 });
  const first = h.accept('Это обязательно.');
  t.mock.timers.tick(8000);
  const second = h.accept('Но не сегодня.');
  await h.resolve(0, ['Это обязательно.']);
  assert.equal(h.captions.length, 0);
  assert.equal(h.interpreter.calls[1]?.text, 'Это обязательно. Но не сегодня.');
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, [h.interpreter.calls[1]!.text]);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.equal(h.captions[0]?.boundary, 'timeout');
});

test('a real source gap is never joined merely because the next independent phrase starts with negation', async (t) => {
  const h = harness(t);
  const first = h.accept('Бұл бұйрық.');
  h.assembler.gap('A');
  h.accept('Бірақ басқа мәселе бар.');
  await h.resolve(0, ['Бұл бұйрық.']);
  assert.equal(h.captions.length, 1);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first]);
  assert.equal(h.interpreter.calls[1]?.text, 'Бірақ басқа мәселе бар.');
});

test('silence forces translation four seconds after audio, independently of STT arrival', async (t) => {
  const h = harness(t);
  h.assembler.activity('A');
  t.mock.timers.tick(1_000);
  h.accept('Незаконченная фраза');
  await h.resolve(0, [], 'Незаконченная фраза');
  t.mock.timers.tick(2_999);
  assert.equal(h.interpreter.calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, ['Незаконченная фраза']);
  assert.equal(h.captions[0]?.boundary, 'silence');
});

test('audio activity postpones silence but never the oldest pending fragment beyond eight seconds', async (t) => {
  const h = harness(t);
  h.assembler.activity('A');
  h.accept('Әлі аяқталмаған ой');
  await h.resolve(0, [], 'Әлі аяқталмаған ой');
  for (let index = 0; index < 2; index += 1) {
    t.mock.timers.tick(3_000);
    h.assembler.activity('A');
  }
  t.mock.timers.tick(1_999);
  assert.equal(h.interpreter.calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, ['Әлі аяқталмаған ой']);
  assert.equal(h.captions[0]?.boundary, 'timeout');
});

test('a deadline during an in-flight request keeps completed translations and flushes only its tail', async (t) => {
  const h = harness(t);
  h.accept('Completed. Still pending');
  t.mock.timers.tick(4_000);
  assert.equal(h.interpreter.calls[0]?.signal.aborted, false);
  assert.equal(h.interpreter.calls.length, 1);
  await h.resolve(0, ['Completed.'], 'Still pending');
  assert.equal(h.captions[0]?.originalText, 'Completed.');
  assert.equal(h.interpreter.calls[1]?.text, 'Still pending');
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, ['Still pending']);
  assert.deepEqual(h.captions.map((caption) => caption.boundary), ['semantic', 'silence']);
  assert.equal(h.usage.reservations.length, 2);
});

test('a completed in-flight request needs no second call even if its deadline has passed', async (t) => {
  const h = harness(t);
  h.accept('Already complete.');
  t.mock.timers.tick(20_000);
  await h.resolve(0, ['Already complete.']);
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.captions.length, 1);
});

test('a younger tail does not inherit the completed sentence deadline and joins its continuation', async (t) => {
  const h = harness(t);
  const first = h.accept('여기서 중요한 것은.');
  await h.resolve(0, [], '여기서 중요한 것은.');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  const second = h.accept('어떤 선택을 했는지입니다. 이제.');
  t.mock.timers.tick(2_200);
  await h.resolve(1, ['여기서 중요한 것은. 어떤 선택을 했는지입니다.'], '이제.');
  assert.equal(h.interpreter.calls.length, 2, 'the two-second-old tail is not forced by the eight-second-old sentence');
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.ok(h.diagnostics.some((item) => item.event === 'interpretation_hold_rebased'
    && item.fields?.oldestPendingMs === 2_200));
  h.assembler.activity('A');
  const third = h.accept('그 선택의 결과를 살펴보겠습니다.');
  assert.equal(h.interpreter.calls[2]?.flush, false);
  assert.equal(h.interpreter.calls[2]?.text, '이제. 그 선택의 결과를 살펴보겠습니다.');
  await h.resolve(2, [h.interpreter.calls[2]!.text]);
  assert.deepEqual(h.captions[1]?.sourceSegmentIds, [second, third]);
  assert.deepEqual(h.captions.map((caption) => caption.boundary), ['semantic', 'semantic']);
});

test('rebasing retains the younger span original arrival time instead of granting eight more seconds', async (t) => {
  const h = harness(t);
  h.accept('Old');
  await h.resolve(0, [], 'Old');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  h.accept('sentence. New tail');
  t.mock.timers.tick(2_200);
  await h.resolve(1, ['Old sentence.'], 'New tail');
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(2_799);
  assert.equal(h.interpreter.calls.length, 2);
  t.mock.timers.tick(1); // tail arrived at t=7000; now t=15000
  assert.equal(h.interpreter.calls[2]?.flush, true);
  assert.equal(h.interpreter.calls[2]?.text, 'New tail');
  await h.resolve(2, ['New tail']);
  assert.equal(h.captions[1]?.boundary, 'timeout');
});

test('new speech queued after a stale hold timeout rejoins only the unconsumed younger tail', async (t) => {
  const h = harness(t);
  h.accept('Old');
  await h.resolve(0, [], 'Old');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  const second = h.accept('sentence. Next');
  t.mock.timers.tick(2_100);
  h.assembler.activity('A');
  const third = h.accept('sentence.');
  await h.resolve(1, ['Old sentence.'], 'Next');
  assert.equal(h.interpreter.calls[2]?.text, 'Next sentence.');
  assert.equal(h.interpreter.calls[2]?.flush, false);
  await h.resolve(2, ['Next sentence.']);
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['Old sentence.', 'Next sentence.']);
  assert.deepEqual(h.captions[1]?.sourceSegmentIds, [second, third]);
});

test('a gap after a hold timeout remains a hard boundary for a younger tail', async (t) => {
  const h = harness(t);
  h.accept('Old');
  await h.resolve(0, [], 'Old');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  h.accept('sentence. Young tail');
  t.mock.timers.tick(2_100);
  h.assembler.gap('A');
  h.assembler.activity('A');
  h.accept('After gap.');
  await h.resolve(1, ['Old sentence.'], 'Young tail');
  assert.equal(h.interpreter.calls[2]?.text, 'Young tail');
  assert.equal(h.interpreter.calls[2]?.flush, true);
  await h.resolve(2, ['Young tail']);
  assert.equal(h.captions[1]?.boundary, 'gap');
  assert.equal(h.interpreter.calls[3]?.text, 'After gap.');
  assert.deepEqual(h.interpreter.calls[3]?.context, []);
});

test('a remaining tail from the same expired source span must still be forced', async (t) => {
  const h = harness(t);
  h.accept('Completed. Old tail');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(2_100);
  await h.resolve(0, ['Completed.'], 'Old tail');
  assert.equal(h.interpreter.calls[1]?.text, 'Old tail');
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, ['Old tail']);
  assert.equal(h.captions[1]?.boundary, 'timeout');
});

test('rebasing a younger tail does not postpone an already reached audio silence deadline', async (t) => {
  const h = harness(t);
  h.accept('Old');
  await h.resolve(0, [], 'Old');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  t.mock.timers.tick(3_000);
  h.assembler.activity('A');
  h.accept('sentence. Young tail');
  t.mock.timers.tick(4_500);
  await h.resolve(1, ['Old sentence.'], 'Young tail');
  assert.equal(h.interpreter.calls[2]?.text, 'Young tail');
  assert.equal(h.interpreter.calls[2]?.flush, true);
  await h.resolve(2, ['Young tail']);
  assert.equal(h.captions[1]?.boundary, 'silence');
});

test('new speech after a deadline waits in a separate ordered batch', async (t) => {
  const h = harness(t);
  h.accept('Old fragment');
  t.mock.timers.tick(4_000);
  h.assembler.activity('A');
  h.accept('New speech.');
  await h.resolve(0, [], 'Old fragment');
  assert.equal(h.interpreter.calls[1]?.text, 'Old fragment');
  await h.resolve(1, ['Old fragment']);
  assert.equal(h.interpreter.calls[2]?.text, 'New speech.');
  assert.equal(h.interpreter.calls[2]?.flush, false);
  await h.resolve(2, ['New speech.']);
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['Old fragment', 'New speech.']);
});

test('a transport gap prevents joins and clears context for subsequent speech', async (t) => {
  const h = harness(t);
  h.accept('Before missing audio');
  h.assembler.gap('A');
  h.accept('After missing audio.');
  await h.resolve(0, [], 'Before missing audio');
  assert.equal(h.interpreter.calls[1]?.text, 'Before missing audio');
  assert.equal(h.interpreter.calls[1]?.flush, true);
  await h.resolve(1, ['Before missing audio']);
  assert.equal(h.interpreter.calls[2]?.text, 'After missing audio.');
  assert.deepEqual(h.interpreter.calls[2]?.context, []);
  await h.resolve(2, ['After missing audio.']);
  assert.deepEqual(h.captions.map((caption) => caption.boundary), ['gap', 'semantic']);
});

test('late STT after silence uses one forced request directly', async (t) => {
  const h = harness(t);
  h.assembler.activity('A');
  t.mock.timers.tick(5_000);
  h.accept('Late fragment');
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.interpreter.calls[0]?.flush, true);
  await h.resolve(0, ['Late fragment']);
  assert.equal(h.captions[0]?.boundary, 'silence');
});

test('global concurrency is three and same-speaker requests remain sequential', async (t) => {
  const h = harness(t);
  for (const id of ['A', 'B', 'C']) h.accept(`${id} finished.`, id);
  h.accept('D first', 'D');
  h.accept('and second.', 'D');
  assert.equal(h.interpreter.calls.length, 3);
  await h.resolve(1, ['B finished.']);
  assert.equal(h.interpreter.calls[3]?.text, 'D first and second.');
  await h.resolve(3, ['D first and second.']);
  await h.resolve(0, ['A finished.']);
  await h.resolve(2, ['C finished.']);
  assert.deepEqual(h.captions.map((caption) => caption.speakerId), ['B', 'D', 'A', 'C']);
});

test('invalid model rewrites are never emitted and get one forced fallback using original spans', async (t) => {
  const h = harness(t);
  h.accept('하와가 발매 꽤 넘어가서');
  await h.resolve(0, ['하와가 뱀의 꾀에 넘어가서']);
  assert.equal(h.captions.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.interpreter.calls[1]?.text, '하와가 발매 꽤 넘어가서');
  assert.equal(h.interpreter.calls[1]?.flush, true);
  assert.equal(h.usage.reservations[0]?.actual, undefined);
  await h.resolve(1, ['하와가 발매 꽤 넘어가서']);
  assert.equal(h.captions[0]?.boundary, 'fallback');
});

test('failed forced flush stops visibly and cannot create an infinite paid retry loop', async (t) => {
  const h = harness(t);
  h.accept('Incomplete');
  h.interpreter.gates[0]!.reject(new InterpretationError('interpretation_rate_limit'));
  await drain();
  h.interpreter.gates[1]!.reject(new InterpretationError('interpretation_rate_limit'));
  await drain();
  assert.ok(h.errors.some((error) => error instanceof InterpretationFlowError && error.code === 'interpretation_failed'));
  t.mock.timers.tick(60_000);
  h.accept('Must remain stopped.');
  assert.equal(h.interpreter.calls.length, 2);
  assert.equal(h.captions.length, 0);
});

test('budget exhaustion prevents requests and storage failure prevents caption publication', async (t) => {
  const h = harness(t);
  h.usage.failReserve = true;
  h.accept('Do not send.');
  assert.equal(h.interpreter.calls.length, 0);
  assert.ok(h.errors[0] instanceof UsageLimitError);
  h.usage.failReserve = false;
  h.accept('Still stopped.');
  assert.equal(h.interpreter.calls.length, 0);
});

test('failed usage settlement stops before publishing completed translations', async (t) => {
  const h = harness(t);
  h.accept('Do not publish.');
  h.usage.failSettle = true;
  await h.resolve(0, ['Do not publish.']);
  assert.ok(h.errors[0] instanceof UsageStorageError);
  assert.equal(h.captions.length, 0);
  h.accept('Still stopped.');
  assert.equal(h.interpreter.calls.length, 1);
});

test('authentication failure stops immediately without a fallback request', async (t) => {
  const h = harness(t);
  h.accept('Private text');
  h.interpreter.gates[0]!.reject(new InterpretationError('interpretation_auth'));
  await drain();
  t.mock.timers.tick(60_000);
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.captions.length, 0);
});

test('stop aborts requests and suppresses late replies and reentrant later captions', async (t) => {
  const h = harness(t);
  h.accept('Private text');
  h.assembler.stop();
  assert.equal(h.interpreter.calls[0]?.signal.aborted, true);
  await h.resolve(0, ['Private text']);
  t.mock.timers.tick(60_000);
  h.accept('Late text');
  assert.equal(h.captions.length, 0);
  assert.equal(h.interpreter.calls.length, 1);
});

test('reentrant stop during delivery suppresses other completed parts in the same response', async (t) => {
  const h = harness(t, { stopOnCaption: true });
  h.accept('First. Second.');
  await h.resolve(0, ['First.', 'Second.']);
  assert.deepEqual(h.captions.map((caption) => caption.originalText), ['First.']);
});

test('length limits seal ordered batches without splitting surrogate pairs', async (t) => {
  const h = harness(t);
  const text = 'x'.repeat(7_999) + '😀' + 'tail';
  const source = h.accept(text);
  assert.equal(h.interpreter.calls[0]?.text, 'x'.repeat(7_999));
  assert.equal(h.interpreter.calls[0]?.flush, true);
  await h.resolve(0, ['x'.repeat(7_999)]);
  assert.equal(h.interpreter.calls[1]?.text, '😀tail');
  await h.resolve(1, ['😀tail']);
  assert.equal(h.captions.map((caption) => caption.originalText).join(''), text);
  assert.ok(h.captions.every((caption) => caption.sourceSegmentIds[0] === source));
});

test('speaker capacity stops visibly and aborts work instead of dropping older speech', (t) => {
  const h = harness(t);
  for (let index = 0; index < 65; index += 1) h.accept(`Pending ${index}`, `speaker-${index}`);
  assert.equal(h.interpreter.calls.length, 3);
  assert.ok(h.errors[0] instanceof InterpretationFlowError);
  assert.equal((h.errors[0] as InterpretationFlowError).code, 'interpretation_backpressure');
  assert.ok(h.interpreter.calls.every((call) => call.signal.aborted));
});

test('diagnostics separate API and queue latency without including speech or translations', async (t) => {
  const h = harness(t);
  h.accept('Private phrase. Pending words');
  t.mock.timers.tick(250);
  await h.resolve(0, ['Private phrase.'], 'Pending words');
  const encoded = JSON.stringify(h.diagnostics);
  assert.ok(!encoded.includes('Private phrase'));
  assert.ok(!encoded.includes('Pending words'));
  const ready = h.diagnostics.find((item) => item.event === 'interpretation_ready');
  assert.equal(ready?.fields?.latencyMs, 250);
  assert.equal(ready?.fields?.completedCount, 1);
  const started = h.diagnostics.find((item) => item.event === 'interpretation_started');
  assert.equal(started?.fields?.queueMs, 0);
  assert.equal(started?.fields?.oldestPendingMs, 0);
});

test('completed context is erased after ten minutes without waiting for new input', async (t) => {
  const h = harness(t);
  h.accept('Private prior sentence.');
  await h.resolve(0, ['Private prior sentence.']);
  const retained = (h.assembler as unknown as { speakers: Map<string, { context: unknown[] }> }).speakers;
  assert.equal(retained.get('A')?.context.length, 1);
  t.mock.timers.tick(600_000);
  assert.equal(retained.size, 0);
  h.accept('New topic.');
  assert.deepEqual(h.interpreter.calls[1]?.context, []);
});
