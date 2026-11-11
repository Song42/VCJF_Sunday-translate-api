import { SUPPORTED_TARGET_LANGUAGES, type TargetLanguage } from './languages.js';
import { OpenAIInterpreter, InterpretationError, type Interpreter, type ReasoningEffort } from './interpret.js';
import type { ParticipantName } from './participants.js';
import type { GlossaryEntry } from './glossary.js';
import { InterpretedCaptionAssembler, InterpretationFlowError, type InterpretedCaption } from './interpreted-captions.js';
import type { TranscriptPiece } from './caption-assembler.js';
import { UsageLimitError, UsageStorageError, type Usage, type UsageLedger, type UsageRates } from './usage.js';

type Rates = Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>;
export interface ComparisonTag {
  variantId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}
export interface ComparisonVariant extends ComparisonTag, Rates { interpreter: Interpreter }
export interface ComparedCaption extends InterpretedCaption {
  comparison: ComparisonTag & { oldestTranscriptLagMs: number; newestTranscriptLagMs: number };
}

export const COMPARISON_PRESETS: readonly (ComparisonTag & Rates)[] = [
  { variantId: 'luna-none', model: 'gpt-6-luna', reasoningEffort: 'none', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
  { variantId: 'luna-high', model: 'gpt-6-luna', reasoningEffort: 'high', inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5 },
  { variantId: 'terra-none', model: 'gpt-6.1-terra', reasoningEffort: 'none', inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  { variantId: 'terra-low', model: 'gpt-6.1-terra', reasoningEffort: 'low', inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  { variantId: 'terra-medium', model: 'gpt-6.1-terra', reasoningEffort: 'medium', inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  { variantId: 'terra-high', model: 'gpt-6.1-terra', reasoningEffort: 'high', inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  { variantId: 'sol-low', model: 'gpt-6.1-sol', reasoningEffort: 'low', inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  { variantId: 'sol-medium', model: 'gpt-6.1-sol', reasoningEffort: 'medium', inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
];

export function createComparisonVariants(apiKey: string, participantNames: readonly ParticipantName[] = [], glossary?: readonly GlossaryEntry[], languages: readonly TargetLanguage[] = SUPPORTED_TARGET_LANGUAGES): ComparisonVariant[] {
  return COMPARISON_PRESETS.map((preset) => ({ ...preset,
    interpreter: new OpenAIInterpreter({ apiKey, model: preset.model, participantNames, targetLanguages: languages,
      ...(glossary ? { glossary } : {}),
      reasoningEffort: preset.reasoningEffort, timeoutMs: 60_000, minimumOutputTokens: 16_384 }),
  }));
}

interface Lane {
  variant: ComparisonVariant;
  assembler: InterpretedCaptionAssembler;
  failed: boolean;
  requests: number;
  successfulRequests: number;
  activeRequests: number;
  errors: number;
  captions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningUsageReports: number;
  estimatedUsd: number;
  requestMs: number;
  maxRequestMs: number;
  captionLagMs: number;
}
interface Options {
  variants: ComparisonVariant[];
  usage: Pick<UsageLedger, 'reserve' | 'snapshot'>;
  silenceMs: number;
  maxHoldMs: number;
  onCaption: (caption: ComparedCaption) => void;
  onDiagnostic: (event: string, fields?: Record<string, string | number | boolean>) => void;
  onError: (error: unknown) => void;
  now?: () => number;
}

/** Fan out committed transcripts, never PCM. Every lane owns its own history and timers. */
export class ModelComparisonAssembler {
  private readonly lanes: Lane[] = [];
  private readonly arrivals = new Map<string, number>();
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly options: Options) {
    if (!options.variants.length || options.variants.length > 8
      || new Set(options.variants.map((item) => item.variantId)).size !== options.variants.length) {
      throw new Error('Comparison requires one to eight unique variants');
    }
    this.now = options.now ?? Date.now;
    for (const variant of options.variants) {
      const tag: ComparisonTag = { variantId: variant.variantId, model: variant.model, reasoningEffort: variant.reasoningEffort };
      const report = (event: string, fields: Record<string, string | number | boolean> = {}) =>
        options.onDiagnostic(event, { ...fields, ...tag });
      const lane: Lane = { variant, assembler: undefined as unknown as InterpretedCaptionAssembler,
        failed: false, requests: 0, successfulRequests: 0, activeRequests: 0, errors: 0, captions: 0,
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0, reasoningUsageReports: 0,
        estimatedUsd: 0, requestMs: 0, maxRequestMs: 0, captionLagMs: 0 };
      const cost = (usage: Usage) => ((usage.inputTokens ?? 0) * variant.inputPerMillionUsd
        + (usage.outputTokens ?? 0) * variant.outputPerMillionUsd) / 1_000_000;
      lane.assembler = new InterpretedCaptionAssembler({
        silenceMs: options.silenceMs, maxHoldMs: options.maxHoldMs, now: this.now,
        usage: {
          snapshot: () => options.usage.snapshot(),
          reserve: (maximum) => {
            const reservation = options.usage.reserve(maximum, variant);
            const reservedCost = cost(maximum);
            lane.estimatedUsd += reservedCost;
            let settled = false;
            return { settle: (actual) => {
              reservation.settle(actual);
              if (settled) return;
              settled = true;
              lane.estimatedUsd += cost(actual) - reservedCost;
              lane.inputTokens += actual.inputTokens ?? 0;
              lane.outputTokens += actual.outputTokens ?? 0;
            } };
          },
        },
        interpreter: {
          estimateUsage: (input) => variant.interpreter.estimateUsage(input),
          interpret: async (input) => {
            lane.requests += 1;
            lane.activeRequests += 1;
            const start = this.now();
            try {
              const result = await variant.interpreter.interpret(input);
              if (this.stopped || lane.failed || input.signal.aborted) throw new InterpretationError('interpretation_aborted');
              const latencyMs = this.now() - start;
              lane.successfulRequests += 1;
              lane.requestMs += latencyMs;
              lane.maxRequestMs = Math.max(lane.maxRequestMs, latencyMs);
              if (result.reasoningTokens !== undefined) {
                lane.reasoningTokens += result.reasoningTokens;
                lane.reasoningUsageReports += 1;
              }
              report('comparison_request_usage', { latencyMs, inputTokens: result.inputTokens,
                outputTokens: result.outputTokens, reasoningTokens: result.reasoningTokens ?? -1,
                estimatedRequestUsd: cost(result) });
              return result;
            } finally { lane.activeRequests -= 1; }
          },
        },
        onCaption: (caption) => {
          if (this.stopped || lane.failed) return;
          const times = caption.sourceSegmentIds.map((id) => this.arrivals.get(id) ?? this.now());
          const oldestTranscriptLagMs = this.now() - Math.min(...times);
          const newestTranscriptLagMs = this.now() - Math.max(...times);
          lane.captions += 1;
          lane.captionLagMs += oldestTranscriptLagMs;
          report('comparison_caption_ready', { variantSequence: lane.captions, boundary: caption.boundary,
            oldestTranscriptLagMs, newestTranscriptLagMs });
          options.onCaption({ ...caption, segmentId: `${tag.variantId}:${caption.segmentId}`,
            comparison: { ...tag, oldestTranscriptLagMs, newestTranscriptLagMs } });
        },
        onDiagnostic: report,
        onError: (error) => {
          if (this.stopped || lane.failed) return;
          lane.errors += 1;
          lane.failed = true;
          lane.assembler.stop();
          const code = error instanceof InterpretationError || error instanceof InterpretationFlowError
            ? error.code : error instanceof UsageLimitError ? 'api_budget_limit'
            : error instanceof UsageStorageError ? 'usage_storage' : 'comparison_error';
          report('comparison_variant_failed', { code });
          // A common budget/storage/auth failure stops the entire meeting. Individual
          // model/rate/timeout failures stop only that lane, with no paid retry.
          if (error instanceof UsageLimitError || error instanceof UsageStorageError
            || (error instanceof InterpretationError && error.code === 'interpretation_auth')) {
            this.stop();
            options.onError(error);
          } else if (this.lanes.every((item) => item.failed)) {
            this.stop();
            options.onError(new InterpretationFlowError('interpretation_failed'));
          }
        },
      });
      this.lanes.push(lane);
      report('comparison_variant_configured');
    }
  }

  activity(speakerId: string): void {
    if (!this.stopped) for (const lane of this.lanes) if (!lane.failed) lane.assembler.activity(speakerId);
  }
  accept(piece: TranscriptPiece): void {
    if (this.stopped) return;
    this.arrivals.set(piece.segmentId, this.now());
    while (this.arrivals.size > 8192) this.arrivals.delete(this.arrivals.keys().next().value!);
    for (const lane of this.lanes) {
      if (this.stopped) break;
      if (!lane.failed) lane.assembler.accept({ ...piece });
    }
  }
  gap(speakerId: string): void {
    if (!this.stopped) for (const lane of this.lanes) if (!lane.failed) lane.assembler.gap(speakerId);
  }
  summaries(): Record<string, string | number | boolean>[] {
    return this.lanes.map((lane) => ({ variantId: lane.variant.variantId, model: lane.variant.model,
      reasoningEffort: lane.variant.reasoningEffort, failed: lane.failed, requests: lane.requests,
      successfulRequests: lane.successfulRequests, activeRequestsAtSummary: lane.activeRequests,
      errors: lane.errors, captions: lane.captions, inputTokens: lane.inputTokens, outputTokens: lane.outputTokens,
      reasoningTokens: lane.reasoningTokens, reasoningUsageReports: lane.reasoningUsageReports,
      meanRequestMs: lane.successfulRequests ? Math.round(lane.requestMs / lane.successfulRequests) : 0,
      maxRequestMs: lane.maxRequestMs,
      meanOldestTranscriptLagMs: lane.captions ? Math.round(lane.captionLagMs / lane.captions) : 0,
      estimatedUsd: Number(lane.estimatedUsd.toFixed(9)) }));
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const lane of this.lanes) lane.assembler.stop();
    for (const summary of this.summaries()) this.options.onDiagnostic('comparison_variant_summary', summary);
    this.arrivals.clear();
  }
}
