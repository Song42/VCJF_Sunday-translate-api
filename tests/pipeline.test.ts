import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import { SttError, type Transcriber } from '../src/stt.js';
import { TranslationError, type TranslationRequest, type TranslationResult, type Translator } from '../src/translate.js';
import type { Caption } from '../src/types.js';
import { UsageLimitError, UsageStorageError, type Usage, type UsageLedger, type UsageReservation } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeTranscriber implements Transcriber {
  readonly commits: ReturnType<typeof deferred<string>>[] = [];
  readonly sent: { bytes: number; first: number; borrowed: Buffer }[] = [];
  closed = false;
  connectCalls = 0;
  connectGate: ReturnType<typeof deferred<void>> | undefined;
  settlePendingOnClose = true;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectGate) await this.connectGate.promise;
  }
  append(pcm: Buffer): void {
    assert.equal(this.closed, false, 'no audio may be sent to a closed STT session');
    this.sent.push({ bytes: pcm.length, first: pcm[0]!, borrowed: pcm });
  }
  commit(): Promise<string> {
    assert.equal(this.closed, false, 'no commits may be sent after session closure');
    const turn = deferred<string>();
    this.commits.push(turn);
    return turn.promise;
  }
  close(): void {
    this.closed = true;
    if (this.settlePendingOnClose) for (const turn of this.commits) turn.reject(new SttError('stt_closed'));
  }
}

function result(text: string): TranslationResult {
  return {
    translations: { ko: `ko:${text}`, ru: `ru:${text}`, kk: `kk:${text}`, en: `en:${text}` },
    inputTokens: 100, outputTokens: 50,
  };
}

class FakeTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];
  readonly pending: ReturnType<typeof deferred<TranslationResult>>[] = [];
  defer = false;
  failNext = false;
  estimateUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: 2_000, outputTokens: 2_048 };
  }
  async translate(input: TranslationRequest): Promise<TranslationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    if (this.failNext) {
      this.failNext = false;
      throw new TranslationError('rate_limit');
    }
    if (this.defer) {
      const task = deferred<TranslationResult>();
      this.pending.push(task);
      return task.promise;
    }
    return result(input.originalText);
  }
}

class FakeUsage implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly reservations: { maximum: Usage; actual?: Usage }[] = [];
  failReserve: 'none' | 'audio' | 'translation' = 'none';
  failSettleAudio = false;
  reserve(maximum: Usage): UsageReservation {
    if ((maximum.audioMs && this.failReserve === 'audio') ||
      (maximum.inputTokens && this.failReserve === 'translation')) throw new UsageLimitError();
    const entry: { maximum: Usage; actual?: Usage } = { maximum: { ...maximum } };
    this.reservations.push(entry);
    return { settle: (actual) => {
      if (this.failSettleAudio && maximum.audioMs) throw new UsageStorageError('write_failed');
      entry.actual = { ...actual };
    } };
  }
  snapshot() {
    return { month: '2026-11', estimatedUsd: 0.01, audioMs: 100, inputTokens: 100, outputTokens: 50, limitUsd: 10 };
  }
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(t: TestContext, options: { connectPending?: boolean; segmentMs?: number } = {}) {
  let now = Date.UTC(2026, 10, 4, 20);
  const stts: FakeTranscriber[] = [];
  const translator = new FakeTranslator();
  const usage = new FakeUsage();
  const captions: Caption[] = [];
  const diagnostics: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const fatal: string[] = [];
  const pipeline = new LiveTranslationPipeline({
    segmentMs: options.segmentMs ?? 10_000,
    sentenceCaptions: false,
    createTranscriber: () => {
      const stt = new FakeTranscriber();
      if (options.connectPending) stt.connectGate = deferred<void>();
      stts.push(stt);
      return stt;
    },
    translator, usage,
    speakerName: (id) => `Speaker ${id}`,
    onCaption: (caption) => captions.push(caption),
    onDiagnostic: (event, fields) => diagnostics.push(fields ? { event, fields } : { event }),
    onFatal: (code) => fatal.push(code),
    now: () => now,
  });
  t.after(() => pipeline.stop());
  return {
    pipeline, stts, translator, usage, captions, diagnostics, fatal,
    advance: (ms: number) => { now += ms; },
  };
}

function pcm(milliseconds: number, sample = 17): Buffer {
  return Buffer.alloc(milliseconds * 48, sample);
}

async function utterance(h: ReturnType<typeof harness>, speaker: string, sttIndex: number, text: string) {
  h.pipeline.push(speaker, pcm(100));
  h.pipeline.end(speaker, 'silence');
  await drain();
  const turn = h.stts[sttIndex]!.commits.at(-1)!;
  turn.resolve(text);
  await drain();
}

test('streams PCM before a silence boundary, commits once, clears borrowed buffers', async (t) => {
  const h = harness(t);
  const callerBuffer = pcm(100, 61);
  h.pipeline.push('A', callerBuffer);
  await drain();
  assert.equal(h.stts[0]?.sent.length, 1);
  assert.equal(h.stts[0]?.sent[0]?.bytes, 4_800);
  assert.equal(h.stts[0]?.sent[0]?.first, 61);
  assert.ok(h.stts[0]!.sent[0]!.borrowed.every((byte) => byte === 0));
  assert.ok(callerBuffer.every((byte) => byte === 61), 'caller owns input buffer');
  assert.equal(h.stts[0]?.commits.length, 0);
  h.pipeline.end('A', 'silence');
  h.pipeline.end('A', 'silence');
  await drain();
  assert.equal(h.stts[0]?.commits.length, 1);
  h.stts[0]!.commits[0]!.resolve('spoken text');
  await drain();
  assert.equal(h.captions.length, 1);
  assert.deepEqual(h.captions[0]?.translations, result('spoken text').translations);
  assert.equal(h.usage.reservations[0]?.actual?.audioMs, 100);
});

test('continuous speech splits at four seconds without blocking later audio on STT', async (t) => {
  const h = harness(t, { segmentMs: 4_000 });
  for (let i = 0; i < 45; i += 1) {
    h.pipeline.push('A', pcm(100));
    await drain();
  }
  assert.equal(h.stts.length, 1);
  assert.equal(h.stts[0]?.commits.length, 1);
  assert.equal(h.stts[0]?.sent.reduce((total, frame) => total + frame.bytes, 0), 4_500 * 48);
  h.pipeline.end('A', 'silence');
  await drain();
  assert.equal(h.stts[0]?.commits.length, 2);
  h.stts[0]!.commits[1]!.resolve('second segment');
  h.stts[0]!.commits[0]!.resolve('first segment');
  await drain();
  assert.deepEqual(h.pipeline.recentCaptions().map((caption) => caption.originalText), ['first segment', 'second segment']);
  assert.deepEqual(h.usage.reservations.filter((entry) => entry.maximum.audioMs).map((entry) => entry.actual?.audioMs), [4_000, 500]);
});

test('utterances shorter than 100 ms are discarded without sending paid audio', async (t) => {
  const h = harness(t);
  h.pipeline.push('A', pcm(80));
  h.pipeline.end('A', 'silence');
  await drain();
  assert.equal(h.stts[0]?.sent.length, 0);
  assert.equal(h.stts[0]?.commits.length, 0);
  assert.equal(h.usage.reservations[0]?.actual?.audioMs, 0);
  assert.equal(h.translator.calls.length, 0);
  assert.ok(h.diagnostics.some((entry) => entry.event === 'segment_too_short'));
});

test('at most three live speakers are admitted and a fourth can reuse an idle slot', async (t) => {
  const h = harness(t);
  for (const speaker of ['A', 'B', 'C', 'D']) h.pipeline.push(speaker, pcm(100));
  await drain();
  assert.equal(h.stts.length, 3);
  assert.equal(h.stts.filter((stt) => !stt.closed).length, 3);
  assert.ok(h.diagnostics.some((entry) => entry.event === 'stt_capacity' && entry.fields?.speakerId === 'D'));
  h.pipeline.end('A', 'silence');
  await drain();
  h.stts[0]!.commits[0]!.resolve('A finished');
  await drain();
  h.advance(1_001);
  h.pipeline.push('D', pcm(100));
  await drain();
  assert.equal(h.stts[0]?.closed, true);
  assert.equal(h.stts.length, 4);
  assert.equal(h.stts.filter((stt) => !stt.closed).length, 3);
  assert.equal(h.stts[3]?.sent.length, 1);
});

test('out-of-order transcripts retain speaker identity, sequence and one shared translation', async (t) => {
  const h = harness(t);
  for (const speaker of ['A', 'B', 'C']) {
    h.pipeline.push(speaker, pcm(100));
    h.pipeline.end(speaker, 'silence');
  }
  await drain();
  h.stts[2]!.commits[0]!.resolve('third speaker');
  h.stts[0]!.commits[0]!.resolve('first speaker');
  h.stts[1]!.commits[0]!.resolve('second speaker');
  await drain();
  const recent = h.pipeline.recentCaptions();
  assert.deepEqual(recent.map((caption) => [caption.sequence, caption.speakerId, caption.speakerName]), [
    [1, 'A', 'Speaker A'], [2, 'B', 'Speaker B'], [3, 'C', 'Speaker C'],
  ]);
  for (const caption of recent) assert.deepEqual(caption.translations, result(caption.originalText).translations);
  assert.equal(new Set(recent.map((caption) => caption.segmentId)).size, 3);
  for (let i = 0; i < 50; i += 1) h.pipeline.recentCaptions();
  assert.equal(h.translator.calls.length, 3);
  recent[0]!.translations.en = 'tampered';
  assert.notEqual(h.pipeline.recentCaptions()[0]?.translations.en, 'tampered');
});

test('an STT transport failure does not stop later utterances or another speaker', async (t) => {
  const h = harness(t);
  for (const speaker of ['A', 'B']) {
    h.pipeline.push(speaker, pcm(100));
    h.pipeline.end(speaker, 'silence');
  }
  await drain();
  h.stts[0]!.commits[0]!.reject(new SttError('stt_transport'));
  h.stts[1]!.commits[0]!.resolve('B still works');
  await drain();
  assert.equal(h.stts[0]?.closed, true);
  assert.equal(h.captions[0]?.speakerId, 'B');
  h.advance(3_001);
  await utterance(h, 'A', 2, 'A recovered');
  assert.equal(h.captions.at(-1)?.originalText, 'A recovered');
  assert.equal(h.fatal.length, 0);
});

test('an identified transcription failure affects only that segment in a shared session', async (t) => {
  const h = harness(t);
  for (let i = 0; i < 2; i += 1) {
    h.pipeline.push('A', pcm(100));
    h.pipeline.end('A', 'silence');
    await drain();
  }
  assert.equal(h.stts[0]?.commits.length, 2);
  h.stts[0]!.commits[0]!.reject(new SttError('stt_transcription_failed'));
  h.stts[0]!.commits[1]!.resolve('second succeeds');
  await drain();
  assert.equal(h.stts[0]?.closed, false);
  assert.equal(h.captions[0]?.originalText, 'second succeeds');
  await utterance(h, 'A', 0, 'third also succeeds');
  assert.equal(h.stts.length, 1);
  assert.deepEqual(h.pipeline.recentCaptions().map((caption) => caption.sequence), [2, 3]);
  assert.equal(h.translator.calls.length, 2);
});

test('wall-clock segment limit commits even with sparse packets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { segmentMs: 4_000 });
  h.pipeline.push('A', pcm(100));
  await drain();
  assert.equal(h.stts[0]?.commits.length, 0);
  t.mock.timers.tick(3_999);
  await drain();
  assert.equal(h.stts[0]?.commits.length, 0);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(h.stts[0]?.commits.length, 1);
  h.stts[0]!.commits[0]!.resolve('sparse speech');
  await drain();
  assert.equal(h.captions[0]?.originalText, 'sparse speech');
});

test('preconnection buffering is bounded and discarded after overload', async (t) => {
  const h = harness(t, { connectPending: true });
  h.pipeline.push('A', pcm(6_000));
  h.pipeline.push('A', pcm(6_000));
  assert.equal(h.stts[0]?.closed, true);
  h.stts[0]!.connectGate!.resolve();
  await drain();
  assert.equal(h.stts[0]?.sent.length, 0);
  assert.equal(h.stts[0]?.commits.length, 0);
  assert.ok(h.diagnostics.some((entry) => entry.fields?.code === 'audio_backpressure'));
  assert.ok(h.usage.reservations.every((entry) => entry.actual?.audioMs === 0));
});

test('translation errors are isolated and context contains only two earlier same-speaker utterances', async (t) => {
  const h = harness(t);
  h.translator.failNext = true;
  await utterance(h, 'A', 0, 'first');
  assert.equal(h.captions.length, 0);
  await utterance(h, 'B', 1, 'unrelated');
  await utterance(h, 'A', 0, 'second');
  await utterance(h, 'A', 0, 'third');
  await utterance(h, 'A', 0, 'fourth');
  assert.deepEqual(h.translator.calls.at(-1)?.context, ['second', 'third']);
  assert.equal(h.captions.at(-1)?.originalText, 'fourth');
  assert.equal(h.fatal.length, 0);
});

test('stop aborts pending translation, clears captions and ignores late provider results', async (t) => {
  const h = harness(t);
  await utterance(h, 'A', 0, 'already visible');
  assert.equal(h.pipeline.recentCaptions().length, 1);
  h.translator.defer = true;
  await utterance(h, 'A', 0, 'translation pending');
  h.pipeline.push('B', pcm(100));
  h.pipeline.end('B', 'silence');
  await drain();
  h.stts[1]!.settlePendingOnClose = false;
  const callsBeforeStop = h.translator.calls.length;
  h.pipeline.stop();
  h.pipeline.stop();
  assert.equal(h.translator.calls.at(-1)?.signal.aborted, true);
  assert.equal(h.pipeline.recentCaptions().length, 0);
  assert.ok(h.stts.every((stt) => stt.closed));
  h.translator.pending[0]!.resolve(result('late translation'));
  h.stts[1]!.commits[0]!.resolve('late transcription');
  h.pipeline.push('C', pcm(100));
  await drain();
  assert.equal(h.translator.calls.length, callsBeforeStop);
  assert.equal(h.captions.length, 1);
  assert.equal(h.pipeline.recentCaptions().length, 0);
  assert.equal(h.stts.length, 2);
});

test('stop discards buffered audio before a pending connection becomes ready', async (t) => {
  const h = harness(t, { connectPending: true });
  h.pipeline.push('A', pcm(500));
  h.pipeline.end('A', 'silence');
  h.pipeline.stop();
  h.stts[0]!.connectGate!.resolve();
  await drain();
  assert.equal(h.stts[0]?.sent.length, 0);
  assert.equal(h.stts[0]?.commits.length, 0);
  assert.equal(h.usage.reservations[0]?.actual?.audioMs, 0);
});

test('captions and translation context expire after ten minutes', async (t) => {
  const h = harness(t);
  await utterance(h, 'A', 0, 'old');
  h.advance(600_000);
  assert.equal(h.pipeline.recentCaptions().length, 0);
  await utterance(h, 'A', 0, 'new');
  assert.deepEqual(h.translator.calls.at(-1)?.context, []);
  assert.deepEqual(h.pipeline.recentCaptions().map((caption) => caption.originalText), ['new']);
});

test('exhausted budget stops audio or translation before the next paid request', async (t) => {
  const audio = harness(t);
  audio.usage.failReserve = 'audio';
  audio.pipeline.push('A', pcm(100));
  await drain();
  assert.equal(audio.stts[0]?.sent.length, 0);
  assert.equal(audio.stts[0]?.commits.length, 0);
  assert.deepEqual(audio.fatal, ['api_budget_limit']);
  audio.pipeline.push('B', pcm(100));
  assert.equal(audio.stts.length, 1);

  const translation = harness(t);
  translation.usage.failReserve = 'translation';
  await utterance(translation, 'A', 0, 'no translation credit');
  assert.equal(translation.translator.calls.length, 0);
  assert.deepEqual(translation.fatal, ['api_budget_limit']);
});

test('usage storage failure during settlement cannot commit after stopping', async (t) => {
  const h = harness(t);
  h.pipeline.push('A', pcm(100));
  await drain();
  h.usage.failSettleAudio = true;
  h.pipeline.end('A', 'silence');
  await drain();
  assert.deepEqual(h.fatal, ['usage_storage_error']);
  assert.equal(h.stts[0]?.closed, true);
  assert.equal(h.stts[0]?.commits.length, 0);
  assert.equal(h.translator.calls.length, 0);
});

test('diagnostics contain numeric metadata and codes but no raw transcript or PCM', async (t) => {
  const h = harness(t);
  await utterance(h, 'A', 0, 'private transcript must never be logged');
  const encoded = JSON.stringify(h.diagnostics);
  assert.ok(!encoded.includes('private transcript'));
  assert.ok(!encoded.includes('ko:'));
  assert.ok(!encoded.includes('Buffer'));
  for (const entry of h.diagnostics) {
    assert.ok(Object.values(entry.fields ?? {}).every((value) => ['number', 'string', 'boolean'].includes(typeof value)));
  }
});
