import { resolve } from 'node:path';
import { assertRuntime, ConfigError, loadEnvironment, readTranslationConfig } from './config.js';
import { createComparisonVariants } from './model-comparison.js';
import { InterpretationError } from './interpret.js';
import { UsageLedger, UsageStorageError, UsageLimitError } from './usage.js';

// Synthetic text only: no Discord, microphone, private transcript or audio file.
let usage: UsageLedger | undefined;
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort);
try {
  assertRuntime();
  loadEnvironment();
  const config = readTranslationConfig();
  if (!config) throw new ConfigError('TRANSLATION_ENABLED=true와 OPENAI_API_KEY가 필요합니다.');
  usage = new UsageLedger({ filePath: resolve('data/usage.json'), limitUsd: config.monthlyLimitUsd,
    rates: { sttPerMinuteUsd: config.sttPerMinuteUsd, inputPerMillionUsd: config.inputPerMillionUsd,
      outputPerMillionUsd: config.outputPerMillionUsd } });
  console.log('고정된 혼합 언어 예문 1개를 8개 조합에 병렬 요청합니다. API 비용은 기존 월 한도에 기록됩니다.');
  const before = usage.snapshot().estimatedUsd;
  const results = await Promise.allSettled(createComparisonVariants(config.apiKey, config.participantNames, config.glossary, config.targetLanguages).map(async (variant) => {
    const { variantId, model, reasoningEffort } = variant;
    const input = { text: '회의는 fifteen minutes, 십오 분입니다. Fifty minutes가 아닙니다. Бұл соңғы шешім емес.',
      context: ['지금은 회의 일정에 대해 이야기합니다.'], flush: true, signal: controller.signal };
    const started = Date.now();
    try {
      const reservation = usage!.reserve(variant.interpreter.estimateUsage(input), variant);
      const result = await variant.interpreter.interpret(input);
      reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      console.log(JSON.stringify({ event: 'comparison_api_check', variantId, model, reasoningEffort,
        latencyMs: Date.now() - started, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        reasoningTokens: result.reasoningTokens ?? -1,
        estimatedUsd: (result.inputTokens * variant.inputPerMillionUsd + result.outputTokens * variant.outputPerMillionUsd) / 1_000_000,
        completed: result.completed, pending: result.pending }));
    } catch (error) {
      const code = error instanceof InterpretationError || error instanceof UsageStorageError ? error.code
        : error instanceof UsageLimitError ? 'api_budget_limit' : 'comparison_check_failed';
      console.log(JSON.stringify({ event: 'comparison_api_check_failed', variantId, model, reasoningEffort, code }));
      if (error instanceof UsageLimitError || error instanceof UsageStorageError) controller.abort();
      throw new Error(code);
    }
  }));
  const succeeded = results.filter((result) => result.status === 'fulfilled').length;
  console.log(JSON.stringify({ event: 'comparison_api_check_summary', succeeded, total: results.length,
    estimatedUsd: Number((usage.snapshot().estimatedUsd - before).toFixed(9)) }));
  console.log('API 접근과 응답 형식을 확인한 결과입니다. 번역 품질 점수나 실제 통화 지연은 아닙니다.');
  process.exitCode = succeeded === results.length ? 0 : 1;
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : '비교 시험 설정·사용량 잠금을 확인하세요.');
  process.exitCode = 1;
} finally {
  usage?.close();
  process.removeListener('SIGINT', abort);
}
