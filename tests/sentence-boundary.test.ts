import assert from 'node:assert/strict';
import test from 'node:test';
import { completedSentencePrefix, endsWithSentenceBoundary } from '../src/sentence-boundary.js';

test('recognizes Korean, Russian, Kazakh, and English sentence endings with closing quotes', () => {
  for (const text of ['함께 들어요.', 'Спасибо!', 'Сіз дайынсыз ба?', 'Let us listen.', '그가 말했다.\u201d', 'Он сказал: «Да!»', '정말요?!']) {
    assert.equal(endsWithSentenceBoundary(text), true, text);
    assert.equal(completedSentencePrefix(text), text);
  }
});

test('returns only the complete prefix and retains unfinished text for the next caption', () => {
  assert.equal(completedSentencePrefix('첫 문장입니다. 두 번째도 끝났어요! 다음은'), '첫 문장입니다. 두 번째도 끝났어요!');
  assert.equal(endsWithSentenceBoundary('첫 문장입니다. 다음은'), false);
  assert.equal(completedSentencePrefix('他说。 다음 문장'), '他说。');
});

test('decimal points, abbreviations, initials, domains and ellipses do not close a sentence', () => {
  for (const text of ['값은 3.14', 'Dr. Smith', 'Dr.', 'Mr.', 'А.', 'А. С. Пушкин', '2026 г.', 'т. е.', 'және т.б.', 'U.S.', 'example.com', '기다려...', '잠시…', '1.', '.']) {
    assert.equal(completedSentencePrefix(text), '', text);
    assert.equal(endsWithSentenceBoundary(text), false, text);
  }
  assert.equal(completedSentencePrefix('Dr. Smith is here. Next'), 'Dr. Smith is here.');
  assert.equal(endsWithSentenceBoundary('The value is 3.14.'), true);
});
