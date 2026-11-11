import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { StreamingCaptionCoordinator } from '../src/streaming-captions.js';
import type { TranslationRequest, TranslationResult } from '../src/translate.js';
import type { SegmentationRequest, SegmentationResult } from '../src/segment.js';
import type { Caption } from '../src/types.js';

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const drain = () => new Promise<void>((done) => setImmediate(done));
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const calls: { input: TranslationRequest; gate: ReturnType<typeof gate<TranslationResult>> }[] = [];
  const checks: { input: SegmentationRequest; gate: ReturnType<typeof gate<SegmentationResult>> }[] = [];
  const drafts: Caption[] = [], stable: Caption[] = [], errors: unknown[] = [];
  let reservations = 0, settlements = 0;
  let sequence = 0;
  const coordinator = new StreamingCaptionCoordinator({ allocateSequence: () => ++sequence,
    translator: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), translate: (input) => {
      const pending = gate<TranslationResult>(); calls.push({ input, gate: pending }); return pending.promise;
    } },
    segmenter: { estimateUsage: () => ({ inputTokens: 100, outputTokens: 100 }), segment: (input) => {
      const pending = gate<SegmentationResult>(); checks.push({ input, gate: pending }); return pending.promise;
    } },
    usage: { reserve: () => { reservations++; return { settle: () => { settlements++; } }; } }, getConversation: () => ({ recent: [], summary: '' }),
    onDraft: (caption) => drafts.push(caption), onStable: (caption) => stable.push(caption),
    onDiagnostic: () => {}, onError: (error) => errors.push(error),
  });
  t.after(() => coordinator.stop());
  const answer = async (index: number) => {
    const call = calls[index]!;
    call.gate.resolve({ translations: { ko: call.input.originalText, ru: 'Перевод', kk: 'Аударма', en: 'Translation' }, inputTokens: 10, outputTokens: 10 });
    await drain();
  };
  return { coordinator, calls, checks, drafts, stable, errors, answer, usage: () => ({ reservations, settlements }) };
}

test('partial STT starts a draft without waiting for STT final or the semantic model', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker');
  h.coordinator.updateSource('source-1', '지금 번역을 시작', false);
  t.mock.timers.tick(1_000);
  assert.equal(h.calls.length, 1); assert.equal(h.checks.length, 0);
  await h.answer(0);
  assert.equal(h.drafts[0]?.status, 'draft'); assert.equal(h.stable.length, 0);
  h.coordinator.updateSource('source-1', '지금 번역을 시작했습니다', true);
  t.mock.timers.tick(1_000); await h.answer(1);
  assert.equal(h.drafts[1]?.sequence, h.drafts[0]?.sequence);
  assert.ok(h.drafts[1]!.revision! > h.drafts[0]!.revision!);
  assert.equal(h.stable.length, 0, 'an STT checkpoint is not a sentence finalization');
});

test('silence waits for pending final STT and settles the same caption identity', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker'); h.coordinator.updateSource('source-1', '시작', false);
  t.mock.timers.tick(1_000); await h.answer(0);
  h.coordinator.silence('A'); assert.equal(h.stable.length, 0);
  h.coordinator.updateSource('source-1', '시작했습니다.', true);
  await h.answer(1);
  assert.equal(h.stable[0]?.sequence, h.drafts[0]?.sequence);
  assert.equal(h.stable[0]?.originalText, '시작했습니다.');
  assert.equal(h.stable[0]?.boundary, 'silence');
});

test('finalization cancels an obsolete draft without awaiting its transport or publishing its late result', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker'); h.coordinator.updateSource('source-1', '시작해.', false);
  t.mock.timers.tick(1_000);
  h.coordinator.updateSource('source-1', '시작했습니다.', true);
  h.coordinator.updateSource('source-1', 'ignored duplicate final', true);
  assert.equal(h.calls[0]!.input.signal.aborted, true);
  await drain();
  assert.equal(h.calls.length, 2, 'the final request starts while the old transport remains pending');
  assert.equal(h.calls[1]!.input.provisional, false);
  await h.answer(1);
  assert.deepEqual(h.stable.map(caption => caption.originalText), ['시작했습니다.']);
  await h.answer(0);
  assert.equal(h.drafts.length, 0); assert.equal(h.stable.length, 1);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.usage(), { reservations: 2, settlements: 1 }, 'unknown cancelled usage is not refunded');
  assert.equal(h.coordinator.isSettled(), true);
});

test('a background boundary can settle a confirmed prefix while keeping the tail provisional', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker'); h.coordinator.updateSource('source-1', '문장이 완성되었습니다', true);
  h.coordinator.startSource('source-2', 'A', 'Speaker'); h.coordinator.updateSource('source-2', '다음 설명을 이어가', false);
  assert.equal(h.checks.length, 1);
  t.mock.timers.tick(1_000);
  assert.equal(h.calls.length, 1, 'a pending boundary request cannot block draft translation');
  await h.answer(0);
  h.checks[0]!.gate.resolve({ completed: ['문장이 완성되었습니다'], pending: '다음 설명을 이어가', inputTokens: 10, outputTokens: 10 });
  await drain(); await h.answer(1);
  assert.equal(h.stable[0]?.originalText, '문장이 완성되었습니다');
  assert.equal(h.stable[0]?.sequence, h.drafts[0]?.sequence);
  t.mock.timers.tick(1_000); await h.answer(2);
  assert.equal(h.drafts.at(-1)?.originalText, '다음 설명을 이어가');
  assert.notEqual(h.drafts.at(-1)?.sequence, h.stable[0]?.sequence);
});

test('stop aborts paid work and suppresses late draft/final publication', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker'); h.coordinator.updateSource('source-1', '진행 중인 말', false);
  t.mock.timers.tick(1_000); h.coordinator.stop();
  assert.equal(h.calls[0]?.input.signal.aborted, true);
  await h.answer(0);
  assert.equal(h.drafts.length, 0); assert.equal(h.stable.length, 0);
});

test('a newly received Korean verb continuation suppresses an already-invalid affirmative draft', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('source-1', 'A', 'Speaker');
  h.coordinator.updateSource('source-1', '번역을 시작해', true);
  t.mock.timers.tick(1_000);
  h.coordinator.startSource('source-2', 'A', 'Speaker');
  h.coordinator.updateSource('source-2', '했습니다. 다음 내용입니다.', false);
  await h.answer(0);
  assert.equal(h.drafts.length, 0);
  t.mock.timers.tick(1_000); await h.answer(1);
  assert.equal(h.drafts[0]?.originalText, '번역을 시작해 했습니다. 다음 내용입니다.');
  assert.equal(h.stable.length, 0);
});

test('ordinary appended words keep a useful draft request running', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker');
  h.coordinator.updateSource('s1', '함께 듣는 말씀', false);
  t.mock.timers.tick(1_000);
  h.coordinator.updateSource('s1', '함께 듣는 말씀 그리고 이어지는 이야기', false);
  assert.equal(h.calls[0]!.input.signal.aborted, false);
  await h.answer(0);
  assert.equal(h.drafts[0]?.originalText, '함께 듣는 말씀');
  assert.deepEqual(h.errors, []);
});

test('rapid corrections coalesce and early cancellation is capped until a useful result is published', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker');
  h.coordinator.updateSource('s1', '초기 인식', false);
  t.mock.timers.tick(1_000);
  h.coordinator.updateSource('s1', '첫 번째 정정', false);
  h.coordinator.updateSource('s1', '두 번째 정정', false);
  await drain();
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1_000);
  assert.equal(h.calls[1]!.input.originalText, '두 번째 정정');
  h.coordinator.updateSource('s1', '세 번째 정정', false);
  await drain(); t.mock.timers.tick(1_000);
  assert.equal(h.calls[2]!.input.originalText, '세 번째 정정');
  h.coordinator.updateSource('s1', '네 번째 정정', false);
  assert.equal(h.calls[2]!.input.signal.aborted, false, 'two consecutive early cancellations is the limit');
  h.coordinator.updateSource('s1', '최종 문장입니다.', true);
  assert.equal(h.calls[2]!.input.signal.aborted, true, 'a final caption bypasses the draft cancellation cap');
  await drain();
  assert.equal(h.calls[3]!.input.originalText, '최종 문장입니다.');
  await h.answer(3);
  await h.answer(0); await h.answer(1); await h.answer(2);
  assert.deepEqual(h.stable.map(caption => caption.originalText), ['최종 문장입니다.']);
  assert.equal(h.drafts.length, 0); assert.deepEqual(h.errors, []);
  assert.equal(h.coordinator.isSettled(), true);
});

test('late failures from cancelled drafts cannot stop or retry a newer final request', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker'); h.coordinator.updateSource('s1', '임시', false);
  t.mock.timers.tick(1_000);
  h.coordinator.updateSource('s1', '완료했습니다.', true);
  await drain();
  h.calls[0]!.gate.reject(new Error('late transport error'));
  await drain();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.errors, []);
  await h.answer(1);
  assert.equal(h.stable.length, 1); assert.equal(h.coordinator.isSettled(), true);
});

test('confirmed punctuation closes a sentence without silence and preserves the next provisional source', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker');
  h.coordinator.updateSource('s1', '번역을 시작해.', false);
  assert.equal(h.stable.length, 0, 'temporary punctuation alone must not finalize a caption');
  h.coordinator.startSource('s2', 'A', 'Speaker');
  h.coordinator.updateSource('s2', '했습니다. 다음 내용입니다.', false);
  h.coordinator.updateSource('s1', '번역을 시작해.', true);
  assert.equal(h.calls[0]!.input.provisional, false);
  await h.answer(0);
  assert.equal(h.stable[0]?.originalText, '번역을 시작해.', 'confirmed punctuation is now an explicit boundary');
  h.coordinator.updateSource('s2', '했습니다. 다음 내용입니다.', true);
  await h.answer(1);
  assert.equal(h.stable[1]?.originalText, '했습니다. 다음 내용입니다.');
  assert.notEqual(h.stable[0]?.sequence, h.stable[1]?.sequence);
  assert.equal(h.coordinator.isSettled(), true);
});

test('a final STT chunk can close multiple sentences while retaining an unfinished tail', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker');
  h.coordinator.updateSource('s1', '첫 문장입니다. 둘째 문장입니다! 그리고 아직', true);
  await h.answer(0);
  assert.equal(h.stable[0]?.originalText, '첫 문장입니다. 둘째 문장입니다!');
  h.coordinator.startSource('s2', 'A', 'Speaker');
  h.coordinator.updateSource('s2', '이어지는 말입니다.', true);
  await h.answer(1);
  assert.equal(h.stable[1]?.originalText, '그리고 아직 이어지는 말입니다.');
  assert.deepEqual(h.stable[1]?.sourceSegmentIds, ['s1', 's2']);
  assert.equal(h.coordinator.isSettled(), true);
});

test('out-of-order STT finals cannot freeze an earlier unresolved source', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker'); h.coordinator.updateSource('s1', '아직 수정 중', false);
  h.coordinator.startSource('s2', 'A', 'Speaker'); h.coordinator.updateSource('s2', '문장이 끝납니다.', true);
  assert.equal(h.calls.length, 0);
  h.coordinator.updateSource('s1', '앞부분은 확정이고', true);
  await h.answer(0);
  assert.equal(h.stable[0]?.originalText, '앞부분은 확정이고 문장이 끝납니다.');
  assert.deepEqual(h.stable[0]?.sourceSegmentIds, ['s1', 's2']);
});

test('silence forces an unfinished confirmed sentence to close', async (t) => {
  const h = harness(t);
  h.coordinator.startSource('s1', 'A', 'Speaker'); h.coordinator.updateSource('s1', '아직 끝나지 않은', true);
  assert.equal(h.calls.length, 0);
  h.coordinator.silence('A');
  await h.answer(0);
  assert.equal(h.stable[0]?.originalText, '아직 끝나지 않은');
  assert.equal(h.stable[0]?.boundary, 'silence');
});

test('ready final captions take a freed global slot before pending drafts', async (t) => {
  const h = harness(t);
  for (const speaker of ['A', 'B', 'C', 'D']) {
    h.coordinator.startSource(speaker, speaker, speaker);
    h.coordinator.updateSource(speaker, `${speaker} 진행 중`, false);
  }
  t.mock.timers.tick(1_000);
  assert.equal(h.calls.length, 3);
  h.coordinator.startSource('E', 'E', 'E'); h.coordinator.updateSource('E', '확정된 문장입니다.', true);
  await h.answer(0);
  assert.equal(h.calls[3]!.input.originalText, '확정된 문장입니다.');
  assert.equal(h.calls[3]!.input.provisional, false);
  await h.answer(3);
  assert.equal(h.calls[4]!.input.originalText, 'D 진행 중');
  assert.equal(h.calls[1]!.input.signal.aborted, false);
  assert.equal(h.calls[2]!.input.signal.aborted, false);
});

test('late cancelled work cannot unlock its replacement or another speaker slot', async (t) => {
  const h = harness(t);
  for (const speaker of ['A', 'B', 'C']) {
    h.coordinator.startSource(speaker, speaker, speaker);
    h.coordinator.updateSource(speaker, `${speaker} 진행 중`, false);
  }
  t.mock.timers.tick(1_000);
  h.coordinator.updateSource('A', 'A 완료했습니다.', true);
  await drain();
  assert.equal(h.calls.length, 4);
  h.coordinator.startSource('A2', 'A', 'A'); h.coordinator.updateSource('A2', 'A 다음 발화', false);
  h.coordinator.startSource('D', 'D', 'D'); h.coordinator.updateSource('D', 'D 대기 중', false);
  t.mock.timers.tick(1_000);
  await h.answer(0);
  assert.equal(h.calls.length, 4, 'late old resolution must not free the replacement slot');
  assert.equal(h.calls[1]!.input.signal.aborted, false);
  assert.equal(h.calls[2]!.input.signal.aborted, false);
  assert.equal(h.calls[3]!.input.signal.aborted, false);
  await h.answer(3);
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls[4]!.input.originalText, 'A 다음 발화');
  assert.deepEqual(h.errors, []);
});
