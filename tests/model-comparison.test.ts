import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { COMPARISON_PRESETS, ModelComparisonAssembler, type ComparedCaption } from '../src/model-comparison.js';
import { InterpretationError, type InterpretationRequest, type InterpretationResult, type Interpreter } from '../src/interpret.js';
import { UsageLimitError, type Usage, type UsageRates } from '../src/usage.js';
import { LiveTranslationPipeline } from '../src/pipeline.js';
import type { Caption } from '../src/types.js';

const drain = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
const part = (originalText: string) => ({ originalText,
  translations: { ko: originalText, ru: originalText, kk: originalText, en: originalText } });
class FakeInterpreter implements Interpreter {
  calls: InterpretationRequest[] = [];
  pending: { resolve: (result: InterpretationResult) => void; reject: (error: unknown) => void }[] = [];
  estimateUsage() { return { inputTokens: 1000, outputTokens: 2000 }; }
  interpret(input: InterpretationRequest): Promise<InterpretationResult> {
    this.calls.push({ ...input, context: [...input.context] });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  answer(index: number, completed: string[], pending = '') {
    this.pending[index]!.resolve({ completed: completed.map(part), pending,
      inputTokens: 100, outputTokens: 50, reasoningTokens: 10 });
  }
}
class FakeUsage {
  entries: { max: Usage; actual?: Usage; rates: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'> | undefined }[] = [];
  limitAfter = Infinity;
  reserve(max: Usage, rates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>) {
    if (this.entries.length >= this.limitAfter) throw new UsageLimitError();
    const entry = { max, rates } as typeof this.entries[number];
    this.entries.push(entry);
    return { settle: (actual: Usage) => { entry.actual = actual; } };
  }
  snapshot() { return { month: '2026-11', estimatedUsd: 0, audioMs: 0, inputTokens: 0, outputTokens: 0, limitUsd: 10 }; }
}
function harness(t: TestContext, count = 2) {
  const fakes = COMPARISON_PRESETS.slice(0, count).map(() => new FakeInterpreter());
  const variants = COMPARISON_PRESETS.slice(0, count).map((preset, i) => ({ ...preset, interpreter: fakes[i]! }));
  const usage = new FakeUsage();
  const captions: ComparedCaption[] = [];
  const errors: unknown[] = [];
  const events: { event: string; fields?: Record<string, string | number | boolean> }[] = [];
  const assembler = new ModelComparisonAssembler({ variants, usage, silenceMs: 4000, maxHoldMs: 8000,
    onCaption: (caption) => captions.push(caption), onError: (error) => errors.push(error),
    onDiagnostic: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }) });
  let sequence = 0;
  const accept = (text: string) => {
    assembler.activity('A');
    assembler.accept({ segmentId: `source-${++sequence}`, sequence, speakerId: 'A', speakerName: 'Alice', text });
  };
  t.after(() => assembler.stop());
  return { fakes, variants, usage, captions, errors, events, assembler, accept };
}

test('eight variants receive identical STT input; completed fast lanes never wait for slow lanes', async (t) => {
  const h = harness(t, 8);
  assert.deepEqual(h.variants.map((v) => v.variantId), ['luna-none', 'luna-high', 'terra-none', 'terra-low',
    'terra-medium', 'terra-high', 'sol-low', 'sol-medium']);
  h.accept('Hello.');
  assert.ok(h.fakes.every((fake) => fake.calls.length === 1 && fake.calls[0]!.text === 'Hello.'));
  h.fakes[0]!.answer(0, ['Hello.']);
  await drain();
  assert.equal(h.captions.length, 1);
  assert.equal(h.captions[0]!.comparison.variantId, 'luna-none');
  for (const fake of h.fakes.slice(1)) fake.answer(0, ['Hello.']);
  await drain();
  assert.equal(h.captions.length, 8);
  assert.equal(new Set(h.captions.map((c) => c.segmentId)).size, 8);
  assert.ok(h.captions.every((c) => c.sourceSegmentIds[0] === 'source-1'));
  assert.equal(h.usage.entries.length, 8);
  assert.deepEqual(h.usage.entries.map((e) => e.rates?.inputPerMillionUsd), [0.1, 0.1, 1, 1, 1, 1, 2, 2]);
  const rows = h.assembler.summaries();
  assert.equal(rows[0]!.estimatedUsd, 0.000035);
  assert.equal(rows[6]!.estimatedUsd, 0.0007);
  assert.equal(rows[0]!.outputTokens, 50, 'reasoning tokens are already included in output tokens');
  assert.equal(rows[0]!.reasoningTokens, 10);
});

test('pending text and prior context belong to each variant independently', async (t) => {
  const h = harness(t);
  h.accept('First. Topic');
  h.fakes[0]!.answer(0, ['First.'], 'Topic');
  h.fakes[1]!.answer(0, [], 'First. Topic');
  await drain();
  h.accept('ends.');
  assert.equal(h.fakes[0]!.calls[1]!.text, 'Topic ends.');
  assert.deepEqual(h.fakes[0]!.calls[1]!.context, ['First.']);
  assert.equal(h.fakes[1]!.calls[1]!.text, 'First. Topic ends.');
  assert.deepEqual(h.fakes[1]!.calls[1]!.context, []);
});

test('a denied model stops only its lane, retains unknown cost, and does not retry', async (t) => {
  const h = harness(t);
  h.accept('Hello.');
  h.fakes[0]!.pending[0]!.reject(new InterpretationError('interpretation_model'));
  h.fakes[1]!.answer(0, ['Hello.']);
  await drain();
  h.accept('Next.');
  assert.equal(h.fakes[0]!.calls.length, 1);
  assert.equal(h.fakes[1]!.calls.length, 2);
  assert.equal(h.errors.length, 0);
  assert.equal(h.assembler.summaries()[0]!.failed, true);
  assert.equal(h.assembler.summaries()[0]!.estimatedUsd, 0.0011);
  assert.equal(h.captions.length, 1);
});

test('shared budget exhaustion stops all lanes before further API work', async (t) => {
  const h = harness(t, 8);
  h.usage.limitAfter = 2;
  h.accept('Hello.');
  await drain();
  assert.equal(h.fakes.reduce((n, f) => n + f.calls.length, 0), 2);
  assert.ok(h.fakes.slice(0, 2).every((f) => f.calls[0]!.signal.aborted));
  assert.ok(h.errors[0] instanceof UsageLimitError);
  h.accept('Ignored.');
  assert.equal(h.usage.entries.length, 2);
});

test('stop aborts all lanes, emits eight summaries once, and suppresses late captions', async (t) => {
  const h = harness(t, 8);
  h.accept('Hello.');
  h.assembler.stop();
  h.assembler.stop();
  assert.ok(h.fakes.every((f) => f.calls[0]!.signal.aborted));
  for (const fake of h.fakes) fake.answer(0, ['Hello.']);
  await drain();
  assert.equal(h.captions.length, 0);
  assert.equal(h.events.filter((e) => e.event === 'comparison_variant_summary').length, 8);
  assert.ok(h.usage.entries.every((e) => e.actual === undefined));
});

test('transport gaps reset prior context in every lane', async (t) => {
  const h = harness(t);
  h.accept('Old.');
  for (const fake of h.fakes) fake.answer(0, ['Old.']);
  await drain();
  h.assembler.gap('A');
  h.accept('New.');
  assert.ok(h.fakes.every((f) => f.calls[1]!.context.length === 0));
});

test('live pipeline captures and bills STT once while publishing eight tagged translations', async (t) => {
  const h = harness(t, 8);
  const captions: Caption[] = [];
  let sessions = 0;
  let commits = 0;
  let bytes = 0;
  const pipeline = new LiveTranslationPipeline({ segmentMs: 4000, comparisonVariants: h.variants, usage: h.usage,
    createTranscriber: () => {
      sessions += 1;
      return { connect: async () => {}, append: (pcm) => { bytes += pcm.length; },
        commit: async () => { commits += 1; return 'Hello.'; }, close: () => {} };
    },
    translator: { estimateUsage: () => { throw Error('legacy called'); }, translate: async () => { throw Error('legacy called'); } },
    speakerName: () => 'Alice', onCaption: (c) => captions.push(c), onDiagnostic: () => {},
  });
  t.after(() => pipeline.stop());
  pipeline.push('A', Buffer.alloc(4800));
  pipeline.end('A', 'silence');
  await drain();
  assert.equal(sessions, 1);
  assert.equal(commits, 1);
  assert.equal(bytes, 4800);
  assert.equal(h.usage.entries.filter((e) => e.max.audioMs).length, 1);
  assert.equal(h.usage.entries.filter((e) => e.max.inputTokens).length, 8);
  for (const fake of h.fakes) fake.answer(0, ['Hello.']);
  await drain();
  assert.equal(captions.length, 8);
  assert.equal(new Set(captions.map((c) => c.comparison?.variantId)).size, 8);
  assert.equal(new Set(captions.map((c) => c.sourceSegmentIds?.[0])).size, 1);
});
