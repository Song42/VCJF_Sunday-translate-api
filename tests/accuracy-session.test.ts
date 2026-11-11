import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AccuracySession } from '../src/accuracy-session.js';
import type { Reviewer, ReviewRequest, ReviewResult } from '../src/accuracy-review.js';
import type { AudioRetranscriber, AudioRetranscriptionRequest, AudioRetranscriptionResult } from '../src/audio-retranscribe.js';
import type { Caption } from '../src/types.js';
import { UsageLimitError, type Usage, type UsageLedger, type UsageRates, type UsageReservation } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function drain(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
function caption(sequence = 1, extra: Partial<Caption> = {}): Caption {
  return { type: 'caption', sequence, segmentId: 's1', speakerId: 'A', speakerName: 'Speaker A',
    originalText: '요한복음 3:16입니다.', translations: { ko: '요한복음 3:16입니다.', ru: 'Иоанна 3:16.', kk: 'Жохан 3:16.', en: 'John 3:16.' },
    createdAt: Date.now(), ...extra };
}
class FakeUsage implements Pick<UsageLedger, 'reserve'> {
  fail = false;
  reservations: { maximum: Usage; rates?: Partial<UsageRates>; actual?: Usage }[] = [];
  reserve(maximum: Usage, rates?: Partial<UsageRates>): UsageReservation {
    if (this.fail) throw new UsageLimitError();
    const entry: typeof this.reservations[number] = { maximum, ...(rates ? { rates } : {}) };
    this.reservations.push(entry);
    return { settle: (actual) => { entry.actual = actual; } };
  }
}
function harness(t: TestContext, options: { delayedAudio?: boolean; failAudio?: boolean; stopOnInitial?: boolean; defaultStability?: boolean } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  const captions: Caption[] = [];
  const calls: ReviewRequest[] = [];
  const gates: ReturnType<typeof deferred<ReviewResult>>[] = [];
  const audioCalls: AudioRetranscriptionRequest[] = [];
  const audioGates: ReturnType<typeof deferred<AudioRetranscriptionResult>>[] = [];
  const diagnostics: string[] = [];
  const fatal: unknown[] = [];
  const usage = new FakeUsage();
  const reviewer: Reviewer = {
    estimateUsage: () => ({ inputTokens: 5_000, outputTokens: 2_048 }),
    review: async (input) => { calls.push(input); const gate = deferred<ReviewResult>(); gates.push(gate); return gate.promise; },
  };
  const retranscriber: AudioRetranscriber = { transcribe: async (input) => {
    audioCalls.push(input);
    if (options.failAudio) throw new Error('transport unavailable');
    if (options.delayedAudio) { const gate = deferred<AudioRetranscriptionResult>(); audioGates.push(gate); return gate.promise; }
    return { text: '요한복음 3:16입니다.' };
  } };
  const session = new AccuracySession({ reviewer, retranscriber, glossary: [], usage,
    getConversation: () => ({ recent: [], summary: '' }), sttHints: { prompt: 'Bible discussion', keywords: [], languages: ['ko', 'ru', 'kk', 'en'] },
    ...(options.defaultStability ? {} : { stabilityMs: 100 }), onCaption: (value) => { captions.push(value); if (options.stopOnInitial && value.status === 'initial') session.stop(); },
    onDiagnostic: (event) => diagnostics.push(event), onFatal: (error) => fatal.push(error) });
  t.after(() => session.stop());
  const audio = (id = 's1', speakerId = 'A', size = 48_000) => { session.audio(id, speakerId, Buffer.alloc(size, 7)); };
  const transcript = (id = 's1', speakerId = 'A', text = '요한복음 3:16입니다.', conflict = false) => session.transcript(id, speakerId, text, conflict);
  const tick = async (ms = 100) => { t.mock.timers.tick(ms); await drain(); };
  const resolve = async (index = 0, changed = false, uncertain = false) => {
    const original = calls[index]!.translations;
    gates[index]!.resolve({ translations: changed ? { ...original, en: 'Corrected translation.' } : original,
      changed, uncertain, inputTokens: 500, outputTokens: 100 });
    await drain();
  };
  return { session, captions, calls, gates, audioCalls, audioGates, usage, diagnostics, fatal, audio, transcript, tick, resolve };
}

test('initial caption is synchronous and one selective final revision uses the same identity', async (t) => {
  const h = harness(t);
  h.audio(); h.transcript(); h.session.publish(caption());
  assert.equal(h.captions.length, 1);
  assert.equal(h.captions[0]?.status, 'initial');
  assert.equal(h.audioCalls.length, 0);
  assert.equal(h.calls.length, 0);
  await h.tick();
  assert.equal(h.audioCalls.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.independentTranscript, '요한복음 3:16입니다.');
  assert.deepEqual(h.usage.reservations[0], { maximum: { audioMs: 1000 }, rates: { sttPerMinuteUsd: 0.0045 }, actual: { audioMs: 1000 } });
  await h.resolve(0, true);
  assert.equal(h.captions.length, 2);
  assert.equal(h.captions[1]?.sequence, h.captions[0]?.sequence);
  assert.equal(h.captions[1]?.revision, 1);
  assert.equal(h.captions[1]?.status, 'final');
  assert.equal(h.captions[1]?.translations.en, 'Corrected translation.');
  h.session.publish(caption()); h.session.publish(h.captions[1]!);
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.captions.length, 2);
});

test('default finalization adds no stabilization wait or unnecessary model calls', async (t) => {
  const h = harness(t, { defaultStability: true });
  const started = Date.now();
  h.session.publish(caption(1, { originalText: '오늘 함께 이야기합시다.' }));
  await h.tick(0);
  assert.equal(Date.now(), started);
  assert.deepEqual(h.captions.map(value => value.status), ['initial', 'final']);
  assert.equal(h.captions[1]?.accuracy?.state, 'not_needed');
  assert.equal(h.calls.length, 0); assert.equal(h.audioCalls.length, 0);
  assert.equal(h.session.isSettled(), true);
});

test('default finalization starts a necessary review immediately and waits for its result', async (t) => {
  const h = harness(t, { defaultStability: true });
  h.audio(); h.transcript(); h.session.publish(caption());
  await h.tick(0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.captions.length, 1);
  assert.equal(h.session.isSettled(), false);
  await h.resolve(0, true);
  assert.equal(h.captions[1]?.status, 'final');
  assert.equal(h.captions[1]?.translations.en, 'Corrected translation.');
  assert.equal(h.session.isSettled(), true);
});

test('ordinary captions finalize without either model call', async (t) => {
  const h = harness(t);
  h.session.publish(caption(1, { originalText: '오늘 함께 이야기합시다.' }));
  await h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.audioCalls.length, 0);
  assert.equal(h.captions[1]?.accuracy?.state, 'not_needed');
});

test('missing or cropped audio stays text-only; eviction cannot make later packets look complete', async (t) => {
  const h = harness(t);
  h.audio('s1', 'A', 13 * 1024 * 1024); // exceeds the whole retained-audio budget
  h.audio(); // only a tail remains: must not revive an intact source
  h.transcript(); h.transcript('s2', 'A', '추가 발언입니다.');
  h.session.publish(caption(1, { sourceSegmentIds: ['s1', 's2'] }));
  await h.tick();
  assert.equal(h.audioCalls.length, 0);
  assert.equal(h.calls[0]?.independentTranscript, undefined);
  assert.equal(h.calls[0]?.sourceTranscripts.length, 2);
  await h.resolve();
});

test('expired audio cannot be reconstructed from a late tail, and absent audio still preserves source text', async (t) => {
  const h = harness(t);
  h.audio(); await h.tick(91_000); h.audio(); h.transcript();
  h.session.publish(caption()); await h.tick();
  assert.equal(h.audioCalls.length, 0);
  assert.equal(h.calls[0]?.sourceTranscripts[0]?.text, '요한복음 3:16입니다.');
  assert.equal(h.calls[0]?.independentTranscript, undefined);
  await h.resolve();
});

test('same-speaker late negation becomes review evidence, including before initial publication', async (t) => {
  const h = harness(t);
  h.transcript('s1', 'A', '하고 싶을 때만 하는 일입니다.');
  h.transcript('other', 'B', '아니라 다른 이야기입니다.');
  h.transcript('s2', 'A', '아니라 명령입니다.');
  h.session.publish(caption(1, { originalText: '하고 싶을 때만 하는 일입니다.' }));
  await h.tick();
  assert.ok(h.calls[0]?.reasons.includes('late_negation'));
  assert.deepEqual(h.calls[0]?.sourceTranscripts.map((source) => source.id), ['s1', 's2']);
  assert.equal(h.calls[0]?.independentTranscript, undefined);
  await h.resolve();
});

test('ordinary contrastive topic transitions do not mark earlier captions as negated', async (t) => {
  const h = harness(t);
  h.transcript('s1', 'A', '오늘의 이야기는 끝났습니다.');
  h.transcript('s2', 'A', 'But now we will discuss another subject.');
  h.transcript('s3', 'A', 'А теперь прочитаем дальше.');
  h.session.publish(caption(1, { originalText: '오늘의 이야기는 끝났습니다.' }));
  await h.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.captions[1]?.accuracy?.state, 'not_needed');
});

test('a new negation while a review is in flight cannot publish a stale confident correction', async (t) => {
  const h = harness(t);
  h.transcript(); h.session.publish(caption()); await h.tick();
  h.transcript('s2', 'A', '아니라 다음 구절입니다.');
  await h.resolve(0, true);
  assert.equal(h.captions[1]?.accuracy?.state, 'uncertain');
  assert.equal(h.captions[1]?.translations.en, h.captions[0]?.translations.en);
  assert.ok(h.captions[1]?.accuracy?.reasons.includes('late_context_after_review'));
  assert.equal(h.calls.length, 1);
});

test('stop immediately wipes retained and in-flight PCM and rejects late final captions', async (t) => {
  const h = harness(t, { delayedAudio: true });
  h.audio(); h.transcript(); h.session.publish(caption()); await h.tick();
  const inFlight = h.audioCalls[0]!.pcm;
  assert.ok(inFlight.some((byte) => byte !== 0));
  h.session.stop();
  assert.ok(inFlight.every((byte) => byte === 0));
  assert.equal(h.audioCalls[0]!.signal.aborted, true);
  h.audioGates[0]!.resolve({ text: 'late transcript' }); await drain();
  assert.equal(h.calls.length, 0);
  assert.equal(h.captions.length, 1);
});

test('audio verification failure continues as text-only and uncertain results never alter captions', async (t) => {
  const h = harness(t, { failAudio: true });
  h.audio(); h.transcript(); h.session.publish(caption()); await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.independentTranscript, undefined);
  assert.equal(h.usage.reservations[0]?.actual, undefined, 'unknown audio billing stays reserved');
  await h.resolve(0, true, true);
  assert.equal(h.captions[1]?.accuracy?.state, 'uncertain');
  assert.equal(h.captions[1]?.translations.en, h.captions[0]?.translations.en);
});

test('review queue is bounded and budget failures stop future paid work', async (t) => {
  const h = harness(t);
  for (let sequence = 1; sequence <= 30; sequence++) h.session.publish(caption(sequence));
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.ok(h.captions.filter((value) => value.accuracy?.state === 'skipped').length >= 23);
  h.usage.fail = true;
  await h.resolve();
  assert.equal(h.fatal.length, 1);
  assert.ok(h.fatal[0] instanceof UsageLimitError);
  assert.equal(h.calls.length, 1);
});

test('cached independent transcription is reused only while the original transcript revision matches', async (t) => {
  const h = harness(t);
  h.audio(); h.transcript(); h.session.publish(caption()); await h.tick(); await h.resolve();
  h.session.publish(caption(2)); await h.tick(); await h.resolve(1);
  assert.equal(h.audioCalls.length, 1);
  h.transcript('s1', 'A', '요한복음 3:17입니다.', true);
  h.session.publish(caption(3, { originalText: '요한복음 3:17입니다.' })); await h.tick();
  assert.equal(h.audioCalls.length, 2);
  await h.resolve(2);
});

test('cached audio for one turn cannot masquerade as complete evidence for a caption with missing turns', async (t) => {
  const h = harness(t);
  h.audio(); h.transcript(); h.session.publish(caption()); await h.tick(); await h.resolve();
  h.session.publish(caption(2, { sourceSegmentIds: ['s1', 'missing'] })); await h.tick();
  assert.equal(h.audioCalls.length, 1);
  assert.equal(h.calls[1]?.independentTranscript, undefined);
  await h.resolve(1);
});

test('stopping inside the initial-caption callback cannot leave pending timers or paid requests', async (t) => {
  const h = harness(t, { stopOnInitial: true });
  h.audio(); h.transcript(); h.session.publish(caption()); await h.tick(1000);
  assert.equal(h.calls.length, 0); assert.equal(h.audioCalls.length, 0);
  assert.equal(h.captions.length, 1);
});
