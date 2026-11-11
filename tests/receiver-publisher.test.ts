import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiverPublisher, readReceiverConfig, ReceiverConfigurationError, type ReceiverEvent } from '../src/receiver-publisher.js';
import type { Caption } from '../src/types.js';

const token = 'test-only-receiver-token-with-32-characters';
const options = { url: 'http://localhost:3000', token };
const caption = (revision = 0): Caption => ({ type: 'caption', segmentId: 'live-1', sequence: 1,
  speakerId: 'private-discord-id', speakerName: '예시이름', originalText: `원문 ${revision}`,
  translations: { ko: `한국어 ${revision}`, ru: 'Русский', en: 'English' }, createdAt: 123456,
  status: 'draft', revision, recording: { path: 'secret-recording.wav', metadataPath: 'secret.json', alignment: 'source-turn' } });
function transport(handler: (event: ReceiverEvent) => Promise<Response> | Response): typeof fetch {
  return (async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    return handler(JSON.parse(String(init?.body)) as ReceiverEvent);
  }) as typeof fetch;
}

test('receiver configuration is optional and prevents tokens on non-local plain HTTP or URL credentials', () => {
  assert.equal(readReceiverConfig({}), undefined);
  assert.deepEqual(readReceiverConfig({ RECEIVER_URL: 'https://captions.example.com/', RECEIVER_TOKEN: token }),
    { url: 'https://captions.example.com', token });
  for (const env of [
    { RECEIVER_URL: 'http://localhost:3000' }, { RECEIVER_TOKEN: token },
    { RECEIVER_URL: 'http://captions.example.com', RECEIVER_TOKEN: token },
    { RECEIVER_URL: 'https://user:secret@example.com', RECEIVER_TOKEN: token },
    { RECEIVER_URL: 'https://example.com/?token=secret', RECEIVER_TOKEN: token },
    { RECEIVER_URL: 'https://example.com', RECEIVER_TOKEN: 'short-secret' },
  ]) assert.throws(() => readReceiverConfig(env), error => {
    assert.ok(error instanceof ReceiverConfigurationError);
    assert.ok(!error.message.includes(token)); assert.ok(!error.message.includes('short-secret')); return true;
  });
});

test('session precedes captions, coalescing keeps latest revision, and private fields never leave the bot', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: ReceiverEvent[] = [];
  const publisher = new ReceiverPublisher({ ...options, fetch: transport(async event => {
    events.push(event); if (event.type === 'session') await blocked; return new Response(null, { status: 204 });
  }) });
  const sessionId = publisher.startSession('모임', ['ko', 'ru']);
  publisher.publish(caption(0)); publisher.publish(caption(1)); publisher.publish(caption(2));
  publisher.publish(caption(1)); // A late stale revision cannot overwrite the latest one.
  publisher.endSession(); release();
  assert.equal(await publisher.waitForIdle(), true);
  assert.deepEqual(events.map(event => event.type), ['session', 'caption', 'end']);
  const sent = events[1]; assert.equal(sent?.type, 'caption');
  if (sent?.type !== 'caption') throw new Error('Missing caption');
  assert.equal(sent.sessionId, sessionId); assert.equal(sent.caption.revision, 2);
  assert.deepEqual(sent.caption.translations, { ko: '한국어 2', ru: 'Русский' });
  assert.ok(!JSON.stringify(events).includes('private-discord-id'));
  assert.ok(!JSON.stringify(events).includes('secret-recording'));
  await publisher.close();
});

test('same-revision finalization replaces an initial caption and queued history remains bounded', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: ReceiverEvent[] = [];
  const publisher = new ReceiverPublisher({ ...options, fetch: transport(async event => {
    events.push(event); if (event.type === 'session') await blocked; return new Response(null, { status: 204 });
  }) });
  publisher.startSession('모임', ['ko']);
  for (let sequence = 1; sequence <= 250; sequence++) publisher.publish({ ...caption(), sequence, segmentId: `live-${sequence}` });
  publisher.publish({ ...caption(), sequence: 250, segmentId: 'live-250', status: 'initial' });
  publisher.publish({ ...caption(), sequence: 250, segmentId: 'live-250', status: 'final' });
  publisher.publish({ ...caption(), sequence: 250, segmentId: 'live-250', status: 'draft' });
  release(); assert.equal(await publisher.waitForIdle(), true);
  const sent = events.filter((event): event is Extract<ReceiverEvent, { type: 'caption' }> => event.type === 'caption');
  assert.equal(sent.length, 200); assert.equal(sent[0]!.caption.sequence, 51);
  assert.equal(sent.at(-1)!.caption.status, 'final');
  await publisher.close();
});

test('a receiver restart restores the current session before replaying current revisions', async () => {
  let reject = true;
  const events: ReceiverEvent[] = [];
  const publisher = new ReceiverPublisher({ ...options, retryBaseMs: 1, fetch: transport(event => {
    events.push(event);
    if (event.type === 'caption' && reject) { reject = false; return new Response(null, { status: 409 }); }
    return new Response(null, { status: 204 });
  }) });
  publisher.startSession('모임', ['ko']); publisher.publish(caption());
  assert.equal(await publisher.waitForIdle(), true);
  assert.deepEqual(events.map(event => event.type), ['session', 'caption', 'session', 'caption']);
  await publisher.close();
});

test('new meetings discard old queued captions and shutdown delivery has a deadline', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: ReceiverEvent[] = [];
  const publisher = new ReceiverPublisher({ ...options, fetch: transport(async event => {
    events.push(event); if (events.length === 1) await blocked; return new Response(null, { status: 204 });
  }) });
  const first = publisher.startSession('이전 모임', ['ko']); publisher.publish(caption());
  const second = publisher.startSession('다음 모임', ['ru']);
  publisher.publish({ ...caption(1), segmentId: 'new-1' }); release();
  assert.equal(await publisher.waitForIdle(), true);
  assert.notEqual(first, second);
  assert.ok(events.filter(event => event.type === 'caption').every(event => event.sessionId === second));
  await publisher.close();
  const hanging = new ReceiverPublisher({ ...options, fetch: transport(() => new Promise(() => {})) });
  hanging.startSession('모임', ['ko']);
  await hanging.close(5); // Even a broken injected fetch that ignores AbortSignal cannot hang shutdown.
});
