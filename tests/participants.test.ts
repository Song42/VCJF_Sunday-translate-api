import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { loadParticipantNames, parseParticipantNames, participantKeywords, ParticipantNamesError } from '../src/participants.js';
import { OpenAIInterpreter } from '../src/interpret.js';
import { OpenAITranslator } from '../src/translate.js';
import { createComparisonVariants } from '../src/model-comparison.js';

test('participant names accept independent one-, two- and three-language entries without inventing spellings', () => {
  const names = parseParticipantNames([{ ko: ' 민수 ' }, { ko: '예시이름', ru: 'Тестель' },
    { ko: '안나', ru: 'Анна', en: 'Anna' }]);
  assert.deepEqual(names, [{ ko: '민수' }, { ko: '예시이름', ru: 'Тестель' }, { ko: '안나', ru: 'Анна', en: 'Anna' }]);
  assert.deepEqual(participantKeywords(names, ['예시이름', '선악과']), ['예시이름', '선악과', '민수', 'Тестель', '안나', 'Анна', 'Anna']);
  assert.deepEqual(parseParticipantNames([]), []);
  assert.deepEqual(parseParticipantNames([{ 'zh-cn': '安娜' }]), [{ 'zh-cn': '安娜' }]);
});

test('malformed names and too many combined STT terms fail clearly without exposing names', () => {
  for (const value of [{ ko: 'private-name' }, [{}], [null], [{ ko: '' }], [{ ko: 12 }],
    [{ name: 'private-name' }], [{ ko: 'private-name\nline' }], [{ ko: '<private-name>' }],
    [{ ko: 'x'.repeat(81) }], Array.from({ length: 51 }, () => ({ ko: 'private-name' }))]) {
    assert.throws(() => parseParticipantNames(value), (error) => {
      assert.ok(error instanceof ParticipantNamesError);
      assert.ok(!error.message.includes('private-name'));
      return true;
    });
  }
  assert.throws(() => participantKeywords([{ ko: '예시이름' }], Array.from({ length: 50 }, (_, i) => `word${i}`)), ParticipantNamesError);
});

test('UTF-8 participant file survives reload, accepts BOM, and missing file disables the glossary', (t) => {
  const root = resolve('.tools/participants-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'names-'));
  t.after(() => { assert.equal(dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'participants.json');
  assert.deepEqual(loadParticipantNames(path), []);
  writeFileSync(path, '\uFEFF[{"ko":"예시이름","ru":"Тестель"}]', 'utf8');
  assert.deepEqual(loadParticipantNames(path), [{ ko: '예시이름', ru: 'Тестель' }]);
  writeFileSync(path, '[{"en":"Anna"}]', 'utf8');
  assert.deepEqual(loadParticipantNames(path), [{ en: 'Anna' }]);
  writeFileSync(path, '[private-invalid-json]', 'utf8');
  assert.throws(() => loadParticipantNames(path), ParticipantNamesError);
});

test('combined captions send the partial glossary, reserve its tokens, and preserve the STT original', async () => {
  const names = [{ ko: '예시이름', ru: 'Тестель' }];
  const originalText = '아셀입니다.';
  const input = { text: originalText, context: [], flush: true, signal: new AbortController().signal };
  const translations = { ko: '예시이름입니다.', ru: 'Это Тестель.', kk: 'Бұл Тестель.', en: 'This is TestName.' };
  let sent = '';
  const interpreter = new OpenAIInterpreter({ apiKey: 'test-key', model: 'gpt-6.1-terra', participantNames: names }, async (_url, init) => {
    sent = String(init?.body);
    const payload = JSON.parse(sent);
    const data = JSON.parse(payload.input[0].content);
    assert.deepEqual(data.participant_names, [{ ko: '예시이름', ru: 'Тестель' }]);
    assert.equal(data.target_text, originalText);
    assert.match(payload.instructions, /Missing language entries are intentionally unspecified/);
    assert.match(payload.instructions, /Do not rewrite originalText or pending/);
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 100 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
        text: JSON.stringify({ completed: [{ originalText, translations }], pending: '' }) }] }] });
  });
  const estimate = interpreter.estimateUsage(input);
  names[0]!.ko = 'changed after reservation';
  const result = await interpreter.interpret(input);
  assert.equal(result.completed[0]?.originalText, originalText);
  assert.equal(estimate.inputTokens, Buffer.byteLength(sent, 'utf8') + 1024);
});

test('separate translation also sends the same partial glossary and accounts for its input cost', async () => {
  const names = [{ ko: '예시이름', ru: 'Тестель' }, { en: 'Anna' }];
  const input = { originalText: '예시이름입니다.', context: [], signal: new AbortController().signal };
  let sent = '';
  const translator = new OpenAITranslator({ apiKey: 'test-key', model: 'test-model', participantNames: names }, async (_url, init) => {
    sent = String(init?.body);
    assert.deepEqual(JSON.parse(JSON.parse(sent).input[0].content).participant_names, names);
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 100 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
        text: JSON.stringify({ ko: '예시이름입니다.', ru: 'Это Тестель.', kk: 'Бұл Тестель.', en: 'This is TestName.' }) }] }] });
  });
  const estimate = translator.estimateUsage(input);
  await translator.translate(input);
  assert.equal(estimate.inputTokens, Buffer.byteLength(sent, 'utf8') + 1024);
});

test('all eight comparison variants include the supplied glossary in their reserved request', () => {
  const names = [{ ko: '예시이름', ru: 'Тестель' }];
  const baseline = createComparisonVariants('test-key');
  const configured = createComparisonVariants('test-key', names);
  const input = { text: '예시이름입니다.', context: [], flush: true };
  assert.equal(configured.length, 8);
  for (let i = 0; i < configured.length; i++) {
    assert.equal(configured[i]!.variantId, baseline[i]!.variantId);
    assert.ok(configured[i]!.interpreter.estimateUsage(input).inputTokens > baseline[i]!.interpreter.estimateUsage(input).inputTokens);
  }
});
