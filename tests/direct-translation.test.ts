import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { DirectTranslationError, RealtimeDirectTranslator } from '../src/direct-translation.js';
import type { RealtimeSocket } from '../src/stt.js';

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(json: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(json)); callback?.(); }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  event(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
}
function setup(timeoutMs = 1000) {
  const socket = new Socket(); const deltas: unknown[] = [];
  const client = new RealtimeDirectTranslator({ apiKey: 'secret-key', targetLanguage: 'ru', timeoutMs, onTextDelta: (delta) => deltas.push(delta) }, (url, options) => {
    assert.equal(url, 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
    assert.deepEqual(options.headers, { Authorization: 'Bearer secret-key' });
    assert.equal(options.followRedirects, false);
    return socket as unknown as RealtimeSocket;
  });
  return { socket, client, deltas };
}
async function ready(value: ReturnType<typeof setup>) {
  const opening = value.client.connect(); value.socket.open();
  value.socket.event({ type: 'session.updated', session: { type: 'translation', audio: { output: { language: 'ru' } } } });
  await opening;
}

test('direct translation selects one language, appends PCM, drains final deltas without adding spaces or model instructions', async () => {
  const value = setup(); await ready(value);
  assert.deepEqual(value.socket.sent[0]?.session, { audio: { output: { language: 'ru' } } });
  value.client.append(Buffer.alloc(9600));
  assert.equal(value.socket.sent[1]?.type, 'session.input_audio_buffer.append');
  assert.equal(Buffer.from(value.socket.sent[1]?.audio as string, 'base64').length, 9600);
  value.socket.event({ type: 'session.output_transcript.delta', event_id: 'a', delta: 'Благо', elapsed_ms: 200 });
  value.socket.event({ type: 'session.output_transcript.delta', event_id: 'a', delta: 'duplicate', elapsed_ms: 200 });
  const finished = value.client.finish();
  assert.equal(value.socket.sent[2]?.type, 'session.close');
  value.socket.event({ type: 'session.output_transcript.delta', event_id: 'b', delta: 'дать', elapsed_ms: 200 });
  value.socket.event({ type: 'session.output_audio.delta', delta: 'unused' });
  value.socket.event({ type: 'session.closed' });
  assert.equal(await finished, 'Благодать');
  assert.deepEqual(value.deltas, [{ delta: 'Благо', text: 'Благо', elapsedMs: 200 }, { delta: 'дать', text: 'Благодать', elapsedMs: 200 }]);
  value.socket.event({ type: 'session.output_transcript.delta', delta: 'late' });
  assert.equal(value.deltas.length, 2);
});

test('direct close aborts pending work and errors never leak provider text', async () => {
  const value = setup(); await ready(value);
  const finished = value.client.finish();
  const rejected = assert.rejects(finished, (error) => error instanceof DirectTranslationError && error.code === 'direct_auth' && !String(error).includes('secret'));
  value.socket.event({ type: 'error', error: { code: 'invalid_api_key', message: 'secret-key private text' } });
  await rejected;
  const closing = setup(); const connecting = closing.client.connect();
  const aborted = assert.rejects(connecting, DirectTranslationError); closing.client.close(); await aborted;
  closing.socket.open(); assert.equal(closing.socket.sent.length, 0);
});

test('direct stream rejects invalid PCM, backpressure, malformed events and missing graceful-close acknowledgement', async () => {
  const value = setup(); await ready(value);
  assert.throws(() => value.client.append(Buffer.alloc(3)), DirectTranslationError);
  value.socket.bufferedAmount = 1024 * 1024;
  assert.throws(() => value.client.append(Buffer.alloc(9600)), (error) => error instanceof DirectTranslationError && error.code === 'direct_backpressure');
  const malformed = setup(); await ready(malformed);
  const pending = malformed.client.finish();
  const failure = assert.rejects(pending, (error) => error instanceof DirectTranslationError && error.code === 'direct_protocol');
  malformed.socket.event({ type: 'session.output_transcript.delta', delta: 123 }); await failure;
  const timed = setup(5); await ready(timed);
  await assert.rejects(timed.client.finish(), (error) => error instanceof DirectTranslationError && error.code === 'direct_timeout');
});
