import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertRuntime, ConfigError, loadEnvironment, readTranslationConfig } from './config.js';
import { InterpretationError, OpenAIInterpreter, INTERPRETATION_REASONING_EFFORT, type InterpretedPart } from './interpret.js';
import { OpenAISegmenter, SegmentationError } from './segment.js';
import { TranslationError } from './translate.js';
import { OpenAIParallelTranslator } from './parallel-translate.js';
import { UsageLedger, UsageLimitError, UsageStorageError, type Usage, type UsageRates } from './usage.js';

// Deliberately synthetic, fixed text. This command never opens Discord, captures audio,
// reads transcript logs, or writes original/translated speech to disk.
interface ComparisonCase {
  name: string;
  text: string;
  expected: string;
  pending: string;
  flush: boolean;
  context?: string[];
  singleUnit?: boolean;
  allowWholePending?: boolean;
  flagOperatingAssertion?: boolean;
  expectedEnglish?: RegExp;
  forbiddenEnglish?: RegExp;
}

const comparisonCases: ComparisonCase[] = [
  { name: 'ko_complete_and_tail', text: '오늘은 창세기를 살펴보겠습니다. 여기서 가장 중요한 것은.',
    expected: '오늘은 창세기를 살펴보겠습니다.', pending: '여기서 가장 중요한 것은.', flush: false },
  { name: 'ko_joined_fragment', text: '여기서 가장 중요한 것은. 아담과 하와가 어떤 선택을 했는지입니다.',
    expected: '여기서 가장 중요한 것은. 아담과 하와가 어떤 선택을 했는지입니다.', pending: '', flush: false },
  { name: 'ko_forced_fragment', text: '제가 말씀드리려던 것은',
    expected: '제가 말씀드리려던 것은', pending: '', flush: true },
  { name: 'en_complete', text: 'We will read the passage together and discuss its meaning.',
    expected: 'We will read the passage together and discuss its meaning.', pending: '', flush: false },
  { name: 'ru_complete', text: 'Сегодня мы вместе прочитаем этот отрывок и обсудим его смысл.',
    expected: 'Сегодня мы вместе прочитаем этот отрывок и обсудим его смысл.', pending: '', flush: false },
  { name: 'kk_complete', text: 'Бүгін біз осы үзіндіні бірге оқып, оның мағынасын талқылаймыз.',
    expected: 'Бүгін біз осы үзіндіні бірге оқып, оның мағынасын талқылаймыз.', pending: '', flush: false },
];

// Reproduce the input shape that short end-to-end smoke examples missed: a dangling
// fragment arrives alone, then a continuation arrives with an artificial STT period.
const topicContext = ['아담과 하와는 에덴동산에 살았습니다.', '사람은 하느님의 명령을 받았습니다.'];
const operationContext = ['이제 그 선택의 결과를 살펴보겠습니다.', '문맥을 나눠 보내는 통역 모델을 도입했고'];
const operationText = '이제 작동. 상태를 확인하려고 하는데.';
const boundaryCases: ComparisonCase[] = [
  { name: 'ko_isolated_topic', text: '여기서 가장 중요한 것은.', expected: '',
    pending: '여기서 가장 중요한 것은.', flush: false, context: topicContext },
  { name: 'ko_isolated_operation', text: '이제 작동.', expected: '', pending: '이제 작동.',
    flush: false, context: operationContext, flagOperatingAssertion: true },
  { name: 'ko_completed_prefix_and_topic', text: '오늘은 창세기를 살펴보겠습니다. 여기서 가장 중요한 것은.',
    expected: '오늘은 창세기를 살펴보겠습니다.', pending: '여기서 가장 중요한 것은.', flush: false },
  { name: 'ko_joined_operation', text: operationText, expected: operationText, pending: '',
    flush: false, context: operationContext, singleUnit: true, allowWholePending: true,
    flagOperatingAssertion: true },
  { name: 'ko_joined_operation_forced', text: operationText, expected: operationText, pending: '',
    flush: true, context: operationContext, singleUnit: true, flagOperatingAssertion: true },
  { name: 'ko_complete_statement', text: '이제 그 선택의 결과를 살펴보겠습니다.',
    expected: '이제 그 선택의 결과를 살펴보겠습니다.', pending: '', flush: false, context: topicContext },
  { name: 'ko_short_acknowledgment', text: '네.', expected: '네.', pending: '', flush: false,
    context: ['함께 읽어 볼까요?'] },
  // Tests both a valid short English acknowledgment and a dangling English topic.
  { name: 'en_acknowledgment_and_topic', text: 'Yes. The most important thing here is.', expected: 'Yes.',
    pending: 'The most important thing here is.', flush: false, context: ['Shall we discuss this passage?'] },
  { name: 'ru_short_acknowledgment', text: 'Да.', expected: 'Да.', pending: '', flush: false,
    context: ['Прочитаем вместе?'] },
  { name: 'kk_short_acknowledgment', text: 'Иә.', expected: 'Иә.', pending: '', flush: false,
    context: ['Бірге оқимыз ба?'] },
  { name: 'ru_isolated_topic', text: 'Самое важное здесь —', expected: '',
    pending: 'Самое важное здесь —', flush: false, context: ['Сегодня мы обсудим этот отрывок.'] },
  { name: 'kk_isolated_topic', text: 'Мұндағы ең маңыздысы —', expected: '',
    pending: 'Мұндағы ең маңыздысы —', flush: false, context: ['Бүгін біз осы үзіндіні талқылаймыз.'] },
];

// Source fidelity remains mandatory. These narrow English indicators complement
// manual review of all four translations; they are not general quality scores.
const recognitionCases: ComparisonCase[] = [
  { name: 'broken_operation_word', text: '이제 작 상태를 확인하려고 하는데.',
    expected: '이제 작 상태를 확인하려고 하는데.', pending: '', flush: true,
    context: ['문맥을 나눠 보내는 통역 모드를 도입했고,'],
    expectedEnglish: /operat|function|working/iu, forbiddenEnglish: /\bjak\b/iu },
  { name: 'broken_context_word', text: '몸맥을 나눠 보내는 통역 모델을 도입했고.',
    expected: '몸맥을 나눠 보내는 통역 모델을 도입했고.', pending: '', flush: true,
    context: ['발언을 문장 단위로 나눠 번역합니다.'],
    expectedEnglish: /context|meaning|semantic/iu, forbiddenEnglish: /\bpulse\b/iu },
  { name: 'explicit_product_name', text: '제품 이름은 작입니다. 작의 상태를 확인하겠습니다.',
    expected: '제품 이름은 작입니다. 작의 상태를 확인하겠습니다.', pending: '', flush: false,
    // A proper name may retain its original script or be transliterated.
    context: ['새 장치의 이름을 정했습니다.'], expectedEnglish: /\bjak\b|(?<!\p{L})작(?!\p{L})/iu },
  { name: 'negation_is_preserved', text: '작동하지 않는 상태입니다.',
    expected: '작동하지 않는 상태입니다.', pending: '', flush: false,
    context: ['장치를 켜 봤습니다.'],
    expectedEnglish: /\bnot\b|n['’]t|non[- ]?(?:function|operat)|inoperat|out of order/iu },
  { name: 'topic_still_waits', text: '여기서 가장 중요한 것은.',
    expected: '', pending: '여기서 가장 중요한 것은.', flush: false },
  { name: 'bare_noun_is_not_completed_by_repair', text: '이제 작동.',
    expected: '', pending: '이제 작동.', flush: false,
    context: ['문맥을 나눠 보내는 통역 모델을 도입했고.'], flagOperatingAssertion: true },
  { name: 'unknown_word_is_not_guessed_from_status', text: '라뭉 상태를 확인하겠습니다.',
    expected: '라뭉 상태를 확인하겠습니다.', pending: '', flush: true,
    forbiddenEnglish: /operating|operational|functioning/iu },
];

let usage: UsageLedger | undefined;
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);

try {
  assertRuntime();
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--boundaries', '--recognition'].includes(arg))
    || (args.includes('--boundaries') && args.includes('--recognition'))) {
    throw new ConfigError('--boundaries 또는 --recognition 중 한 가지 옵션만 사용할 수 있습니다.');
  }
  const boundariesOnly = args.includes('--boundaries');
  const recognitionOnly = args.includes('--recognition');
  const combinedOnly = boundariesOnly || recognitionOnly;
  const cases = boundariesOnly ? boundaryCases : recognitionOnly ? recognitionCases : comparisonCases;
  loadEnvironment();
  const config = readTranslationConfig();
  if (!config) throw new ConfigError('비교 시험에는 TRANSLATION_ENABLED=true와 OPENAI_API_KEY가 필요합니다.');
  usage = new UsageLedger({ filePath: resolve('data/usage.json'), limitUsd: config.monthlyLimitUsd,
    rates: { sttPerMinuteUsd: config.sttPerMinuteUsd,
      inputPerMillionUsd: config.inputPerMillionUsd, outputPerMillionUsd: config.outputPerMillionUsd } });
  const beforeUsd = usage.snapshot().estimatedUsd;
  const interpreter = new OpenAIInterpreter({ apiKey: config.apiKey, model: config.translationModel, targetLanguages: config.targetLanguages,
    participantNames: config.participantNames, glossary: config.glossary });
  const segmenter = new OpenAISegmenter({ apiKey: config.apiKey, model: config.segmentationModel });
  const translator = new OpenAIParallelTranslator({ apiKey: config.apiKey, model: config.translationModel,
    reasoningEffort: config.translationReasoningEffort,
    participantNames: config.participantNames, glossary: config.glossary });
  const segmentationRates = { inputPerMillionUsd: config.segmentationInputPerMillionUsd,
    outputPerMillionUsd: config.segmentationOutputPerMillionUsd };
  const rows: { mode: string; latencyMs: number; firstCaptionMs: number | null; requests: number;
    boundaryPass: boolean; translationRegression: boolean }[] = [];
  console.log(`고정된 예문 ${cases.length}개로 실제 API ${recognitionOnly ? '통합 모드 문맥 해석을 검사' : boundariesOnly ? '통합 모드 경계를 검사' : '두 모드를 비교'}합니다. API 요금은 기존 월 한도에 기록됩니다.`);
  console.log('판단+번역 단계만 측정하며, STT·음성 대기 시간과 번역 품질 점수는 포함하지 않습니다.');
  for (const [index, sample] of cases.entries()) {
    // Alternate order to avoid giving one mode every first request; one pass is a smoke
    // comparison, not a statistically reliable latency or language-quality evaluation.
    const modes = combinedOnly ? ['combined'] as const
      : index % 2 ? ['separate', 'combined'] as const : ['combined', 'separate'] as const;
    for (const mode of modes) {
      if (controller.signal.aborted) throw new InterpretationError('interpretation_aborted');
      const started = performance.now();
      let requests = 0;
      let firstCaptionMs: number | null = null;
      const bill = async <T extends { inputTokens: number; outputTokens: number }>(
        maximum: Usage, run: () => Promise<T>, rates?: Pick<UsageRates, 'inputPerMillionUsd' | 'outputPerMillionUsd'>,
      ): Promise<T> => {
        const reservation = usage!.reserve(maximum, rates);
        requests += 1;
        const result = await run();
        reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        return result;
      };
      const input = { text: sample.text, context: (sample.context ?? []).slice(-2),
        flush: sample.flush, signal: controller.signal };
      let completed: InterpretedPart[];
      let pending: string;
      if (mode === 'combined') {
        const result = await bill(interpreter.estimateUsage(input), () => interpreter.interpret(input));
        completed = result.completed;
        pending = result.pending;
        if (completed.length) firstCaptionMs = Math.round(performance.now() - started);
      } else {
        const decision = sample.flush ? { completed: [sample.text], pending: '' }
          : await bill(segmenter.estimateUsage(input), () => segmenter.segment(input), segmentationRates);
        completed = [];
        pending = decision.pending;
        const context = [...input.context];
        for (const originalText of decision.completed) {
          const request = { originalText, context: context.slice(-2), signal: controller.signal };
          const result = await bill(translator.estimateUsage(request), () => translator.translate(request));
          requests += 3; // Four parallel language requests share one aggregate reservation.
          completed.push({ originalText, translations: result.translations });
          firstCaptionMs ??= Math.round(performance.now() - started);
          context.push(originalText);
        }
      }
      const latencyMs = Math.round(performance.now() - started);
      const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
      const expectedBoundary = normalize(completed.map((part) => part.originalText).join(' ')) === normalize(sample.expected)
        && normalize(pending) === normalize(sample.pending)
        && (!sample.singleUnit || completed.length === 1);
      const wholePending = Boolean(sample.allowWholePending) && completed.length === 0
        && normalize(pending) === normalize(sample.text);
      const boundaryPass = expectedBoundary || wholePending;
      // A narrow observed regression indicator, not an automatic translation grader.
      // All output remains visible for a human to review paraphrases and other languages.
      const english = completed.map((part) => part.translations.en).join(' ');
      const translationRegression = config.targetLanguages.includes('en') && ((Boolean(sample.flagOperatingAssertion) && /\bnow\s+it\s+works\b/iu.test(english))
        || (sample.expectedEnglish !== undefined && !sample.expectedEnglish.test(english))
        || (sample.forbiddenEnglish !== undefined && sample.forbiddenEnglish.test(english)));
      rows.push({ mode, latencyMs, firstCaptionMs, requests, boundaryPass, translationRegression });
      console.log(JSON.stringify({ event: 'caption_comparison', case: sample.name, mode,
        model: config.translationModel, reasoningEffort: mode === 'separate' ? config.translationReasoningEffort : INTERPRETATION_REASONING_EFFORT,
        latencyMs, firstCaptionMs, requests, boundaryCheck: boundaryPass ? 'PASS' : 'REVIEW',
        ...(translationRegression ? { translationRegression: 'translation_check_failed' } : {}), completed, pending }));
    }
  }
  for (const mode of ['combined', 'separate']) {
    const results = rows.filter((row) => row.mode === mode);
    if (!results.length) continue;
    console.log(JSON.stringify({ event: 'caption_comparison_summary', mode, cases: results.length,
      model: config.translationModel, reasoningEffort: mode === 'separate' ? config.translationReasoningEffort : INTERPRETATION_REASONING_EFFORT,
      boundaryChecksPassed: results.filter((row) => row.boundaryPass).length,
      translationRegressionFlags: results.filter((row) => row.translationRegression).length,
      requests: results.reduce((sum, row) => sum + row.requests, 0),
      meanProcessingMs: Math.round(results.reduce((sum, row) => sum + row.latencyMs, 0) / results.length) }));
  }
  console.log(JSON.stringify({ event: 'caption_comparison_cost',
    totalEstimatedTestUsd: Number((usage.snapshot().estimatedUsd - beforeUsd).toFixed(8)) }));
  console.log('이 결과는 예문 경계와 응답 형식을 확인한 것입니다. 실제 통화 지연과 네 언어 번역 품질은 별도 확인하세요.');
  process.exitCode = rows.every((row) => row.boundaryPass && !row.translationRegression) ? 0 : 1;
} catch (error) {
  const code = error instanceof InterpretationError || error instanceof SegmentationError
    || error instanceof TranslationError || error instanceof UsageStorageError ? error.code
    : error instanceof UsageLimitError ? 'api_budget_limit' : 'comparison_failed';
  console.error(error instanceof ConfigError ? error.message : `비교 시험 중지: ${code}`);
  process.exitCode = 1;
} finally {
  usage?.close();
  process.removeListener('SIGINT', interrupt);
}
