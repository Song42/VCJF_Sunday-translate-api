import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CaptionAssembler, type AssembledCaption, type TranscriptPiece } from '../src/caption-assembler.js';

function harness(t: TestContext, options: { holdMs?: number; maxChars?: number } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const captions: AssembledCaption[] = [];
  const assembler = new CaptionAssembler({
    holdMs: options.holdMs ?? 12_000,
    ...options,
    onCaption: (caption) => captions.push(caption),
  });
  t.after(() => assembler.stop());
  let sequence = 0;
  function accept(text: string, speakerId = 'speaker1'): string {
    sequence += 1;
    const segmentId = `source-${sequence}`;
    assembler.accept({ segmentId, sequence, speakerId, speakerName: `Name ${speakerId}`, text });
    return segmentId;
  }
  return { assembler, captions, accept };
}

test('joins incomplete clauses across acoustic pauses without replacing recognized words', (t) => {
  const h = harness(t);
  const first = h.accept('왜 하나님이');
  t.mock.timers.tick(2_000);
  assert.equal(h.captions.length, 0);
  const second = h.accept('아담과 ハワイ에게 말씀하셨을까요?');
  assert.equal(h.captions[0]?.originalText, '왜 하나님이 아담과 ハワイ에게 말씀하셨을까요?');
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [first, second]);
  assert.equal(h.captions[0]?.boundary, 'sentence');
  assert.equal(h.captions[0]?.speakerName, 'Name speaker1');
});

test('splits multiple completed sentences and attributes only contributing source chunks', (t) => {
  const h = harness(t);
  const first = h.accept('First sentence. Second');
  const second = h.accept('sentence! “Third sentence?” A fragment');
  assert.deepEqual(h.captions.map((caption) => caption.originalText), [
    'First sentence.', 'Second sentence!', '“Third sentence?”',
  ]);
  assert.deepEqual(h.captions.map((caption) => caption.sourceSegmentIds), [[first], [first, second], [second]]);
  assert.equal(new Set(h.captions.map((caption) => caption.segmentId)).size, 3);
  t.mock.timers.tick(12_000);
  assert.equal(h.captions.at(-1)?.originalText, 'A fragment');
  assert.deepEqual(h.captions.at(-1)?.sourceSegmentIds, [second]);
});

test('supports Korean, Russian, Kazakh, and CJK terminal punctuation', (t) => {
  const h = harness(t);
  h.accept('안녕하세요. Здравствуйте! Сәлеметсіз бе? 漢字。 다음 문장！');
  assert.deepEqual(h.captions.map((caption) => caption.originalText), [
    '안녕하세요.', 'Здравствуйте!', 'Сәлеметсіз бе?', '漢字。', '다음 문장！',
  ]);
});

test('timeout emits the raw incomplete fragment without invented punctuation', (t) => {
  const h = harness(t);
  h.accept('就是 아직 끝나지 않은');
  t.mock.timers.tick(11_999);
  assert.equal(h.captions.length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.captions[0]?.originalText, '就是 아직 끝나지 않은');
  assert.equal(h.captions[0]?.boundary, 'timeout');
});

test('appending another piece does not extend the oldest partial deadline', (t) => {
  const h = harness(t);
  h.accept('An incomplete');
  t.mock.timers.tick(11_000);
  h.accept('thought');
  t.mock.timers.tick(1_000);
  assert.equal(h.captions[0]?.originalText, 'An incomplete thought');
  assert.equal(h.captions[0]?.boundary, 'timeout');
});

test('a remaining newer span keeps its own deadline after the older fragment completes', (t) => {
  const h = harness(t);
  h.accept('The first');
  t.mock.timers.tick(10_000);
  h.accept('sentence. A new fragment');
  t.mock.timers.tick(2_000);
  assert.equal(h.captions.length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(h.captions.at(-1)?.originalText, 'A new fragment');
  assert.equal(h.captions.at(-1)?.boundary, 'timeout');
});

test('keeps obvious decimals, initials and common abbreviations in their sentence', (t) => {
  const h = harness(t);
  h.accept('Dr. A. Smith measured 3.14 units, e.g. this sample. Mr. Jones agreed.');
  assert.deepEqual(h.captions.map((caption) => caption.originalText), [
    'Dr. A. Smith measured 3.14 units, e.g. this sample.', 'Mr. Jones agreed.',
  ]);
  h.accept('Мы живём в г. Москве. Да!');
  assert.deepEqual(h.captions.slice(2).map((caption) => caption.originalText), ['Мы живём в г. Москве.', 'Да!']);
});

test('keeps different speakers separate and clears empty speaker timers', (t) => {
  const h = harness(t);
  const first = h.accept('First unfinished', 'one');
  const second = h.accept('Второй закончил.', 'two');
  h.accept('sentence.', 'one');
  assert.deepEqual(h.captions.map((caption) => [caption.speakerId, caption.originalText]), [
    ['two', 'Второй закончил.'], ['one', 'First unfinished sentence.'],
  ]);
  assert.deepEqual(h.captions[0]?.sourceSegmentIds, [second]);
  assert.deepEqual(h.captions[1]?.sourceSegmentIds, [first, 'source-3']);
  t.mock.timers.tick(24_000);
  assert.equal(h.captions.length, 2);
});

test('gap flushes an incomplete fragment and prevents joining across missing audio', (t) => {
  const h = harness(t);
  h.accept('Before missing audio');
  h.assembler.gap('speaker1');
  h.accept('After missing audio.');
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['Before missing audio', 'gap'], ['After missing audio.', 'sentence'],
  ]);
});

test('stop discards incomplete text, cancels timers, and ignores future input', (t) => {
  const h = harness(t);
  h.accept('An incomplete sentence');
  h.assembler.stop();
  t.mock.timers.tick(24_000);
  h.accept('A late complete sentence.');
  h.assembler.gap('speaker1');
  assert.deepEqual(h.captions, []);
});

test('reentrant stop during a caption callback prevents later sentences in that turn', () => {
  const captions: AssembledCaption[] = [];
  const assembler = new CaptionAssembler({ holdMs: 12_000, onCaption: (caption) => {
    captions.push(caption);
    assembler.stop();
  } });
  const piece: TranscriptPiece = {
    segmentId: 'source', sequence: 1, speakerId: 'speaker', speakerName: 'Name',
    text: 'First sentence. Second sentence. Trailing fragment',
  };
  assembler.accept(piece);
  assert.deepEqual(captions.map((caption) => caption.originalText), ['First sentence.']);
});

test('limits long unpunctuated fragments and does not split a surrogate pair', (t) => {
  const h = harness(t, { maxChars: 8 });
  const source = h.accept('1234567😀abcdefghijk');
  t.mock.timers.tick(12_000);
  assert.ok(h.captions.every((caption) => caption.originalText.length <= 8));
  assert.equal(h.captions.map((caption) => caption.originalText).join(''), '1234567😀abcdefghijk');
  assert.deepEqual(h.captions.map((caption) => caption.boundary), ['limit', 'limit', 'timeout']);
  assert.ok(h.captions.every((caption) => caption.sourceSegmentIds.length === 1 && caption.sourceSegmentIds[0] === source));
});

test('limits a long completed sentence before its final punctuation', (t) => {
  const h = harness(t, { maxChars: 8 });
  h.accept('abcdefghijklmnop.');
  assert.deepEqual(h.captions.map((caption) => [caption.originalText, caption.boundary]), [
    ['abcdefgh', 'limit'], ['ijklmnop', 'limit'], ['.', 'sentence'],
  ]);
});

test('caps pending speakers at 64 and flushes the oldest fragment on overflow', (t) => {
  const h = harness(t);
  for (let index = 0; index < 65; index += 1) {
    h.accept(`unfinished speaker ${index}`, `speaker-${index}`);
    t.mock.timers.tick(1);
  }
  assert.equal(h.captions.length, 1);
  assert.equal(h.captions[0]?.speakerId, 'speaker-0');
  assert.equal(h.captions[0]?.boundary, 'limit');
  h.assembler.stop();
  t.mock.timers.tick(24_000);
  assert.equal(h.captions.length, 1);
});

test('rejects invalid bounds', () => {
  for (const holdMs of [0, -1, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new CaptionAssembler({ holdMs, onCaption: () => {} }), RangeError);
  }
  assert.throws(() => new CaptionAssembler({ holdMs: 1, maxChars: 1, onCaption: () => {} }), RangeError);
});
