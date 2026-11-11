import assert from 'node:assert/strict';
import { CAPTION_LANGUAGE_POLICY } from '../src/caption-language-policy.js';
import test from 'node:test';
import { OpenAIParallelTranslator } from '../src/parallel-translate.js';
import { TranslationError } from '../src/translate.js';
import { BUILT_IN_GLOSSARY } from '../src/glossary.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function drain() { await new Promise<void>((done) => setImmediate(done)); }
const options = { apiKey: 'private-api-key', model: 'gpt-6.1-terra' };
const input = () => ({ originalText: '오늘은 은혜를 이야기합니다.', context: ['지난번에는 회개를 논의했습니다.'], signal: new AbortController().signal,
  conversation: { recent: [{ id: 'previous', speakerId: 'B', speakerName: '예시이름', text: '창세기와 관련된 질문입니다.' }],
    summary: 'Earlier conversation included an unresolved interpretation.' } });
function response(translation: string) {
  return Response.json({ status: 'completed', usage: { input_tokens: 200, output_tokens: 100 }, output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ translation }) }] },
  ] });
}

test('caption wording policy reaches every target without rewriting source or adding moderation calls', async () => {
  const originalText = '씨발, 그 말은 하지 않았어.';
  const request = { ...input(), originalText, provisional: true };
  const before = { originalText: request.originalText, context: [...request.context], conversation: structuredClone(request.conversation) };
  const expected = { ko: '***, 그 말은 하지 않았어.', ru: '***, я этого не говорил.',
    kk: '***, мен олай айтқан жоқпын.', en: '***, I did not say that.' };
  const targets: string[] = [];
  const translator = new OpenAIParallelTranslator(options, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const data = JSON.parse(payload.input[0].content);
    assert.ok(payload.instructions.includes(CAPTION_LANGUAGE_POLICY));
    assert.equal(data.target_utterance, originalText);
    assert.equal(data.provisional, true);
    assert.deepEqual(data.previous_utterances, before.context);
    targets.push(data.target_language);
    return response(expected[data.target_language as keyof typeof expected]);
  });
  const result = await translator.translate(request);
  assert.deepEqual(targets, ['ko', 'ru', 'kk', 'en']);
  assert.deepEqual(result.translations, expected);
  assert.equal(request.originalText, before.originalText);
  assert.deepEqual(request.context, before.context);
  assert.deepEqual(request.conversation, before.conversation);
  // Mock responses verify routing and source preservation, not real model classification accuracy.
});

test('disabled English makes no request and contributes no reserved or actual tokens', async () => {
  const bodies: string[] = [];
  const translator = new OpenAIParallelTranslator({ ...options, targetLanguages: ['ko', 'ru', 'kk'] }, async (_url, init) => {
    bodies.push(String(init?.body));
    return response('Translated text.');
  });
  const request = input();
  const estimated = translator.estimateUsage(request);
  const result = await translator.translate(request);
  assert.deepEqual(bodies.map(body => JSON.parse(JSON.parse(body).input[0].content).target_language), ['ko', 'ru', 'kk']);
  assert.deepEqual(Object.keys(result.translations), ['ko', 'ru', 'kk']);
  assert.equal(result.inputTokens, 600);
  assert.equal(result.outputTokens, 300);
  assert.equal(estimated.inputTokens, bodies.reduce((sum, body) => sum + Buffer.byteLength(body) + 1024, 0));
  assert.equal(estimated.outputTokens, bodies.reduce((sum, body) => sum + JSON.parse(body).max_output_tokens, 0));
});

test('explicit reasoning effort is sent in the actual translation request', async () => {
  for (const effort of ['none', 'low', 'medium', 'high'] as const) {
    const translator = new OpenAIParallelTranslator({ ...options, targetLanguages: ['ko'], reasoningEffort: effort }, async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).reasoning, { effort });
      return response('번역');
    });
    await translator.translate(input());
  }
});

test('an English-only output selection sends exactly one request', async () => {
  let calls = 0;
  const translator = new OpenAIParallelTranslator({ ...options, targetLanguages: ['en'] }, async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(JSON.parse(String(init?.body)).input[0].content).target_language, 'en');
    return response('English text.');
  });
  assert.deepEqual((await translator.translate(input())).translations, { en: 'English text.' });
  assert.equal(calls, 1);
});

test('four direct target requests start concurrently with the same source and context and aggregate complete results and cost', async () => {
  const calls: { body: string; signal: AbortSignal | null | undefined; gate: ReturnType<typeof deferred<Response>> }[] = [];
  const translator = new OpenAIParallelTranslator({ ...options, glossary: BUILT_IN_GLOSSARY }, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    const gate = deferred<Response>();
    calls.push({ body: String(init?.body), signal: init?.signal, gate });
    return gate.promise;
  });
  const request = input();
  const reserved = translator.estimateUsage(request);
  let finished = false;
  const work = translator.translate(request).then((value) => { finished = true; return value; });
  assert.equal(calls.length, 4, 'all requests started before any target response');
  const targets = calls.map((call) => JSON.parse(JSON.parse(call.body).input[0].content).target_language);
  assert.deepEqual(targets, ['ko', 'ru', 'kk', 'en']);
  for (const call of calls) {
    const payload = JSON.parse(call.body);
    const data = JSON.parse(payload.input[0].content);
    assert.equal(payload.model, options.model);
    assert.equal(payload.store, false);
    assert.deepEqual(payload.reasoning, { effort: 'medium' });
    assert.deepEqual(payload.text.format.schema.required, ['translation']);
    assert.equal(payload.text.format.strict, true);
    assert.equal(data.target_utterance, request.originalText);
    assert.deepEqual(data.conversation, request.conversation);
    assert.deepEqual(data.previous_utterances, request.context);
    assert.ok(data.glossary.some((entry: { id: string }) => entry.id === 'christian.grace'));
    assert.ok(!data.glossary.some((entry: { id: string }) => entry.id === 'christian.abraham'));
    assert.match(payload.instructions, /Do not first translate through an intermediate language/);
    assert.match(payload.instructions, /never invent words/);
  }
  calls[0]!.gate.resolve(response('한국어 번역'));
  await drain();
  assert.equal(finished, false, 'partial target completion is not reported as a complete caption');
  calls[1]!.gate.resolve(response('Русский перевод'));
  calls[2]!.gate.resolve(response('Қазақша аударма'));
  calls[3]!.gate.resolve(response('English translation'));
  const result = await work;
  assert.deepEqual(result.translations, { ko: '한국어 번역', ru: 'Русский перевод', kk: 'Қазақша аударма', en: 'English translation' });
  assert.equal(result.inputTokens, 800);
  assert.equal(result.outputTokens, 400);
  assert.equal(reserved.inputTokens, calls.reduce((sum, call) => sum + Buffer.byteLength(call.body, 'utf8') + 1024, 0));
  assert.equal(reserved.outputTokens, calls.reduce((sum, call) => sum + JSON.parse(call.body).max_output_tokens, 0));
});

test('one target failure aborts sibling requests and never returns a partial successful translation', async () => {
  const calls: { signal: AbortSignal | null | undefined; gate: ReturnType<typeof deferred<Response>> }[] = [];
  const translator = new OpenAIParallelTranslator(options, async (_url, init) => {
    const gate = deferred<Response>(); calls.push({ signal: init?.signal, gate }); return gate.promise;
  });
  const work = translator.translate(input());
  assert.equal(calls.length, 4);
  calls[0]!.gate.resolve(response('completed one target'));
  calls[1]!.gate.resolve(new Response('private-provider-response', { status: 403 }));
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof TranslationError);
    assert.equal(error.code, 'model_access', 'sibling abort cannot replace the original failure code');
    assert.ok(!error.message.includes('private'));
    return true;
  });
  assert.ok(calls.every((call) => call.signal?.aborted));
  calls[2]!.gate.resolve(response('late Kazakh'));
  calls[3]!.gate.resolve(response('late English'));
  await drain();
});

test('stop and timeout bound all four requests even when a provider never resolves', async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const translator = new OpenAIParallelTranslator(options, async (_url, init) => {
    signals.push(init?.signal); return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const work = translator.translate({ ...input(), signal: controller.signal });
  controller.abort();
  await assert.rejects(work, (error) => error instanceof TranslationError && error.code === 'aborted');
  assert.equal(signals.length, 4);
  assert.ok(signals.every((signal) => signal?.aborted));
  const timeout = new OpenAIParallelTranslator({ ...options, timeoutMs: 10 }, async () => new Promise<Response>(() => {}));
  await assert.rejects(timeout.translate(input()), (error) => error instanceof TranslationError && error.code === 'timeout');
});

test('timeout covers response body streams and cancels unread bodies', async () => {
  let cancelled = 0;
  const translator = new OpenAIParallelTranslator({ ...options, timeoutMs: 10 }, async () => new Response(new ReadableStream({
    cancel() { cancelled += 1; },
  })));
  await assert.rejects(translator.translate(input()), (error) => error instanceof TranslationError && error.code === 'timeout');
  await drain();
  assert.equal(cancelled, 4);
});

test('invalid, refused, oversized and truncated target responses cannot become a complete multilingual result', async () => {
  for (const bad of [
    { status: 'incomplete', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }], usage: { input_tokens: 1, output_tokens: 1 } },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"translation":""}' }] }], usage: { input_tokens: 1, output_tokens: 1 } },
  ]) {
    const translator = new OpenAIParallelTranslator(options, async () => Response.json(bad));
    await assert.rejects(translator.translate(input()), TranslationError);
  }
  const oversized = new OpenAIParallelTranslator(options, async () => new Response('private-data', { headers: { 'Content-Length': String(129 * 1024) } }));
  await assert.rejects(oversized.translate(input()), (error) => error instanceof TranslationError && error.code === 'invalid_response');
});

test('invalid input and pre-aborted requests do not call the API, and network errors omit provider details', async () => {
  let calls = 0;
  const translator = new OpenAIParallelTranslator(options, async () => { calls += 1; throw new Error('private-source private-api-key'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(translator.translate({ ...input(), signal: controller.signal }), TranslationError);
  assert.throws(() => translator.estimateUsage({ ...input(), originalText: '' }), TranslationError);
  assert.equal(calls, 0);
  await assert.rejects(translator.translate(input()), (error) => {
    assert.ok(error instanceof TranslationError);
    assert.equal(error.code, 'network');
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('private'));
    return true;
  });
});
