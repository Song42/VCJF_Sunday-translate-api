import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { RealtimeTranscriber, SttError, type RealtimeSocket, type RealtimeTranscriberOptions, type SttErrorCode } from '../src/stt.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  terminated = false;
  sendFailure = false;
  send(data: string, callback?: (error?: Error) => void): void {
    if (this.sendFailure) { callback?.(new Error('secret transport error')); return; }
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open'); }
  event(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  terminate(): void { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

function setup(timeoutMs = 1_000) {
  const socket = new FakeSocket();
  const diagnostics: string[] = [];
  let requestedUrl = '';
  let clientOptions: WebSocket.ClientOptions | undefined;
  const stt = new RealtimeTranscriber({
    apiKey: 'test-only-secret-key', model: 'gpt-live-transcribe', timeoutMs,
    onDiagnostic: (event) => diagnostics.push(event),
  }, (url, options) => {
    requestedUrl = url;
    clientOptions = options;
    return socket as unknown as RealtimeSocket;
  });
  return { socket, stt, diagnostics, connection: () => ({ requestedUrl, clientOptions }) };
}

async function ready(context: ReturnType<typeof setup>): Promise<void> {
  const promise = context.stt.connect();
  context.socket.open();
  context.socket.event({ type: 'session.updated', session: { type: 'transcription' } });
  await promise;
}

function isSttError(code: SttErrorCode) {
  return (error: unknown): boolean => error instanceof SttError && error.code === code;
}

function turn(context: ReturnType<typeof setup>): Promise<string> {
  context.stt.append(Buffer.alloc(4_800));
  return context.stt.commit();
}

test('handshake uses transcription intent, multilingual hints and manual PCM turns', async () => {
  const context = setup();
  try {
    const connected = context.stt.connect();
    assert.strictEqual(context.stt.connect(), connected);
    context.socket.open();
    assert.throws(() => context.stt.append(Buffer.alloc(4_800)), isSttError('stt_not_ready'));
    const event = context.socket.sent[0]!;
    assert.equal(event.type, 'session.update');
    assert.deepEqual(event.session, {
      type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        transcription: { model: 'gpt-live-transcribe', languages: ['ko', 'ru', 'kk', 'en'], delay: 'low' },
        turn_detection: null,
      } },
    });
    const connection = context.connection();
    assert.equal(connection.requestedUrl, 'wss://api.openai.com/v1/realtime?intent=transcription');
    assert.deepEqual(connection.clientOptions?.headers, { Authorization: 'Bearer test-only-secret-key' });
    assert.equal(connection.clientOptions?.followRedirects, false);
    context.socket.event({ type: 'session.updated', session: { type: 'transcription' } });
    await connected;
    const result = turn(context);
    assert.equal(context.socket.sent[1]?.type, 'input_audio_buffer.append');
    assert.equal(Buffer.from(context.socket.sent[1]?.audio as string, 'base64').length, 4_800);
    assert.equal(context.socket.sent[2]?.type, 'input_audio_buffer.commit');
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'one' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'partial never shown' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'final' });
    assert.equal(await result, 'final');
    assert.deepEqual(context.diagnostics, ['stt_ready']);
  } finally { context.stt.close(); }
});

test('out-of-order final transcripts map by item ID and duplicate acknowledgements do not shift turns', async () => {
  const context = setup();
  try {
    await ready(context);
    const first = turn(context);
    const second = turn(context);
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'one' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'one' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'two' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'second' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'duplicate' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'first' });
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    const third = turn(context);
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'two' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'three' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'three', transcript: 'third' });
    assert.equal(await third, 'third');
  } finally { context.stt.close(); }
});

test('explicitly empty language hints omit the API field without forcing a single language', async () => {
  const socket = new FakeSocket();
  const stt = new RealtimeTranscriber({
    apiKey: 'test-only-secret-key', model: 'gpt-live-transcribe', languages: [],
  }, () => socket as unknown as RealtimeSocket);
  try {
    const connected = stt.connect();
    socket.open();
    const session = socket.sent[0]!.session as { audio: { input: { transcription: Record<string, unknown> } } };
    assert.equal(Object.hasOwn(session.audio.input.transcription, 'languages'), false);
    assert.equal(Object.hasOwn(session.audio.input.transcription, 'language'), false);
    assert.equal(session.audio.input.transcription.model, 'gpt-live-transcribe');
    socket.event({ type: 'session.updated', session: { type: 'transcription' } });
    await connected;
  } finally { stt.close(); }
});

test('gpt-transcribe uses recording context and manual commits without streaming delay settings', async () => {
  const socket = new FakeSocket();
  const options: RealtimeTranscriberOptions = {
    apiKey: 'test-only-secret-key', model: 'gpt-transcribe',
    prompt: '  A discussion of Discord voice translation.  ',
    keywords: [' Discord ', '', '  ', 'OpenAI'],
  };
  const stt = new RealtimeTranscriber(options, () => socket as unknown as RealtimeSocket);
  // Context has been validated and copied; subsequent caller changes cannot alter it.
  options.prompt = 'changed later';
  options.keywords!.push('<invalid later>');
  try {
    const connected = stt.connect();
    socket.open();
    assert.deepEqual(socket.sent[0]!.session, {
      type: 'transcription', audio: { input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        transcription: {
          model: 'gpt-transcribe', languages: ['ko', 'ru', 'kk', 'en'],
          prompt: 'A discussion of Discord voice translation.', keywords: ['Discord', 'OpenAI'],
        },
        turn_detection: null,
      } },
    });
    socket.event({ type: 'session.updated', session: { type: 'transcription' } });
    await connected;
    stt.append(Buffer.alloc(4_800));
    const result = stt.commit();
    assert.equal(socket.sent[1]?.type, 'input_audio_buffer.append');
    assert.equal(socket.sent[2]?.type, 'input_audio_buffer.commit');
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'contextual' });
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'contextual', transcript: 'Discord' });
    assert.equal(await result, 'Discord');
  } finally { stt.close(); }
});

test('blank optional context is omitted from transcription configuration', async () => {
  const socket = new FakeSocket();
  const stt = new RealtimeTranscriber({
    apiKey: 'test-only-secret-key', model: 'gpt-transcribe', prompt: ' \n ', keywords: ['', '  '],
  }, () => socket as unknown as RealtimeSocket);
  try {
    const connected = stt.connect();
    socket.open();
    const session = socket.sent[0]!.session as { audio: { input: { transcription: Record<string, unknown> } } };
    assert.deepEqual(session.audio.input.transcription, {
      model: 'gpt-transcribe', languages: ['ko', 'ru', 'kk', 'en'],
    });
    socket.event({ type: 'session.updated', session: { type: 'transcription' } });
    await connected;
  } finally { stt.close(); }
});

test('context bounds reject invalid input before opening a socket and redact its content', () => {
  const invalidHints: unknown[] = [
    { prompt: `private-${'x'.repeat(1_000)}` },
    { prompt: 123 },
    { keywords: Array.from({ length: 51 }, () => 'private-keyword') },
    { keywords: [`private-${'x'.repeat(80)}`] },
    { keywords: ['private\rkeyword'] },
    { keywords: ['private\nkeyword'] },
    { keywords: ['private<keyword'] },
    { keywords: ['private>keyword'] },
    { keywords: ['private-keyword', 123] },
    { keywords: 'private-keyword' },
  ];
  for (const hints of invalidHints) {
    let opened = false;
    assert.throws(() => new RealtimeTranscriber({
      apiKey: 'test-only-secret-key', model: 'gpt-transcribe',
      ...hints as Partial<RealtimeTranscriberOptions>,
    }, () => { opened = true; return new FakeSocket() as unknown as RealtimeSocket; }), (error: unknown) => {
      assert.ok(error instanceof SttError);
      assert.equal(error.code, 'stt_configuration');
      assert.ok(!String(error).includes('private'));
      assert.ok(!String(error).includes('test-only-secret-key'));
      return true;
    });
    assert.equal(opened, false);
  }
  const bounded = new RealtimeTranscriber({
    apiKey: 'test-only-secret-key', model: 'gpt-transcribe', prompt: 'x'.repeat(1_000),
    keywords: Array.from({ length: 50 }, () => 'x'.repeat(80)),
  }, () => { throw new Error('constructor must not open a socket'); });
  bounded.close();
});

test('a final arriving before its acknowledgement remains associated with that item', async () => {
  const context = setup();
  try {
    await ready(context);
    const result = turn(context);
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'early', transcript: 'correct' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'early' });
    assert.equal(await result, 'correct');
  } finally { context.stt.close(); }
});

test('a failed identified turn rejects only itself and later turns can continue', async () => {
  const context = setup();
  try {
    await ready(context);
    const first = turn(context);
    const rejected = assert.rejects(first, isSttError('stt_transcription_failed'));
    const second = turn(context);
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'one' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'two' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'one', error: { message: 'private speech', code: 'audio_unintelligible' } });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'second' });
    await rejected;
    assert.equal(await second, 'second');
    assert.equal(context.socket.terminated, false);
    assert.ok(!context.diagnostics.join().includes('private speech'));
  } finally { context.stt.close(); }
});

test('provider errors are redacted and unsupported language hints are not silently changed', async () => {
  const context = setup();
  const connected = context.stt.connect();
  const rejected = assert.rejects(connected, (error: unknown) => {
    assert.ok(error instanceof SttError);
    assert.equal(error.code, 'stt_language_hint');
    assert.ok(!String(error).includes('private speech'));
    assert.ok(!String(error).includes('test-only-secret-key'));
    return true;
  });
  context.socket.open();
  context.socket.event({ type: 'error', error: {
    code: 'invalid_value', param: 'session.audio.input.transcription.languages[2]',
    message: 'private speech test-only-secret-key',
  } });
  await rejected;
  assert.equal(context.socket.sent.length, 1);
  assert.equal(context.socket.terminated, true);
  assert.deepEqual(context.diagnostics, ['stt_language_hint']);
});

test('timeout closes all pending turns so a late acknowledgement cannot bind to new audio', async () => {
  const context = setup(35);
  await ready(context);
  const first = turn(context);
  const second = turn(context);
  await Promise.all([
    assert.rejects(first, isSttError('stt_timeout')),
    assert.rejects(second, isSttError('stt_timeout')),
  ]);
  context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'late' });
  context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: 'stale' });
  assert.equal(context.socket.terminated, true);
  assert.throws(() => context.stt.append(Buffer.alloc(4_800)), isSttError('stt_timeout'));
  await assert.rejects(context.stt.connect(), isSttError('stt_timeout'));
});

test('close during connection and during pending transcription rejects promptly and ignores late messages', async () => {
  const connecting = setup();
  const promise = connecting.stt.connect();
  const rejected = assert.rejects(promise, isSttError('stt_closed'));
  connecting.stt.close();
  await rejected;
  connecting.socket.open();
  assert.equal(connecting.socket.sent.length, 0);
  const active = setup();
  await ready(active);
  const result = turn(active);
  const stopped = assert.rejects(result, isSttError('stt_closed'));
  active.stt.close();
  active.stt.close();
  await stopped;
  active.socket.event({ type: 'input_audio_buffer.committed', item_id: 'late' });
  assert.deepEqual(active.diagnostics, ['stt_ready']);
});

test('malformed and oversized messages fail closed without raw payload diagnostics', async () => {
  for (const message of [Buffer.from('private malformed'), Buffer.alloc(256 * 1024 + 1), Buffer.from('[]')]) {
    const context = setup();
    await ready(context);
    const result = turn(context);
    const failed = assert.rejects(result, isSttError('stt_protocol'));
    context.socket.emit('message', message, false);
    await failed;
    assert.deepEqual(context.diagnostics, ['stt_ready', 'stt_protocol']);
  }
});

test('backpressure, pending-turn cap and short audio never leave an ambiguous live session', async () => {
  const backedUp = setup();
  await ready(backedUp);
  backedUp.socket.bufferedAmount = 1024 * 1024;
  assert.throws(() => backedUp.stt.append(Buffer.alloc(4_800)), isSttError('stt_backpressure'));
  assert.equal(backedUp.socket.sent.length, 1);

  const crowded = setup();
  await ready(crowded);
  const results = Array.from({ length: 4 }, () => turn(crowded));
  const failures = results.map((result) => assert.rejects(result, isSttError('stt_pending_limit')));
  await assert.rejects(turn(crowded), isSttError('stt_pending_limit'));
  await Promise.all(failures);
  assert.equal(crowded.socket.sent.filter((event) => event.type === 'input_audio_buffer.commit').length, 4);

  const short = setup();
  await ready(short);
  short.stt.append(Buffer.alloc(960));
  await assert.rejects(short.stt.commit(), isSttError('stt_audio_too_short'));
  assert.equal(short.socket.terminated, true);
});

test('socket send failures and authentication handshake rejection expose safe codes only', async () => {
  const failedSend = setup();
  await ready(failedSend);
  failedSend.socket.sendFailure = true;
  assert.throws(() => failedSend.stt.append(Buffer.alloc(4_800)), isSttError('stt_transport'));
  assert.ok(!failedSend.diagnostics.join().includes('secret'));

  const denied = setup();
  const promise = denied.stt.connect();
  const rejected = assert.rejects(promise, isSttError('stt_auth'));
  let destroyed = false;
  denied.socket.emit('unexpected-response', {}, { statusCode: 401, destroy: () => { destroyed = true; } });
  await rejected;
  assert.equal(destroyed, true);
  assert.deepEqual(denied.diagnostics, ['stt_auth']);
});

test('live delay is configurable while the committed transcription model never receives delay', async () => {
  for (const model of ['gpt-live-transcribe', 'gpt-transcribe']) {
    const socket = new FakeSocket();
    const stt = new RealtimeTranscriber({ apiKey: 'test-key', model, delay: 'medium' }, () => socket as unknown as RealtimeSocket);
    try {
      const opening = stt.connect(); socket.open();
      const session = socket.sent[0]!.session as { audio: { input: { transcription: Record<string, unknown> } } };
      assert.equal(session.audio.input.transcription.delay, model === 'gpt-live-transcribe' ? 'medium' : undefined);
      socket.event({ type: 'session.updated', session: { type: 'transcription' } }); await opening;
    } finally { stt.close(); }
  }
  assert.throws(() => new RealtimeTranscriber({ apiKey: 'test', model: 'gpt-live-transcribe', delay: 'invalid' as 'low' }), isSttError('stt_configuration'));
});

test('streamed partials accumulate before commit and acquire a safe commit index on acknowledgement', async () => {
  const context = setup();
  const partials: unknown[] = [];
  context.stt.setPartialHandler((partial) => partials.push(partial));
  try {
    await ready(context);
    context.stt.append(Buffer.alloc(4_800));
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', event_id: 'a', delta: '예시이름' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', event_id: 'a', delta: '예시이름' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', event_id: 'b', delta: '입니다.' });
    const first = context.stt.commit();
    const second = turn(context);
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'first' });
    context.socket.event({ type: 'input_audio_buffer.committed', item_id: 'second' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'second', delta: 'Hello' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: 'Hello.' });
    context.socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '아셀입니다.' });
    assert.deepEqual(await Promise.all([first, second]), ['아셀입니다.', 'Hello.']);
    assert.deepEqual(partials, [
      { itemId: 'first', text: '예시이름' }, { itemId: 'first', text: '예시이름입니다.' },
      { itemId: 'first', text: '예시이름입니다.', commitIndex: 1 }, { itemId: 'second', text: 'Hello', commitIndex: 2 },
    ]);
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: 'stale' });
    assert.equal(partials.length, 4);
    context.stt.close();
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'third', delta: 'stale' });
    assert.equal(partials.length, 4);
  } finally { context.stt.close(); }
});

test('malformed or unbounded partial transcripts close without leaking transcript diagnostics', async () => {
  for (const delta of [123, 'private'.repeat(8_000)]) {
    const context = setup(); await ready(context);
    const result = turn(context);
    const failed = assert.rejects(result, isSttError('stt_protocol'));
    context.socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta });
    await failed;
    assert.ok(!context.diagnostics.join().includes('private'));
  }
});
