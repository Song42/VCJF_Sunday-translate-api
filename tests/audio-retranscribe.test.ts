import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAudioRetranscriber, pcmToWav, RetranscriptionError } from '../src/audio-retranscribe.js';

const options = { apiKey: 'private-api-key' };
function input() { return { pcm: Buffer.alloc(48_000, 42), signal: new AbortController().signal,
  prompt: 'Christian fellowship', keywords: ['예시이름', 'Тестель'], languages: ['ko', 'ru', 'kk', 'en'] }; }

test('independent rerec sends only PCM audio and domain hints as WAV multipart with the accurate model', async () => {
  const request = input();
  const transcriber = new OpenAIAudioRetranscriber(options, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-api-key');
    assert.equal(new Headers(init?.headers).get('Content-Type'), null);
    const body = init?.body as FormData;
    assert.equal(body.get('model'), 'gpt-transcribe');
    assert.equal(body.get('response_format'), 'json');
    assert.deepEqual(body.getAll('keywords[]'), ['예시이름', 'Тестель']);
    assert.deepEqual(body.getAll('languages[]'), ['ko', 'ru', 'kk', 'en']);
    assert.equal(body.has('transcript'), false);
    const file = body.get('file') as File;
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt16LE(34), 16); assert.deepEqual(wav.subarray(44), request.pcm);
    return Response.json({ text: '  예시이름입니다.  ' });
  });
  assert.deepEqual(await transcriber.transcribe(request), { text: '예시이름입니다.' });
  assert.ok(request.pcm.every((value) => value === 42), 'caller audio is not destroyed');
});

test('invalid audio or hints are rejected before any paid request', async () => {
  let called = false;
  const transcriber = new OpenAIAudioRetranscriber(options, async () => { called = true; return Response.json({ text: '' }); });
  for (const pcm of [Buffer.alloc(0), Buffer.alloc(4799), Buffer.alloc(4801), Buffer.alloc(30 * 48_000 + 2)]) {
    assert.throws(() => pcmToWav(pcm), RetranscriptionError);
  }
  await assert.rejects(transcriber.transcribe({ ...input(), keywords: ['<private>'] }), RetranscriptionError);
  await assert.rejects(transcriber.transcribe({ ...input(), languages: ['invalid-private'] }), RetranscriptionError);
  assert.equal(called, false);
});

test('HTTP and malformed response failures expose safe codes and no raw audio or provider text', async () => {
  for (const [status, code] of [[401, 'retranscription_auth'], [404, 'retranscription_model'], [429, 'retranscription_rate_limit'], [500, 'retranscription_provider']] as const) {
    const transcriber = new OpenAIAudioRetranscriber(options, async () => new Response('private provider text', { status }));
    await assert.rejects(transcriber.transcribe(input()), (error) => error instanceof RetranscriptionError && error.code === code && !String(error).includes('private'));
  }
  for (const body of [{ text: 123 }, { text: 'x'.repeat(50_001) }, ['private']]) {
    const transcriber = new OpenAIAudioRetranscriber(options, async () => Response.json(body));
    await assert.rejects(transcriber.transcribe(input()), (error) => error instanceof RetranscriptionError && error.code === 'retranscription_response');
  }
});

test('cancellation and timeout suppress late results without modifying caller PCM', async () => {
  const controller = new AbortController();
  const transcriber = new OpenAIAudioRetranscriber(options, async () => { controller.abort(); return Response.json({ text: 'late' }); });
  await assert.rejects(transcriber.transcribe({ ...input(), signal: controller.signal }), (error) => error instanceof RetranscriptionError && error.code === 'retranscription_aborted');
  const slow = new OpenAIAudioRetranscriber({ ...options, timeoutMs: 5 }, async (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private network error')), { once: true })));
  await assert.rejects(slow.transcribe(input()), (error) => error instanceof RetranscriptionError && error.code === 'retranscription_timeout');
});
