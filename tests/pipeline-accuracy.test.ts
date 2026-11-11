import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import { ConversationMemory, type Summarizer } from '../src/conversation-memory.js';
import type { Interpreter, InterpretationRequest, InterpretationResult } from '../src/interpret.js';
import { SttError, type Transcriber, type TranscriptionPartial } from '../src/stt.js';
import type { Reviewer, ReviewRequest, ReviewResult } from '../src/accuracy-review.js';
import type { AudioRetranscriber, AudioRetranscriptionRequest, AudioRetranscriptionResult } from '../src/audio-retranscribe.js';
import type { Caption } from '../src/types.js';
import type { Translations } from '../src/translate.js';
import type { Usage, UsageRates, UsageLedger } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}
async function drain() { await new Promise<void>((done) => setImmediate(done)); }
const translated = (text: string): Translations => ({ ko: text, ru: text, kk: text, en: text });
class LiveStt implements Transcriber {
  readonly commits: ReturnType<typeof deferred<string>>[] = [];
  handler?: (partial: TranscriptionPartial) => void;
  onAppend?: () => void;
  appendedBytes = 0;
  closed = false;
  async connect() {}
  append(pcm: Buffer) { this.appendedBytes += pcm.length; this.onAppend?.(); }
  setPartialHandler(handler: (partial: TranscriptionPartial) => void) { this.handler = handler; }
  partial(text: string, commitIndex?: number) {
    this.handler?.({ itemId: `item-${commitIndex ?? 'live'}`, text, ...(commitIndex === undefined ? {} : { commitIndex }) });
  }
  commit() { const pending = deferred<string>(); this.commits.push(pending); return pending.promise; }
  close() { this.closed = true; for (const commit of this.commits) commit.reject(new SttError('stt_closed')); }
}
class Interpret implements Interpreter {
  readonly calls: InterpretationRequest[] = [];
  readonly gates: ReturnType<typeof deferred<InterpretationResult>>[] = [];
  estimateUsage() { return { inputTokens: 5000, outputTokens: 2048 }; }
  interpret(input: InterpretationRequest) { this.calls.push(input); const gate = deferred<InterpretationResult>(); this.gates.push(gate); return gate.promise; }
  answer(index: number) {
    this.gates[index]!.resolve({ completed: [{ originalText: this.calls[index]!.text, translations: translated(this.calls[index]!.text) }],
      pending: '', inputTokens: 200, outputTokens: 100 });
  }
}
class Review implements Reviewer {
  readonly calls: ReviewRequest[] = [];
  readonly gates: ReturnType<typeof deferred<ReviewResult>>[] = [];
  estimateUsage() { return { inputTokens: 5000, outputTokens: 2048 }; }
  review(input: ReviewRequest) { this.calls.push(input); const gate = deferred<ReviewResult>(); this.gates.push(gate); return gate.promise; }
}
class Retranscribe implements AudioRetranscriber {
  readonly calls: AudioRetranscriptionRequest[] = [];
  readonly gates: ReturnType<typeof deferred<AudioRetranscriptionResult>>[] = [];
  transcribe(input: AudioRetranscriptionRequest) { this.calls.push(input); const gate = deferred<AudioRetranscriptionResult>(); this.gates.push(gate); return gate.promise; }
}
class UsageCounter implements Pick<UsageLedger, 'reserve' | 'snapshot'> {
  readonly entries: { maximum: Usage; actual?: Usage; rates?: Partial<UsageRates> }[] = [];
  reserve(maximum: Usage, rates?: Partial<UsageRates>) {
    const entry: typeof this.entries[number] = { maximum, ...(rates ? { rates } : {}) };
    this.entries.push(entry);
    return { settle: (actual: Usage) => { entry.actual = actual; } };
  }
  snapshot() { return { month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }; }
}
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const stts: LiveStt[] = [];
  const interpreter = new Interpret();
  const reviewer = new Review();
  const retranscriber = new Retranscribe();
  const usage = new UsageCounter();
  const events: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const captions: Caption[] = [];
  const onDiagnostic = (event: string, fields?: Record<string, string | number | boolean>) => events.push({ event, ...(fields ? { fields } : {}) });
  const summarizer: Summarizer = { estimateUsage: () => ({ inputTokens: 1000, outputTokens: 1000 }),
    summarize: async () => ({ summary: 'Earlier conversation', inputTokens: 100, outputTokens: 50 }) };
  const memory = new ConversationMemory({ summarizer, usage, onDiagnostic });
  const pipeline = new LiveTranslationPipeline({ segmentMs: 4000, interpreter, memory,
    translator: { estimateUsage: () => ({ inputTokens: 1000, outputTokens: 1000 }), translate: async () => { throw new Error('Legacy translator must not run'); } },
    createTranscriber: () => { const stt = new LiveStt(); stts.push(stt); return stt; }, usage,
    accuracy: { reviewer, retranscriber, glossary: [], usage, sttHints: { prompt: 'Christian discussion', keywords: [], languages: ['ko', 'ru', 'kk', 'en'] },
      onDiagnostic, stabilityMs: 1500 },
    speakerName: (id) => `Speaker ${id}`, onCaption: (caption) => captions.push(caption), onDiagnostic });
  t.after(() => pipeline.stop());
  const push = async (speaker = 'A', ms = 600) => { pipeline.push(speaker, Buffer.alloc(ms * 48, 17)); await drain(); };
  const commit = async (text: string, speaker = 'A', index = 0) => {
    await push(speaker); pipeline.end(speaker, 'silence'); await drain();
    stts[index]!.commits.at(-1)!.resolve(text); await drain();
  };
  return { pipeline, memory, stts, interpreter, reviewer, retranscriber, usage, captions, events, push, commit };
}

test('live partial punctuation commits at 500ms while speech continues, but raw deltas never become captions', async (t) => {
  const h = harness(t);
  await h.push('A', 400);
  h.stts[0]!.partial('오늘 함께 모였습니다.');
  await drain();
  assert.equal(h.stts[0]!.commits.length, 0);
  await h.push('A', 100);
  h.stts[0]!.partial('오늘 함께 모였습니다.');
  await drain();
  assert.equal(h.stts[0]!.commits.length, 1, 'commit occurs without silence or the four-second audio limit');
  assert.equal(h.interpreter.calls.length, 0, 'raw partial text is not treated as finalized source');
  assert.equal(h.captions.length, 0);
  h.stts[0]!.commits[0]!.resolve('오늘 함께 모였습니다.');
  await drain();
  assert.equal(h.interpreter.calls.length, 1);
  assert.equal(h.interpreter.calls[0]!.text, '오늘 함께 모였습니다.');
  assert.ok(h.events.some((event) => event.event === 'stt_early_commit'));
  assert.equal(h.usage.entries[0]!.actual?.audioMs, 500);
});

test('synchronous partial callbacks during append cannot deadlock or duplicate streaming commits', async (t) => {
  const h = harness(t);
  h.pipeline.push('A', Buffer.alloc(600 * 48, 17));
  h.stts[0]!.onAppend = () => h.stts[0]!.partial('Streaming sentence complete.');
  await drain();
  assert.equal(h.stts[0]!.commits.length, 1);
  assert.equal(h.stts[0]!.appendedBytes, 600 * 48);
  assert.equal(h.interpreter.calls.length, 0);
});

test('initial caption is immediate; stable final keeps its identity and only final speech enters shared memory', async (t) => {
  const h = harness(t);
  await h.commit('오늘 함께 이야기합니다.');
  h.interpreter.answer(0); await drain();
  assert.equal(h.captions[0]?.status, 'initial');
  assert.equal(h.memory.snapshot().recent.length, 0);
  assert.equal(h.reviewer.calls.length, 0);
  t.mock.timers.tick(1500); await drain();
  assert.deepEqual(h.captions.map((caption) => caption.status), ['initial', 'final']);
  assert.equal(h.captions[0]!.sequence, h.captions[1]!.sequence);
  assert.equal(h.captions[0]!.segmentId, h.captions[1]!.segmentId);
  assert.equal(h.pipeline.recentCaptions().length, 1);
  assert.equal(h.pipeline.recentCaptions()[0]!.status, 'final');
  assert.equal(h.reviewer.calls.length, 0, 'ordinary captions do not need an accuracy model request');
  await h.commit('That is helpful.', 'B', 1);
  assert.equal(h.interpreter.calls[1]!.conversation?.recent[0]?.speakerId, 'A');
  assert.equal(h.interpreter.calls[1]!.conversation?.recent[0]?.text, '오늘 함께 이야기합니다.');
});

test('committed partial mapping attributes revision conflicts to the correct turn and reviews without blocking another caption', async (t) => {
  const h = harness(t);
  await h.push(); h.pipeline.end('A', 'silence'); await drain();
  await h.push(); h.pipeline.end('A', 'silence'); await drain();
  h.stts[0]!.partial('Wrong first wording.', 1);
  h.stts[0]!.partial('Second stable sentence.', 2);
  h.stts[0]!.commits[1]!.resolve('Second stable sentence.'); await drain();
  assert.equal(h.interpreter.calls.length, 0, 'final turn ordering is preserved');
  h.stts[0]!.commits[0]!.resolve('First corrected sentence.'); await drain();
  h.interpreter.answer(0); await drain();
  h.interpreter.answer(1); await drain();
  assert.equal(h.captions.length, 2);
  assert.equal(h.events.filter((event) => event.event === 'transcript_revision_conflict').length, 1);
  t.mock.timers.tick(1500); await drain();
  assert.equal(h.retranscriber.calls.length, 1);
  assert.equal(h.reviewer.calls.length, 0, 'independent audio evidence is still pending');
  assert.equal(h.pipeline.recentCaptions()[0]!.status, 'initial');
  assert.equal(h.pipeline.recentCaptions()[1]!.status, 'final');
  h.retranscriber.gates[0]!.resolve({ text: 'First corrected sentence.' }); await drain();
  assert.equal(h.reviewer.calls.length, 1);
  assert.deepEqual(h.reviewer.calls[0]!.reasons, ['transcript_conflict']);
  assert.equal(h.reviewer.calls[0]!.independentTranscript, 'First corrected sentence.');
  h.reviewer.gates[0]!.resolve({ translations: translated('First corrected sentence.'), changed: false, uncertain: false, inputTokens: 100, outputTokens: 100 });
  await drain();
  assert.deepEqual(h.memory.snapshot().recent.map((entry) => entry.sequence), [1, 2], 'slow older final must retain source chronology');
  assert.equal(h.pipeline.recentCaptions()[0]!.accuracy?.state, 'verified');
});

test('stop aborts independent review, clears memory and prevents any late final caption', async (t) => {
  const h = harness(t);
  await h.push(); h.pipeline.end('A', 'silence'); await drain();
  h.stts[0]!.partial('Wrong words.', 1);
  h.stts[0]!.commits[0]!.resolve('Corrected source words.'); await drain();
  h.interpreter.answer(0); await drain();
  t.mock.timers.tick(1500); await drain();
  assert.equal(h.retranscriber.calls.length, 1);
  h.pipeline.stop();
  assert.equal(h.retranscriber.calls[0]!.signal.aborted, true);
  h.retranscriber.gates[0]!.resolve({ text: 'late evidence' }); await drain();
  assert.equal(h.captions.length, 1);
  assert.equal(h.captions[0]!.status, 'initial');
  assert.equal(h.reviewer.calls.length, 0);
  assert.deepEqual(h.memory.snapshot(), { recent: [], summary: '' });
  assert.deepEqual(h.pipeline.recentCaptions(), []);
});
