import assert from 'node:assert/strict';
import { CAPTION_LANGUAGE_POLICY } from '../src/caption-language-policy.js';
import test from 'node:test';
import { AccuracyReviewError, OpenAIAccuracyReviewer, reviewReasons,
  type AccuracyReviewErrorCode, type ReviewRequest } from '../src/accuracy-review.js';
import { BUILT_IN_GLOSSARY, participantNamesToGlossary } from '../src/glossary.js';
import type { Translations } from '../src/translate.js';

const options = { apiKey: 'secret-test-key', model: 'gpt-6.1-terra' };
const initial: Translations = { ko: '회의는 십오 분이 아닙니다.', ru: 'Встреча не на пятнадцать минут.',
  kk: 'Жиналыс он бес минут емес.', en: 'The meeting is fifteen minutes.' };
function input(): ReviewRequest {
  return { originalText: '회의는 십오 분이 아닙니다.', translations: { ...initial },
    sourceTranscripts: [{ id: 'source-1', text: '회의는 십오 분이 아닙니다. 다음 모임은 내일입니다.' }],
    conversation: { recent: [], summary: '' }, glossary: [], reasons: ['late_negation'], signal: new AbortController().signal };
}
function response(overrides: { translations?: Translations; changed?: boolean; uncertain?: boolean } = {}): unknown {
  return { status: 'completed', usage: { input_tokens: 100, output_tokens: 120 },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
      text: JSON.stringify({ translations: initial, changed: false, uncertain: false, ...overrides }) }] }] };
}

test('review keeps exactly the active language set and ignores inactive glossary translations', async () => {
  const request = input();
  delete request.translations.en;
  const reviewer = new OpenAIAccuracyReviewer(options, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.text.format.schema.properties.translations.required, ['ko', 'ru', 'kk']);
    assert.equal(body.text.format.schema.properties.translations.properties.en, undefined);
    return Response.json(response({ translations: request.translations }));
  });
  assert.deepEqual((await reviewer.review(request)).translations, request.translations);
  const extra = new OpenAIAccuracyReviewer(options, async () => Response.json(response()));
  await assert.rejects(extra.review(request), AccuracyReviewError);
  const entry = { id: 'test', sourceTerm: 'grace', translations: { en: 'grace', ko: '은혜' } };
  assert.deepEqual(reviewReasons({ originalText: 'grace', translations: { ko: '은혜' } }, [entry]), []);
});
function code(expected: AccuracyReviewErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof AccuracyReviewError);
    assert.equal(error.code, expected);
    assert.ok(!JSON.stringify(error).includes(options.apiKey));
    assert.ok(!error.message.includes('provider-private'));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('text-only review corrects translation without claiming new source evidence, and reserves exact payload ceiling', async () => {
  const request = input();
  const corrected = { ...initial, en: 'The meeting is not fifteen minutes.' };
  let sent = '';
  const reviewer = new OpenAIAccuracyReviewer(options, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    sent = String(init?.body);
    const payload = JSON.parse(sent);
    assert.equal(payload.store, false);
    assert.ok(payload.instructions.includes(CAPTION_LANGUAGE_POLICY));
    assert.equal(payload.reasoning.effort, 'low');
    assert.equal(payload.text.format.strict, true);
    assert.equal(payload.text.format.schema.additionalProperties, false);
    assert.deepEqual(payload.text.format.schema.required, ['translations', 'changed', 'uncertain']);
    const data = JSON.parse(payload.input[0].content);
    assert.equal(data.evidence_mode, 'text_only');
    assert.equal(data.independent_transcript, undefined);
    assert.equal(data.target_original_text, request.originalText);
    assert.equal(data.source_transcripts[0].text, request.sourceTranscripts[0]?.text);
    assert.match(payload.instructions, /Never expand this caption/);
    assert.match(payload.instructions, /never claim a source recognition error is proven/);
    return Response.json(response({ translations: corrected, changed: true }));
  });
  const estimate = reviewer.estimateUsage(request);
  const result = await reviewer.review(request);
  assert.deepEqual(result, { translations: corrected, changed: true, uncertain: false, inputTokens: 100, outputTokens: 120 });
  assert.equal(estimate.inputTokens, Buffer.byteLength(sent, 'utf8') + 1024);
  assert.equal(estimate.outputTokens, JSON.parse(sent).max_output_tokens);
  assert.equal(request.originalText, input().originalText);
});

test('independent transcription is labeled fallible evidence; uncertain revisions preserve initial text', async () => {
  const request = { ...input(), independentTranscript: '회의는 십오 분입니다. 다음 모임은 내일입니다.' };
  const reviewer = new OpenAIAccuracyReviewer(options, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const data = JSON.parse(payload.input[0].content);
    assert.equal(data.evidence_mode, 'independent_audio_transcript');
    assert.equal(data.independent_transcript, request.independentTranscript);
    assert.match(payload.instructions, /NOT automatically more accurate/);
    assert.match(payload.instructions, /You do not hear audio/);
    return Response.json(response({ translations: { ...initial, ko: '회의는 십오 분입니다.' }, changed: true, uncertain: true }));
  });
  const result = await reviewer.review(request);
  assert.equal(result.uncertain, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.translations, initial);
});

test('ordinary captions do not trigger reviews; conflicts, references and fragile negation do', () => {
  const caption = { originalText: '오늘 함께 이야기합시다.', translations: initial, boundary: 'semantic' as const };
  assert.deepEqual(reviewReasons(caption, BUILT_IN_GLOSSARY), []);
  assert.deepEqual(reviewReasons(caption, [], { transcriptConflict: true, lateNegation: true }), ['transcript_conflict', 'late_negation']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: '사도행전 2장 11절입니다.' }, []), ['bible_reference']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: 'John 3:16' }, []), ['bible_reference']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: 'Деяния, глава 2.' }, []), ['bible_reference']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: '말하지 않았습니다.', boundary: 'timeout' }, []), ['negation_at_forced_boundary']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: 'Это не решение.', boundary: 'gap' }, []), ['negation_at_forced_boundary']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: 'Бұл шешім емес.', boundary: 'limit' }, []), ['negation_at_forced_boundary']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: '말하지 않았습니다.' }, []), []);
});

test('registered name mismatch is a review candidate, while common inflections do not force reviews', () => {
  const glossary = participantNamesToGlossary([{ ko: '예시이름', ru: 'Тестель' }]);
  const caption = { originalText: '예시이름이 말했습니다.', translations: { ko: '예시이름이 말했습니다.',
    ru: 'Слова Тестели.', kk: 'Тестель айтты.', en: 'TestName said it.' } };
  assert.deepEqual(reviewReasons(caption, glossary), []);
  assert.deepEqual(reviewReasons({ ...caption, translations: { ...caption.translations, ru: 'Асир сказал.' } }, glossary), ['glossary_mismatch']);
  assert.deepEqual(reviewReasons({ ...caption, translations: { ...caption.translations, ru: 'ПраТестелиДругой сказал.' } }, glossary), ['glossary_mismatch']);
  assert.deepEqual(reviewReasons({ ...caption, originalText: '다른 사람이 말했습니다.' }, glossary), []);
});

test('short preferred terms must match word boundaries in translations', () => {
  const glossary = [{ id: 'lf', sourceTerm: 'LF', translations: { en: 'LF' } }];
  const caption = { originalText: 'LF 모임입니다.', translations: { ...initial, en: 'A self meeting.' } };
  assert.deepEqual(reviewReasons(caption, glossary), ['glossary_mismatch']);
  assert.deepEqual(reviewReasons({ ...caption, translations: { ...caption.translations, en: 'An LF meeting.' } }, glossary), []);
});

test('strict response validation rejects contradictory changed flags, extra source rewrites and incomplete billing', async () => {
  const contradictory = response({ changed: true });
  const extra = response() as { output: { content: { text: string }[] }[] };
  extra.output[0]!.content[0]!.text = JSON.stringify({ translations: initial, changed: false, uncertain: false, originalText: 'invented' });
  const badUsage = { ...(response() as object), usage: { input_tokens: 10, output_tokens: -1 } };
  for (const body of [contradictory, extra, badUsage]) {
    const reviewer = new OpenAIAccuracyReviewer(options, async () => Response.json(body));
    await assert.rejects(reviewer.review(input()), code('review_invalid_response'));
  }
});

test('review failures report safe error codes without provider bodies or credentials', async () => {
  const cases = [[401, 'review_auth'], [403, 'review_model'], [429, 'review_rate_limit'],
    [408, 'review_timeout'], [500, 'review_service_unavailable']] as const;
  for (const [status, expected] of cases) {
    const reviewer = new OpenAIAccuracyReviewer(options, async () => new Response('provider-private', { status }));
    await assert.rejects(reviewer.review(input()), code(expected));
  }
  await assert.rejects(new OpenAIAccuracyReviewer(options, async () => { throw new Error(options.apiKey); }).review(input()), code('review_network'));
  await assert.rejects(new OpenAIAccuracyReviewer(options, async () => new Response('provider-private')).review(input()), code('review_invalid_response'));
});

test('timeout and cancellation cannot emit a late result even if a transport ignores abort', async () => {
  const reviewer = new OpenAIAccuracyReviewer({ ...options, timeoutMs: 10 }, async () => new Promise(() => {}));
  await assert.rejects(reviewer.review(input()), code('review_timeout'));
  const controller = new AbortController();
  let resolve: ((response: Response) => void) | undefined;
  const late = new OpenAIAccuracyReviewer(options, async () => new Promise<Response>((done) => { resolve = done; }));
  const pending = late.review({ ...input(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, code('review_aborted'));
  resolve?.(Response.json(response()));
});

test('invalid requests fail before network use and oversized responses are bounded', async () => {
  let called = false;
  const reviewer = new OpenAIAccuracyReviewer(options, async () => { called = true; return Response.json(response()); });
  await assert.rejects(reviewer.review({ ...input(), originalText: '' }), code('review_invalid_request'));
  assert.equal(called, false);
  const bounded = new OpenAIAccuracyReviewer(options, async () => new Response('private', { headers: { 'content-length': String(600 * 1024) } }));
  await assert.rejects(bounded.review(input()), code('review_invalid_response'));
});
