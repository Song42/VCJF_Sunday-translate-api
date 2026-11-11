import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import opus from '@discordjs/opus';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import { VoiceCapture, type AudioDiagnostic } from '../src/audio.js';

const { OpusEncoder } = opus;

class FakeReceiver {
  readonly speaking = Object.assign(new EventEmitter(), { users: new Map<string, number>() });
  readonly subscriptions = new Map<string, Readable>();
  readonly calls: { userId: string; options: unknown }[] = [];

  subscribe(userId: string, options: unknown): Readable {
    const existing = this.subscriptions.get(userId);
    if (existing) return existing;
    this.calls.push({ userId, options });
    const stream = new Readable({ read() {} });
    stream.once('close', () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, stream);
    return stream;
  }

  speak(userId: string): void {
    this.speaking.users.set(userId, Date.now());
    this.speaking.emit('start', userId);
  }

  send(userId: string, packet: Buffer): void {
    // Emit synchronously to exercise late queued data around stop/revoke.
    this.subscriptions.get(userId)?.emit('data', Buffer.from(packet));
  }
}

function stereoOpus(): Buffer {
  const encoder = new OpusEncoder(48_000, 2);
  const pcm = Buffer.alloc(960 * 2 * 2);
  for (let i = 0; i < 960; i += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48_000) * 10_000);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  const encoded = encoder.encode(pcm);
  pcm.fill(0);
  return encoded;
}

function harness(allowed = new Set(['A', 'B'])) {
  const receiver = new FakeReceiver();
  const diagnostics: AudioDiagnostic[] = [];
  const capture = new VoiceCapture(receiver as unknown as VoiceReceiver, {
    canReceive: (id) => allowed.has(id),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  return { receiver, capture, diagnostics, allowed };
}

test('native libopus converts a 20 ms stereo 48 kHz packet to mono 24 kHz PCM', () => {
  const decoder = new OpusEncoder(24_000, 1);
  const pcm = decoder.decode(stereoOpus());
  assert.equal(pcm.length, 480 * 2);
  assert.ok(pcm.some((byte) => byte !== 0));
  pcm.fill(0);
});

test('interleaved speakers remain distinct without duplicate subscriptions', () => {
  const { receiver, capture, diagnostics } = harness();
  const packet = stereoOpus();
  capture.start();
  receiver.speak('A');
  receiver.speak('B');
  receiver.speak('A');
  receiver.send('A', packet);
  receiver.send('B', packet);
  receiver.send('A', packet);
  const summary = capture.stop();
  assert.equal(receiver.calls.length, 2);
  assert.deepEqual(receiver.calls[0]?.options, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 850 },
  });
  assert.equal(summary.speakers.A?.packets, 2);
  assert.equal(summary.speakers.A?.audioMs, 40);
  assert.equal(summary.speakers.B?.audioMs, 20);
  assert.equal(summary.totalPcmBytes, 2_880);
  assert.equal(summary.totalAudioMs, 60);
  assert.equal(summary.activeSpeakers, 0);
  assert.ok(diagnostics.every((item) => Object.values(item).every(
    (value) => value === undefined || ['string', 'number', 'boolean'].includes(typeof value),
  )));
});

test('captures existing speakers, rejects outsiders, revokes membership immediately', () => {
  const { receiver, capture, allowed } = harness();
  receiver.speaking.users.set('A', 1);
  capture.start();
  receiver.speak('outsider');
  assert.equal(receiver.calls.length, 1);
  const packet = stereoOpus();
  receiver.send('A', packet);
  allowed.delete('A');
  receiver.send('A', packet);
  assert.equal(capture.snapshot().totalPackets, 1);
  assert.equal(capture.snapshot().activeSpeakers, 0);
  capture.stop();
});

test('running start rescans speakers after a connection recovers without duplicate listeners', () => {
  const { receiver, capture, allowed } = harness(new Set());
  capture.start();
  receiver.speak('A');
  assert.equal(receiver.calls.length, 0);
  allowed.add('A');
  capture.start();
  capture.start();
  assert.equal(receiver.calls.length, 1);
  assert.equal(receiver.speaking.listenerCount('start'), 1);
  receiver.send('A', stereoOpus());
  assert.equal(capture.stop().speakers.A?.audioMs, 20);
});

test('malformed packet does not poison later audio or another speaker', () => {
  const { receiver, capture } = harness();
  capture.start();
  receiver.speak('A');
  receiver.speak('B');
  receiver.send('A', Buffer.from([0xff]));
  receiver.send('A', stereoOpus());
  receiver.send('B', stereoOpus());
  const summary = capture.stop();
  assert.equal(summary.decodeErrors, 1);
  assert.equal(summary.speakers.A?.audioMs, 20);
  assert.equal(summary.speakers.B?.audioMs, 20);
});

test('stop is terminal, ignores late packets, detaches speaking listeners, returns copies', () => {
  const { receiver, capture } = harness();
  capture.start();
  receiver.speak('A');
  const stream = receiver.subscriptions.get('A')!;
  receiver.send('A', stereoOpus());
  const stopped = capture.stop();
  capture.start();
  stream.emit('data', stereoOpus());
  receiver.speak('B');
  assert.equal(receiver.speaking.listenerCount('start'), 0);
  assert.equal(receiver.calls.length, 1);
  assert.deepEqual(capture.snapshot(), stopped);
  stopped.speakers.A!.packets = 999;
  assert.equal(capture.snapshot().speakers.A?.packets, 1);
});

test('stream errors are isolated and stop cancels transport retries', async () => {
  const { receiver, capture, diagnostics } = harness();
  capture.start();
  receiver.speak('A');
  receiver.speak('B');
  receiver.subscriptions.get('A')!.destroy(new Error('must not appear in diagnostics'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  receiver.send('B', stereoOpus());
  const stopped = capture.stop();
  assert.equal(stopped.receiveErrors, 1);
  assert.equal(stopped.speakers.B?.audioMs, 20);
  assert.ok(!JSON.stringify(diagnostics).includes('must not appear'));
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(receiver.calls.length, 2);
});

test('a speaker can return after a completed receive stream', async () => {
  const { receiver, capture } = harness();
  capture.start();
  receiver.speak('A');
  receiver.send('A', stereoOpus());
  receiver.speaking.users.delete('A');
  const stream = receiver.subscriptions.get('A')!;
  stream.emit('end');
  stream.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  receiver.speak('A');
  receiver.send('A', stereoOpus());
  assert.equal(capture.stop().speakers.A?.audioMs, 40);
  assert.equal(receiver.calls.length, 2);
});

test('speech between stream end and close is resubscribed once close releases the old stream', async () => {
  const { receiver, capture } = harness();
  capture.start();
  receiver.speak('A');
  receiver.send('A', stereoOpus());
  receiver.subscriptions.get('A')!.emit('end');
  receiver.speak('A');
  await new Promise((resolve) => setTimeout(resolve, 75));
  receiver.send('A', stereoOpus());
  assert.equal(receiver.calls.length, 2);
  assert.equal(capture.stop().speakers.A?.audioMs, 40);
});

test('consumer gets borrowed nonzero PCM then the buffer is wiped; end reason is explicit', () => {
  const receiver = new FakeReceiver();
  const borrowed: Buffer[] = [];
  const ends: string[] = [];
  const capture = new VoiceCapture(receiver as unknown as VoiceReceiver, {
    canReceive: () => true,
    onDiagnostic: () => {},
    onPcm: (_id, pcm) => {
      assert.ok(pcm.some((byte) => byte !== 0));
      borrowed.push(pcm);
    },
    onUtteranceEnd: (id, reason) => ends.push(`${id}:${reason}`),
  });
  capture.start();
  receiver.speak('A');
  receiver.send('A', stereoOpus());
  assert.ok(borrowed[0]!.every((byte) => byte === 0));
  capture.removeSpeaker('A');
  assert.deepEqual(ends, ['A:left']);
  receiver.speak('B');
  receiver.send('B', stereoOpus());
  capture.stop();
  assert.deepEqual(ends, ['A:left', 'B:stop']);
});

test('consumer failure does not count as an Opus decode error or leak PCM', () => {
  const receiver = new FakeReceiver();
  const diagnostics: string[] = [];
  let borrowed: Buffer | undefined;
  const capture = new VoiceCapture(receiver as unknown as VoiceReceiver, {
    canReceive: () => true,
    onDiagnostic: ({ event }) => diagnostics.push(event),
    onPcm: (_id, pcm) => { borrowed = pcm; throw new Error('sensitive provider error'); },
  });
  capture.start();
  receiver.speak('A');
  receiver.send('A', stereoOpus());
  assert.equal(capture.stop().decodeErrors, 0);
  assert.ok(diagnostics.includes('audio_consumer_error'));
  assert.ok(borrowed!.every((byte) => byte === 0));
});
