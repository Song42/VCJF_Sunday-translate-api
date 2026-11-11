import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { BUILT_IN_GLOSSARY, CHRISTIAN_DISCUSSION_PROMPT, DEFAULT_SPOKEN_LANGUAGES,
  GlossaryError, buildTranscriptionHints, loadCustomGlossary, mergeGlossaries,
  parseGlossaryEntries, participantNamesToGlossary, selectRelevantGlossary } from '../src/glossary.js';

test('default Christian glossary and multilingual STT context work without custom terms', () => {
  const entries = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY });
  assert.deepEqual(entries, BUILT_IN_GLOSSARY);
  const hints = buildTranscriptionHints(entries);
  assert.ok(hints.prompt.length < 1000);
  assert.equal(hints.prompt, CHRISTIAN_DISCUSSION_PROMPT);
  assert.match(hints.prompt, /never insert a term unless supported by the audio/);
  assert.deepEqual(DEFAULT_SPOKEN_LANGUAGES, ['ko', 'ru', 'kk', 'en']);
  assert.ok(hints.keywords.includes('은혜'));
  assert.ok(hints.keywords.includes('благодать'));
  assert.ok(hints.keywords.includes('grace'));
  assert.ok(hints.keywords.includes('рақым'));
  assert.ok(hints.keywords.length <= 50);
});

test('custom entries override an explicit id or source-language term while retaining other built-in translations', () => {
  const custom = [{ id: 'community.grace', sourceTerm: '은혜', sourceLanguage: 'ko', translations: { kk: 'рақымдылық' } },
    { id: 'christian.acts', sourceTerm: '사도행전', sourceLanguage: 'ko', translations: { ru: 'Деяния' } }];
  const merged = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom });
  const grace = merged.find((entry) => entry.id === 'community.grace')!;
  assert.equal(grace.translations.kk, 'рақымдылық');
  assert.equal(grace.translations.en, 'grace');
  assert.equal(merged.some((entry) => entry.id === 'christian.grace'), false);
  assert.equal(merged.find((entry) => entry.id === 'christian.acts')?.translations.ru, 'Деяния');
  assert.equal(merged.length, BUILT_IN_GLOSSARY.length);
  assert.ok(merged.slice(0, 2).every((entry) => custom.some((item) => item.id === entry.id)));
  assert.equal(BUILT_IN_GLOSSARY.find((entry) => entry.id === 'christian.grace')?.translations.kk, 'рақым');
});

test('equal translated spellings and differently scoped source languages do not collapse unrelated entries', () => {
  const builtIn = [{ id: 'religion', sourceTerm: '은혜', sourceLanguage: 'ko', translations: { en: 'Grace' } }];
  const custom = [{ id: 'person', sourceTerm: 'Grace', sourceLanguage: 'en', translations: { ko: '그레이스' } },
    { id: 'unknown-language', sourceTerm: '은혜', translations: { en: 'Eunhye' } }];
  assert.equal(mergeGlossaries({ builtIn, custom }).length, 3);
});

test('a full custom glossary plus participant names remains valid after merging default terms', () => {
  const custom = Array.from({ length: 200 }, (_, index) => ({ id: `custom.${index}`, sourceTerm: `Term ${index}`, translations: { en: `Term ${index}` } }));
  const names = participantNamesToGlossary([{ ko: '예시이름', ru: 'Тестель' }]);
  const merged = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: [...names, ...custom] });
  assert.equal(merged.length, 200 + names.length + BUILT_IN_GLOSSARY.length);
  assert.deepEqual(parseGlossaryEntries(merged), merged, 'model constructors can validate the merged snapshot');
});

test('relevance selects current/recent language spellings and Korean particles without substring matches', () => {
  const lf = { id: 'lf', sourceTerm: 'LF', translations: { en: 'Example Group' } };
  const names = participantNamesToGlossary([{ ko: '예시이름', ru: 'Тестель' }, { en: 'Anna' }]);
  const entries = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: [lf, ...names] });
  assert.deepEqual(selectRelevantGlossary(entries, ['myself and selfless people']), []);
  const selected = selectRelevantGlossary(entries, ['예시이름이 은혜를 설명했습니다. 성령께서 함께하십니다.', 'LF and Тестель discussed grace.']);
  assert.ok(selected.some((item) => item.id === 'participant-1'));
  assert.ok(selected.some((item) => item.id === 'christian.grace'));
  assert.ok(selected.some((item) => item.id === 'christian.holy-spirit'));
  assert.ok(selected.some((item) => item.id === 'lf'));
  assert.ok(!selected.some((item) => item.id === 'participant-2'));
  assert.equal(selectRelevantGlossary(entries, ['БЛАГОДАТЬ'], 1)[0]?.id, 'christian.grace');
  assert.equal(selectRelevantGlossary(entries, ['은혜로운'], 1).length, 0);
  assert.equal(selectRelevantGlossary(entries, ['예시이름입니다.'], 1)[0]?.id, 'participant-1');
  assert.equal(selectRelevantGlossary(entries, ['제가 예시이름이라고 합니다.'], 1)[0]?.id, 'participant-1');
  assert.equal(selectRelevantGlossary(entries, ['예시이름이는다른단어'], 1).length, 0);
  assert.equal(selectRelevantGlossary(entries, ['은혜'], 0).length, 0);
});

test('custom and participant STT hints precede defaults, deduplicate case and respect the API bound', () => {
  const names = participantNamesToGlossary([{ ko: '예시이름', ru: 'Тестель' }, { en: 'Anna' }]);
  assert.deepEqual(names[0]?.translations, { ko: '예시이름', ru: 'Тестель' });
  const entries = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: names });
  const hints = buildTranscriptionHints(entries, ['Grace', '예시이름']);
  assert.deepEqual(hints.keywords.slice(0, 2), ['Grace', '예시이름']);
  assert.ok(hints.keywords.includes('Тестель'));
  assert.equal(hints.keywords.filter((word) => word.toLowerCase() === 'grace').length, 1);
  assert.equal(hints.keywords.length, 50);
});

test('large participant catalogs remain available to translation while outgoing STT hints stay bounded', () => {
  const names = participantNamesToGlossary(Array.from({ length: 42 }, (_, index) => ({
    ko: `참가자 ${index}`, ru: `Participant ${index}`,
  })));
  const merged = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: names });
  assert.equal(merged.length, names.length + BUILT_IN_GLOSSARY.length);
  assert.equal(buildTranscriptionHints(merged).keywords.length, 50);
  assert.ok(buildTranscriptionHints(merged).keywords.includes('참가자 0'));
  assert.ok(!buildTranscriptionHints(merged).keywords.includes('참가자 41'));
  assert.equal(selectRelevantGlossary(merged, ['참가자 0'], 1)[0]?.id, 'participant-1');
});

test('validation produces immutable snapshots and rejects malformed CRUD data without echoing it', () => {
  const source = [{ id: 'valid', sourceTerm: 'LF', translations: { ko: 'LF' } }];
  const snapshot = parseGlossaryEntries(source);
  source[0]!.translations.ko = 'mutated';
  assert.equal(snapshot[0]?.translations.ko, 'LF');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot[0]?.translations));
  for (const invalid of [{}, [null], [{ id: 'x', sourceTerm: '<secret>', translations: {} }],
    [{ id: 'x', sourceTerm: 'valid', sourceLanguage: 'bad_language', translations: {} }],
    [{ id: 'x', sourceTerm: 'valid', translations: { ru: '' } }],
    [{ id: 'x', sourceTerm: 'valid', translations: {}, instruction: 'secret' }],
    [{ id: 'x', sourceTerm: 'valid', translations: {} }, { id: 'x', sourceTerm: 'duplicate', translations: {} }]]) {
    assert.throws(() => parseGlossaryEntries(invalid), (error) => {
      assert.ok(error instanceof GlossaryError);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('optional UTF-8 custom file supports an absent file and reports malformed configuration', (t) => {
  const root = resolve('.tools/glossary-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'glossary-'));
  t.after(() => { assert.equal(dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'glossary.json');
  assert.deepEqual(loadCustomGlossary(path), []);
  writeFileSync(path, '\uFEFF' + JSON.stringify({ custom: [{ id: 'name', sourceTerm: '예시이름', translations: { ru: 'Тестель' } }] }), 'utf8');
  assert.equal(loadCustomGlossary(path)[0]?.translations.ru, 'Тестель');
  writeFileSync(path, '{"custom": [secret]', 'utf8');
  assert.throws(() => loadCustomGlossary(path), GlossaryError);
  writeFileSync(path, '{"builtIn": []}', 'utf8');
  assert.throws(() => loadCustomGlossary(path), GlossaryError);
});

test('simple glossary files preserve language maps and integrate with names, STT hints and translation selection', (t) => {
  const root = resolve('.tools/glossary-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'simple-'));
  t.after(() => { assert.equal(dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'glossary.json');
  const simple = [{ ko: ' 카자흐스탄 ', ru: 'Казахстан' }, { ko: '카작' }, { ru: 'Половина', kk: 'Шала' }];
  writeFileSync(path, '\uFEFF' + JSON.stringify(simple), 'utf8');
  const entries = loadCustomGlossary(path);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.sourceLanguage, 'ko');
  assert.equal(entries[0]?.sourceTerm, '카자흐스탄');
  assert.deepEqual(entries[0]?.translations, { ko: '카자흐스탄', ru: 'Казахстан' });
  assert.deepEqual(entries[1]?.translations, { ko: '카작' });
  assert.deepEqual(entries[2]?.translations, { ru: 'Половина', kk: 'Шала' });
  assert.ok(Object.isFrozen(entries[0]?.translations));
  writeFileSync(path, JSON.stringify([...simple].reverse()), 'utf8');
  assert.deepEqual(loadCustomGlossary(path).map(entry => entry.id), entries.map(entry => entry.id).reverse());
  const names = participantNamesToGlossary([{ ko: '예시이름', ru: 'Тестель' }]);
  const merged = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: [...names, ...entries] });
  const hints = buildTranscriptionHints(merged);
  assert.ok(hints.keywords.includes('Казахстан'));
  assert.ok(hints.keywords.includes('Тестель'));
  assert.ok(selectRelevantGlossary(merged, ['카자흐스탄에서 예시이름이 이야기했습니다.']).some(entry => entry.translations.ru === 'Казахстан'));
  writeFileSync(path, JSON.stringify([{ ko: '은혜', kk: 'custom grace' }]), 'utf8');
  const overridden = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY, custom: loadCustomGlossary(path) });
  const grace = overridden.find(entry => entry.sourceTerm === '은혜')!;
  assert.equal(grace.translations.kk, 'custom grace');
  assert.equal(grace.translations.en, 'grace');
});

test('simple glossary validation rejects malformed maps and duplicates without echoing content', (t) => {
  const root = resolve('.tools/glossary-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'invalid-simple-'));
  t.after(() => { assert.equal(dirname(dir), root); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'glossary.json');
  for (const invalid of [[null], [{}], [['private-secret']], [{ ko: '' }], [{ ko: 42 }],
    [{ bad_language: 'private-secret' }], [{ ko: '<private-secret>' }], [{ ko: 'a\nb' }],
    [{ ko: 'x'.repeat(81) }], [{ ko: 'Same' }, { ko: ' same ' }],
    [Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`a${String.fromCharCode(97 + index)}`, 'word']))],
    Array.from({ length: 201 }, (_, index) => ({ ko: `term ${index}` }))]) {
    writeFileSync(path, JSON.stringify(invalid), 'utf8');
    assert.throws(() => loadCustomGlossary(path), error => {
      assert.ok(error instanceof GlossaryError);
      assert.ok(!error.message.includes('private-secret'));
      return true;
    });
  }
  writeFileSync(path, '[]', 'utf8');
  assert.deepEqual(loadCustomGlossary(path), []);
});
