import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationMemory, OpenAISummarizer, SummaryError, type ConversationSegment,
  type Summarizer, type SummaryInput, type SummaryResult } from '../src/conversation-memory.js';
import { UsageLimitError, UsageStorageError, type Usage, type UsageLedger } from '../src/usage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function drain(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
function segment(i: number): ConversationSegment {
  return { id: `source-${i}`, speakerId: i % 2 ? 'A' : 'B', speakerName: i % 2 ? '예시이름' : '민수', text: `발언 ${i}` };
}
function result(summary = 'They discussed grace; the speaker did not claim certainty.'): SummaryResult {
  return { summary, inputTokens: 400, outputTokens: 100 };
}
class FakeSummarizer implements Summarizer {
  readonly calls: (SummaryInput & { signal: AbortSignal })[] = [];
  readonly gates: ReturnType<typeof deferred<SummaryResult>>[] = [];
  estimateUsage() { return { inputTokens: 5000, outputTokens: 2048 }; }
  summarize(input: SummaryInput & { signal: AbortSignal }): Promise<SummaryResult> {
    this.calls.push(input);
    const gate = deferred<SummaryResult>();
    this.gates.push(gate);
    return gate.promise;
  }
}
class FakeUsage implements Pick<UsageLedger, 'reserve'> {
  readonly records: { maximum: Usage; actual?: Usage }[] = [];
  failReserve = false;
  failSettle = false;
  reserve(maximum: Usage) {
    if (this.failReserve) throw new UsageLimitError();
    const entry = { maximum } as typeof this.records[number];
    this.records.push(entry);
    return { settle: (actual: Usage) => {
      if (this.failSettle) throw new UsageStorageError('write_failed');
      entry.actual = actual;
    } };
  }
}
function fixture(options: { recentLimit?: number; summaryBatchSize?: number; recentCharLimit?: number } = {}) {
  const summarizer = new FakeSummarizer();
  const usage = new FakeUsage();
  const errors: unknown[] = [];
  const events: string[] = [];
  const clock = { now: 1000 };
  const memory = new ConversationMemory({ ...options, summarizer, usage, now: () => clock.now,
    onError: (error) => errors.push(error), onDiagnostic: (event) => events.push(event) });
  return { memory, summarizer, usage, errors, events, clock };
}

test('shared recent source context spans speakers, retains a bounded window, and never exposes mutable state', () => {
  const { memory, summarizer } = fixture();
  for (let i = 1; i <= 17; i++) memory.finalize(segment(i));
  const snapshot = memory.snapshot();
  assert.equal(snapshot.recent.length, 12);
  assert.deepEqual(snapshot.recent.map((item) => item.id), Array.from({ length: 12 }, (_, i) => `source-${i + 6}`));
  assert.deepEqual(new Set(snapshot.recent.map((item) => item.speakerId)), new Set(['A', 'B']));
  snapshot.recent[0]!.text = 'external mutation';
  assert.equal(memory.snapshot().recent[0]?.text, '발언 6');
  assert.equal(snapshot.summary, '');
  assert.equal(summarizer.calls.length, 0, 'partial older history does not trigger a model call per caption');
  memory.stop();
});

test('summary batches older finalized source asynchronously while captions and recent memory keep progressing', async () => {
  const { memory, summarizer, usage } = fixture();
  for (let i = 1; i <= 18; i++) memory.finalize(segment(i));
  assert.equal(summarizer.calls.length, 1);
  assert.deepEqual(summarizer.calls[0]!.segments.map((item) => item.id), Array.from({ length: 6 }, (_, i) => `source-${i + 1}`));
  assert.equal(summarizer.calls[0]?.previousSummary, '');
  assert.equal(usage.records.length, 1, 'reserve before the first summary request');
  for (let i = 19; i <= 24; i++) memory.finalize(segment(i));
  assert.equal(memory.snapshot().recent.at(-1)?.id, 'source-24');
  assert.equal(summarizer.calls.length, 1, 'only one summary request in flight');
  summarizer.gates[0]!.resolve(result());
  await drain();
  assert.equal(memory.snapshot().summary, result().summary);
  assert.deepEqual(usage.records[0]!.actual, { inputTokens: 400, outputTokens: 100 });
  assert.equal(summarizer.calls.length, 2);
  assert.equal(summarizer.calls[1]?.previousSummary, result().summary);
  assert.deepEqual(summarizer.calls[1]?.segments.map((item) => item.id), Array.from({ length: 6 }, (_, i) => `source-${i + 7}`));
  memory.stop();
  summarizer.gates[1]!.resolve(result('late'));
  await drain();
});

test('correcting an in-flight source invalidates the old response and resummarizes the corrected evidence', async () => {
  const { memory, summarizer, usage } = fixture({ recentLimit: 2, summaryBatchSize: 2 });
  for (let i = 1; i <= 4; i++) memory.finalize(segment(i));
  assert.equal(memory.replace('source-1', '그것은 명령이 아닙니다.'), true);
  assert.equal(summarizer.calls[0]?.signal.aborted, true);
  summarizer.gates[0]!.resolve(result('wrong stale summary'));
  await drain();
  assert.equal(memory.snapshot().summary, '');
  assert.equal(summarizer.calls.length, 2);
  assert.equal(summarizer.calls[1]?.segments[0]?.text, '그것은 명령이 아닙니다.');
  assert.deepEqual(usage.records[0]?.actual, { inputTokens: 400, outputTokens: 100 }, 'known stale completion still settles its charged usage');
  summarizer.gates[1]!.resolve(result('The speaker explicitly said it is not a command.'));
  await drain();
  assert.match(memory.snapshot().summary, /not a command/);
  memory.stop();
});

test('correcting summarized older source discards uncertain summary while preserving current shared context', async () => {
  const { memory, summarizer, events } = fixture({ recentLimit: 2, summaryBatchSize: 2 });
  for (let i = 1; i <= 4; i++) memory.finalize(segment(i));
  summarizer.gates[0]!.resolve(result());
  await drain();
  assert.equal(memory.replace('source-1', 'corrected old source'), false);
  assert.equal(memory.snapshot().summary, '');
  assert.deepEqual(memory.snapshot().recent.map((item) => item.id), ['source-3', 'source-4']);
  assert.ok(events.includes('conversation_summary_invalidated'));
  memory.finalize({ ...segment(4), text: 'corrected current source' });
  assert.equal(memory.snapshot().recent.length, 2, 'duplicate finalized ID replaces instead of repeating history');
  assert.equal(memory.snapshot().recent.at(-1)?.text, 'corrected current source');
  memory.stop();
});

test('slow review completion keeps recent shared source in original caption order', () => {
  const { memory } = fixture({ recentLimit: 3 });
  memory.finalize({ ...segment(2), sequence: 2 });
  memory.finalize({ ...segment(3), sequence: 3 });
  memory.finalize({ ...segment(1), sequence: 1 });
  assert.deepEqual(memory.snapshot().recent.map((entry) => entry.sequence), [1, 2, 3]);
  memory.finalize({ ...segment(4), sequence: 4 });
  assert.deepEqual(memory.snapshot().recent.map((entry) => entry.sequence), [2, 3, 4]);
  memory.stop();
});

test('late older finalized source invalidates in-flight summary and is not presented as newest speech', async () => {
  const { memory, summarizer } = fixture({ recentLimit: 2, summaryBatchSize: 2 });
  for (let i = 2; i <= 5; i++) memory.finalize({ ...segment(i), sequence: i });
  assert.deepEqual(summarizer.calls[0]?.segments.map((entry) => entry.sequence), [2, 3]);
  memory.finalize({ ...segment(1), sequence: 1 });
  assert.equal(summarizer.calls[0]?.signal.aborted, true);
  assert.deepEqual(memory.snapshot().recent.map((entry) => entry.sequence), [4, 5]);
  summarizer.gates[0]!.resolve(result('out-of-order stale memory'));
  await drain();
  assert.equal(memory.snapshot().summary, '');
  assert.deepEqual(summarizer.calls[1]?.segments.map((entry) => entry.sequence), [1, 2, 3]);
  memory.stop();
  summarizer.gates[1]!.resolve(result('late'));
  await drain();
});

test('older final source after completed summary discards chronology-dependent summary conservatively', async () => {
  const { memory, summarizer, events } = fixture({ recentLimit: 2, summaryBatchSize: 2 });
  for (let i = 2; i <= 5; i++) memory.finalize({ ...segment(i), sequence: i });
  summarizer.gates[0]!.resolve(result('summary of source 2 and 3'));
  await drain();
  memory.finalize({ ...segment(1), sequence: 1 });
  assert.equal(memory.snapshot().summary, '');
  assert.deepEqual(memory.snapshot().recent.map((entry) => entry.sequence), [4, 5]);
  assert.ok(events.includes('conversation_summary_invalidated'));
  memory.stop();
});

test('summary failure preserves recent context, backs off paid retries, and can recover from later speech', async () => {
  const { memory, summarizer, usage, errors, clock } = fixture({ recentLimit: 2, summaryBatchSize: 2 });
  for (let i = 1; i <= 4; i++) memory.finalize(segment(i));
  summarizer.gates[0]!.reject(new SummaryError('summary_network'));
  await drain();
  assert.equal(errors.length, 1);
  assert.equal(usage.records[0]?.actual, undefined, 'failed call keeps conservative reservation');
  for (let i = 5; i <= 10; i++) memory.finalize(segment(i));
  assert.equal(summarizer.calls.length, 1);
  assert.equal(memory.snapshot().recent.at(-1)?.id, 'source-10');
  clock.now += 30_000;
  memory.finalize(segment(11));
  assert.equal(summarizer.calls.length, 2);
  summarizer.gates[1]!.resolve(result());
  await drain();
  assert.equal(memory.snapshot().summary, result().summary);
  memory.stop();
});

test('budget and ledger failures do not block source context and are reported to the owner', async () => {
  const f = fixture({ recentLimit: 1, summaryBatchSize: 1 });
  f.usage.failReserve = true;
  f.memory.finalize(segment(1));
  f.memory.finalize(segment(2));
  await drain();
  assert.ok(f.errors[0] instanceof UsageLimitError);
  assert.equal(f.summarizer.calls.length, 0);
  assert.equal(f.memory.snapshot().recent[0]?.id, 'source-2');
  f.usage.failReserve = false;
  f.usage.failSettle = true;
  f.clock.now += 30_000;
  f.memory.finalize(segment(3));
  f.summarizer.gates[0]!.resolve(result());
  await drain();
  assert.ok(f.errors[1] instanceof UsageStorageError);
  assert.equal(f.memory.snapshot().summary, '');
  f.memory.stop();
});

test('stopping clears source memory, aborts summaries and rejects late completion across meetings', async () => {
  const { memory, summarizer, usage } = fixture({ recentLimit: 1, summaryBatchSize: 1 });
  memory.finalize(segment(1));
  memory.finalize(segment(2));
  memory.stop();
  memory.finalize(segment(3));
  assert.equal(summarizer.calls[0]?.signal.aborted, true);
  summarizer.gates[0]!.resolve(result('late private memory'));
  await drain();
  assert.deepEqual(memory.snapshot(), { recent: [], summary: '' });
  assert.equal(usage.records[0]?.actual, undefined);
  assert.equal(memory.replace('source-1', 'late correction'), false);
});

test('pending history remains bounded when a summary stalls and validates memory configuration', () => {
  const { memory, summarizer, events } = fixture({ recentLimit: 2, summaryBatchSize: 2, recentCharLimit: 8000 });
  for (let i = 1; i <= 100; i++) memory.finalize({ ...segment(i), text: `message ${i} ${'x'.repeat(2000)}` });
  assert.ok(memory.snapshot().recent.reduce((sum, entry) => sum + entry.text.length, 0) <= 8000);
  assert.equal(summarizer.calls.length, 1);
  assert.equal(summarizer.calls[0]?.signal.aborted, true);
  assert.ok(events.includes('conversation_history_trimmed'));
  memory.stop();
  assert.throws(() => fixture({ recentLimit: 0 }), RangeError);
});

function providerResponse(summary = 'A speaker expressed uncertainty about grace.') {
  return { status: 'completed', usage: { input_tokens: 300, output_tokens: 100 }, output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ summary }) }] },
  ] };
}

test('GPT summary request uses strict compact schema, grounded rules, source data and shared cost accounting', async () => {
  let sent = '';
  const summarizer = new OpenAISummarizer({ apiKey: 'private-key', model: 'gpt-6.1-terra' }, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    sent = String(init?.body);
    const payload = JSON.parse(sent);
    assert.equal(payload.store, false);
    assert.deepEqual(payload.reasoning, { effort: 'low' });
    assert.equal(payload.text.format.schema.properties.summary.maxLength, 1500);
    assert.match(payload.instructions, /Never turn a paraphrase into an exact Bible quote/);
    assert.match(payload.instructions, /Do not explain theology/);
    assert.deepEqual(JSON.parse(payload.input[0].content).finalized_source_segments, [segment(1), segment(2)]);
    return Response.json(providerResponse());
  });
  const input = { previousSummary: '', segments: [segment(1), segment(2)], signal: new AbortController().signal };
  const estimate = summarizer.estimateUsage(input);
  const output = await summarizer.summarize(input);
  assert.equal(estimate.inputTokens, Buffer.byteLength(sent, 'utf8') + 1024);
  assert.equal(estimate.outputTokens, 2048);
  assert.equal(output.outputTokens, 100);
});

test('summary API rejects invalid, refused, oversized, aborted and late outputs without exposing text or secrets', async () => {
  const input = { previousSummary: '', segments: [segment(1)], signal: new AbortController().signal };
  for (const body of [providerResponse('x'.repeat(1501)), { ...providerResponse(), status: 'incomplete' },
    { ...providerResponse(), usage: { input_tokens: -1, output_tokens: 100 } }]) {
    const summarizer = new OpenAISummarizer({ apiKey: 'private-key', model: 'test-model' }, async () => Response.json(body));
    await assert.rejects(summarizer.summarize(input), (error) => error instanceof SummaryError && error.code === 'summary_invalid_response');
  }
  const failed = new OpenAISummarizer({ apiKey: 'private-key', model: 'test-model' }, async () => { throw new Error('private-key private-source'); });
  await assert.rejects(failed.summarize(input), (error) => {
    assert.ok(error instanceof SummaryError);
    assert.equal(error.code, 'summary_network');
    assert.ok(!error.message.includes('private'));
    assert.equal(error.cause, undefined);
    return true;
  });
  const controller = new AbortController();
  const aborted = new OpenAISummarizer({ apiKey: 'test', model: 'test' }, async () => {
    controller.abort();
    return Response.json(providerResponse());
  });
  await assert.rejects(aborted.summarize({ ...input, signal: controller.signal }), (error) => error instanceof SummaryError && error.code === 'summary_aborted');
});
