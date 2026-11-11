import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRuntime, ConfigError, loadEnvironment, readTranslationConfig } from './config.js';
import { AudioBenchmarkError, MAX_BENCHMARK_WAV_BYTES, consumeBenchmarkSource, parseBenchmarkArguments, parseBenchmarkWav, replayBenchmarkAudio, transcriptionErrorRates, type BenchmarkSourceSpan } from './audio-benchmark-core.js';
import { RealtimeTranscriber, SttError } from './stt.js';
import { DirectTranslationError, RealtimeDirectTranslator } from './direct-translation.js';
import { InterpretationError, OpenAIInterpreter, type InterpretedPart } from './interpret.js';
import { OpenAISegmenter, SegmentationError } from './segment.js';
import { OpenAIParallelTranslator } from './parallel-translate.js';
import { TranslationError } from './translate.js';
import { ConversationMemory, OpenAISummarizer, SummaryError } from './conversation-memory.js';
import { buildTranscriptionHints } from './glossary.js';
import { captionTrace, closeRunLog, diagnostic, startRunLog } from './log.js';
import { UsageLedger, UsageLimitError, UsageStorageError, type UsageReservation } from './usage.js';
import { AccuracySession } from './accuracy-session.js';
import { OpenAIAccuracyReviewer } from './accuracy-review.js';
import { OpenAIAudioRetranscriber } from './audio-retranscribe.js';
import type { Caption } from './types.js';
import { LiveTranslationPipeline } from './pipeline.js';

const HELP = `사용법: npm run audio:benchmark -- recording.wav [--reference reference.txt] [--direct]
WAV: 모노 24kHz PCM16, 0.1~300초(5분). .env의 STT_DELAY 및 번역 설정으로 한 경로만 실행합니다.
전사 결과는 같은 GPT 모델로 직접 네 언어로 번역합니다. --direct는 별도 GPT Realtime Translation 네 언어 비교도 추가합니다.
CAPTION_MODE의 streaming/separate/combined, 문맥 메모리와 선택 검증 설정을 적용하며 임시·초기·최종 자막을 기록합니다.
--reference는 사람이 확인한 원문입니다. CER/공백 토큰 WER는 전사 오류율이며 번역 정확도 점수가 아닙니다.
실제 API 요금이 발생하고 기존 data/usage.json 월 한도를 공유합니다. 실행 로그는 logs/에 저장됩니다.
봇을 종료한 뒤 실행하세요. 녹음·파일 변환은 자동 수행하지 않습니다.`;

function code(error: unknown): string {
  if (error instanceof UsageLimitError) return 'api_budget_limit';
  if (error instanceof AudioBenchmarkError || error instanceof UsageStorageError || error instanceof SttError
    || error instanceof InterpretationError || error instanceof SegmentationError || error instanceof TranslationError
    || error instanceof DirectTranslationError || error instanceof SummaryError) return error.code;
  return 'benchmark_failed';
}
function readBounded(path: string, maxBytes: number): Buffer {
  try { if (!statSync(path).isFile() || statSync(path).size > maxBytes) throw new Error(); return readFileSync(path); }
  catch { throw new AudioBenchmarkError('benchmark_file', '입력 파일을 읽을 수 없거나 허용 크기를 초과했습니다. WAV는 최대 300초(5분)·16MB, 정답 텍스트는 64KB입니다.'); }
}

interface SourceLane {
  id: string;
  stt: RealtimeTranscriber;
  interpreter: OpenAIInterpreter;
  segmenter: OpenAISegmenter;
  translator: OpenAIParallelTranslator;
  memory: ConversationMemory;
  controller: AbortController;
  active: boolean;
  failed: boolean;
  complete: boolean;
  chain: Promise<void>;
  source: Map<number, string>;
  partials: Map<number, string>;
  spans: BenchmarkSourceSpan[];
  pendingText: string;
  accuracy?: AccuracySession;
  pipeline?: LiveTranslationPipeline;
  pendingFinals: Set<number>;
  finalWaiters: (() => void)[];
  finalCount: number;
  reviewedCount: number;
  captionCount: number;
  audioBytes: number;
  audioReservation?: UsageReservation;
  firstPartialMs?: number;
  firstFinalMs?: number;
  firstCaptionMs?: number;
  finalLags: number[];
}
interface DirectLane {
  id: string;
  translator: RealtimeDirectTranslator;
  failed: boolean;
  complete: boolean;
  active: boolean;
  audioBytes: number;
  audioReservation?: UsageReservation;
  firstTextMs?: number;
}

let usage: UsageLedger | undefined;
let pcm: Buffer | undefined;
const sources: SourceLane[] = [];
const direct: DirectLane[] = [];
const controller = new AbortController();
let started = 0;
let drainTimer: NodeJS.Timeout | undefined;
const elapsed = () => Math.round(performance.now() - started);
const stop = () => {
  controller.abort();
  for (const lane of sources) {
    lane.controller.abort(); lane.stt.close(); lane.memory.stop(); lane.accuracy?.stop();
    lane.pipeline?.stop();
    lane.pendingFinals.clear(); lane.finalWaiters.splice(0).forEach((done) => done());
  }
  for (const lane of direct) lane.translator.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const args = parseBenchmarkArguments(process.argv.slice(2));
  if (args.help) console.log(HELP);
  else {
    assertRuntime();
    const file = readBounded(args.file!, MAX_BENCHMARK_WAV_BYTES);
    try { pcm = parseBenchmarkWav(file); } finally { file.fill(0); }
    const reference = args.reference ? readBounded(args.reference, 64 * 1024).toString('utf8').replace(/^\uFEFF/, '').trim() : undefined;
    if (reference !== undefined && !reference) throw new AudioBenchmarkError('benchmark_reference_empty', '정답 텍스트 파일이 비어 있습니다.');
    loadEnvironment();
    const config = readTranslationConfig();
    if (!config) throw new ConfigError('TRANSLATION_ENABLED=true와 OPENAI_API_KEY가 필요합니다.');
    if (config.captionMode === 'compare') throw new ConfigError('녹음 지연 비교에는 CAPTION_MODE=streaming, separate 또는 combined를 사용하세요.');
    startRunLog({ onFailure: stop });
    usage = new UsageLedger({ filePath: resolve('data/usage.json'), limitUsd: config.monthlyLimitUsd,
      rates: { sttPerMinuteUsd: 0.017, inputPerMillionUsd: config.inputPerMillionUsd, outputPerMillionUsd: config.outputPerMillionUsd } });
    const before = usage.snapshot().estimatedUsd;
    const audioMs = pcm.length / 48;
    const hints = buildTranscriptionHints(config.glossary, config.sttKeywords);
    diagnostic('audio_benchmark_started', { audioMs, sourceLanes: 1, directLanes: args.direct ? config.targetLanguages.length : 0,
      sttDelay: config.sttDelay, sttModel: config.sttModel,
      referenceProvided: reference !== undefined, translationModel: config.translationModel,
      captionMode: config.captionMode, verification: config.reviewEnabled, contextMemory: config.contextMemoryEnabled,
      targetLanguages: config.targetLanguages.join(','),
      reasoningEffort: config.captionMode === 'streaming' || config.captionMode === 'separate'
        ? config.translationReasoningEffort : 'low',
      note: config.captionMode === 'streaming'
        ? 'Production streaming pipeline with local speech silence, transport checkpoints, mutable drafts and selective final review. Transcription scores do not measure translation meaning.'
        : 'Same fixed four-second source turns for legacy delay comparison. Transcription scores do not measure translation meaning.' });
    const globalError = (error: unknown) => { if (error instanceof UsageStorageError || error instanceof UsageLimitError) stop(); };
    const failSource = (lane: SourceLane, error: unknown) => {
      if (lane.failed) return;
      lane.failed = true; lane.active = false; lane.controller.abort(); lane.stt.close(); lane.memory.stop(); lane.accuracy?.stop();
      lane.pipeline?.stop();
      lane.pendingFinals.clear(); lane.finalWaiters.splice(0).forEach((done) => done());
      diagnostic('audio_benchmark_lane_failed', { lane: lane.id, code: code(error) }); globalError(error);
    };
    const deliverCaption = (lane: SourceLane, caption: Caption) => {
      if (lane.failed || controller.signal.aborted) return;
      lane.captionCount = Math.max(lane.captionCount, caption.sequence);
      if (caption.status === 'initial' || caption.status === 'draft') lane.pendingFinals.add(caption.sequence);
      else {
        lane.pendingFinals.delete(caption.sequence); lane.finalCount++;
        if (caption.accuracy && ['verified', 'uncertain'].includes(caption.accuracy.state)) lane.reviewedCount++;
        if (config.contextMemoryEnabled && !lane.pipeline) lane.memory.finalize({ id: `${lane.id}-${caption.sequence}`, speakerId: 'recording', speakerName: 'Recording', text: caption.originalText });
        if (!lane.pendingFinals.size) lane.finalWaiters.splice(0).forEach((done) => done());
      }
      lane.firstCaptionMs ??= elapsed();
      captionTrace('audio_benchmark_caption', { lane: lane.id, caption: caption.sequence, status: caption.status ?? 'final',
        accuracyState: caption.accuracy?.state, revision: caption.revision ?? 0, originalText: caption.originalText,
        ko: caption.translations.ko, ru: caption.translations.ru, kk: caption.translations.kk, en: caption.translations.en,
        sourceIds: caption.sourceSegmentIds ?? [],
        playbackMs: elapsed(), initialCreatedAtMs: caption.createdAt });
    };
    const translate = async (lane: SourceLane, text: string, flush: boolean, sourceFinalAtMs: number, sourceId?: string) => {
      if (lane.failed || controller.signal.aborted) return;
      if (text.trim() && sourceId) lane.spans.push({ id: sourceId, text: (lane.spans.length ? ' ' : '') + text.trim(), receivedAtMs: sourceFinalAtMs });
      const target = lane.spans.map((span) => span.text).join('').trim();
      if (!target.trim()) return;
      const forced = flush || elapsed() - (lane.spans[0]?.receivedAtMs ?? elapsed()) >= config.captionMaxHoldMs;
      const snapshot = () => config.contextMemoryEnabled ? lane.memory.snapshot() : { recent: [], summary: '' };
      const conversation = snapshot();
      const context = conversation.recent.slice(-2).map((segment) => segment.text);
      const signal = AbortSignal.any([controller.signal, lane.controller.signal]);
      const release = (part: InterpretedPart) => {
        if (lane.failed || controller.signal.aborted) return;
        lane.captionCount++;
        const sourceSegmentIds = consumeBenchmarkSource(lane.spans, part.originalText);
        const caption: Caption = { type: 'caption', sequence: lane.captionCount, segmentId: sourceSegmentIds[0]!, sourceSegmentIds,
          speakerId: 'recording', speakerName: 'Recording', originalText: part.originalText,
          translations: part.translations, createdAt: elapsed(), boundary: flush ? 'silence' : forced ? 'timeout' : 'semantic' };
        if (lane.accuracy) lane.accuracy.publish(caption); else deliverCaption(lane, { ...caption, status: 'final', revision: 0 });
      };
      if (config.captionMode === 'separate') {
        let decision = { completed: [target], pending: '' };
        if (!forced) {
          const input = { text: target, context, signal };
          const reservation = usage!.reserve(lane.segmenter.estimateUsage(input), {
            inputPerMillionUsd: config.segmentationInputPerMillionUsd, outputPerMillionUsd: config.segmentationOutputPerMillionUsd,
          });
          const at = elapsed();
          const result = await lane.segmenter.segment(input);
          reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
          diagnostic('audio_benchmark_segmentation_ready', { lane: lane.id, requestLatencyMs: elapsed() - at });
          decision = result;
        }
        lane.pendingText = decision.pending;
        for (const originalText of decision.completed) {
          if (lane.failed || controller.signal.aborted) return;
          const conversation = snapshot();
          const input = { originalText, context: conversation.recent.slice(-2).map((segment) => segment.text), conversation, signal };
          const reservation = usage!.reserve(lane.translator.estimateUsage(input));
          const at = elapsed();
          const result = await lane.translator.translate(input);
          reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
          diagnostic('audio_benchmark_translation_ready', { lane: lane.id, requestLatencyMs: elapsed() - at, triggeringSourceFinalAtMs: sourceFinalAtMs, targetRequests: 4 });
          release({ originalText, translations: result.translations });
        }
      } else {
        const input = { text: target, context, conversation, flush: forced, signal };
        const reservation = usage!.reserve(lane.interpreter.estimateUsage(input));
        const at = elapsed();
        const result = await lane.interpreter.interpret(input);
        reservation.settle({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        if (lane.failed || controller.signal.aborted) return;
        lane.pendingText = result.pending;
        diagnostic('audio_benchmark_translation_ready', { lane: lane.id, requestLatencyMs: elapsed() - at, triggeringSourceFinalAtMs: sourceFinalAtMs, targetRequests: 1 });
        for (const part of result.completed) release(part);
      }
      if (lane.spans.map((span) => span.text).join('').trim() !== lane.pendingText.trim()) throw new AudioBenchmarkError('benchmark_provenance', '보류 자막과 원음 구간의 연결을 확인할 수 없습니다.');
    };
    {
      const delay = config.sttDelay;
      const memory = new ConversationMemory({ summarizer: new OpenAISummarizer({ apiKey: config.apiKey, model: config.translationModel }),
        usage, onDiagnostic: (event, fields) => diagnostic(event, { lane: delay, ...fields }),
        onError: globalError });
      const lane: SourceLane = { id: delay, memory, controller: new AbortController(), active: false, failed: false, complete: false,
        stt: new RealtimeTranscriber({ apiKey: config.apiKey, model: config.sttModel, delay,
          prompt: config.sttPrompt || hints.prompt, keywords: hints.keywords, languages: config.sttLanguages }),
        interpreter: new OpenAIInterpreter({ apiKey: config.apiKey, model: config.translationModel, targetLanguages: config.targetLanguages,
          participantNames: config.participantNames, glossary: config.glossary }),
        segmenter: new OpenAISegmenter({ apiKey: config.apiKey, model: config.segmentationModel }),
        translator: new OpenAIParallelTranslator({ apiKey: config.apiKey, model: config.translationModel, targetLanguages: config.targetLanguages,
          reasoningEffort: config.translationReasoningEffort,
          participantNames: config.participantNames, glossary: config.glossary }),
        chain: Promise.resolve(), source: new Map(), partials: new Map(), spans: [], pendingText: '', captionCount: 0,
        pendingFinals: new Set(), finalWaiters: [], finalCount: 0, reviewedCount: 0, audioBytes: 0, finalLags: [] };
      if (config.reviewEnabled && config.captionMode !== 'streaming') lane.accuracy = new AccuracySession({
        reviewer: new OpenAIAccuracyReviewer({ apiKey: config.apiKey, model: config.translationModel }),
        retranscriber: new OpenAIAudioRetranscriber({ apiKey: config.apiKey }), glossary: config.glossary, usage,
        getConversation: () => config.contextMemoryEnabled ? lane.memory.snapshot() : { recent: [], summary: '' }, now: elapsed,
        sttHints: { prompt: config.sttPrompt || hints.prompt, keywords: hints.keywords, languages: config.sttLanguages },
        onCaption: (caption) => deliverCaption(lane, caption), onDiagnostic: (event, fields) => diagnostic(event, { lane: delay, ...fields }),
        onFatal: (error) => failSource(lane, error),
      });
      if (config.captionMode !== 'streaming') lane.stt.setPartialHandler((event) => {
        if (event.commitIndex) lane.partials.set(event.commitIndex, event.text);
        lane.firstPartialMs ??= elapsed();
        diagnostic('audio_benchmark_partial', { lane: delay, commitIndex: event.commitIndex ?? 0, text: event.text, playbackMs: elapsed() });
      });
      sources.push(lane);
    }
    let playbackMs = 0;
    if (config.captionMode === 'streaming') for (const lane of sources) {
      const sourceEnds = new Map<string, number>();
      lane.pipeline = new LiveTranslationPipeline({ segmentMs: config.segmentMs, streamingCaptions: true,
        draftIntervalMs: config.draftIntervalMs, speechSilenceMs: config.speechSilenceMs,
        segmenter: lane.segmenter, translator: lane.translator,
        segmentationRates: { inputPerMillionUsd: config.segmentationInputPerMillionUsd, outputPerMillionUsd: config.segmentationOutputPerMillionUsd },
        createTranscriber: () => lane.stt, speakerName: () => 'Recording',
        usage: { reserve: (maximum, rates) => maximum.audioMs ? { settle: () => {} } : usage!.reserve(maximum, rates), snapshot: () => usage!.snapshot() },
        ...(config.contextMemoryEnabled ? { memory: lane.memory } : {}),
        ...(config.reviewEnabled ? { accuracy: {
          reviewer: new OpenAIAccuracyReviewer({ apiKey: config.apiKey, model: config.translationModel }),
          retranscriber: new OpenAIAudioRetranscriber({ apiKey: config.apiKey }), glossary: config.glossary, usage: usage!,
          sttHints: { prompt: config.sttPrompt, keywords: hints.keywords, languages: config.sttLanguages },
          onDiagnostic: (event, fields) => diagnostic(event, { lane: lane.id, ...fields }),
        } } : {}),
        onSourceAudio: (id, _speaker, frame) => { sourceEnds.set(id, playbackMs); lane.audioBytes += frame.length; },
        onSourceTranscript: (id, _speaker, text) => {
          const finalAt = elapsed(), sourceEnd = sourceEnds.get(id) ?? playbackMs;
          lane.firstFinalMs ??= finalAt; lane.finalLags.push(finalAt - sourceEnd);
          lane.source.set(Number(id.split('_').at(-1)), text);
          diagnostic('audio_benchmark_source', { lane: lane.id, originalText: text, playbackMs: finalAt, sourceEndMs: sourceEnd, finalLagMs: finalAt - sourceEnd });
        },
        onCaption: (caption) => deliverCaption(lane, caption),
        onDiagnostic: (event, fields) => {
          diagnostic(event, { lane: lane.id, ...fields });
          if (event === 'pipeline_error' && typeof fields?.code === 'string') failSource(lane, new AudioBenchmarkError(fields.code, 'Streaming lane failed.'));
        },
        onTrace: (event, fields) => {
          if (event === 'live_transcript' && fields.final === false) lane.firstPartialMs ??= elapsed();
          diagnostic('audio_benchmark_live_trace', { lane: lane.id, details: JSON.stringify({ event, ...fields }) });
        },
        onFatal: (failure) => failSource(lane, new AudioBenchmarkError(failure, 'Streaming lane stopped.')),
      });
    }
    if (args.direct) for (const language of config.targetLanguages) {
      const lane: DirectLane = { id: `direct-${language}`, active: false, failed: false, complete: false, audioBytes: 0,
        translator: new RealtimeDirectTranslator({ apiKey: config.apiKey, targetLanguage: language, onTextDelta: (event) => {
          lane.firstTextMs ??= elapsed();
          diagnostic('audio_benchmark_direct_delta', { lane: lane.id, delta: event.delta, playbackMs: elapsed(), sourceAlignmentMs: event.elapsedMs });
        } }) };
      direct.push(lane);
    }
    // Reserve every lane before opening any paid audio stream. No per-frame disk writes are needed.
    try {
      for (const lane of sources) lane.audioReservation = usage.reserve({ audioMs }, { sttPerMinuteUsd: config.sttPerMinuteUsd });
      for (const lane of direct) lane.audioReservation = usage.reserve({ audioMs }, { sttPerMinuteUsd: 0.034 });
    } catch (error) {
      for (const lane of [...sources, ...direct]) lane.audioReservation?.settle({ audioMs: 0 });
      throw error;
    }
    await Promise.all([
      ...sources.map(async (lane) => { try { await lane.stt.connect(); lane.active = true; } catch (error) {
        lane.audioReservation?.settle({ audioMs: 0 }); failSource(lane, error);
      } }),
      ...direct.map(async (lane) => { try { await lane.translator.connect(); lane.active = true; } catch (error) {
        lane.audioReservation?.settle({ audioMs: 0 }); lane.failed = true;
        diagnostic('audio_benchmark_lane_failed', { lane: lane.id, code: code(error) }); globalError(error);
      } }),
    ]);
    if (!sources.some((lane) => lane.active) && !direct.some((lane) => lane.active)) throw new AudioBenchmarkError('benchmark_no_lanes', '사용 가능한 비교 연결이 없습니다. 실행 로그를 확인하세요.');
    started = performance.now();
    await replayBenchmarkAudio(pcm, (frame) => {
      playbackMs = frame.endMs;
      if (!sources.some((lane) => lane.active) && !direct.some((lane) => lane.active)) {
        throw new AudioBenchmarkError('benchmark_no_lanes', '모든 비교 연결이 종료되었습니다. 실행 로그를 확인하세요.');
      }
      for (const lane of sources) if (lane.active) {
        try {
          if (lane.pipeline) { lane.pipeline.push('recording', frame.pcm); continue; }
          lane.stt.append(frame.pcm); lane.audioBytes += frame.pcm.length;
          const sourceId = `${lane.id}-source-${frame.turnIndex}`;
          lane.accuracy?.audio(sourceId, 'recording', frame.pcm);
          if (frame.commit) {
            const result = lane.stt.commit().then((text) => {
              const finalAt = elapsed(); lane.firstFinalMs ??= finalAt; lane.finalLags.push(finalAt - frame.endMs);
              lane.source.set(frame.turnIndex, text);
              const partial = lane.partials.get(frame.turnIndex)?.trim();
              lane.accuracy?.transcript(sourceId, 'recording', text, !!partial && !text.trim().startsWith(partial));
              lane.partials.delete(frame.turnIndex);
              diagnostic('audio_benchmark_source', { lane: lane.id, turn: frame.turnIndex, originalText: text,
                playbackMs: finalAt, sourceEndMs: frame.endMs, finalLagMs: finalAt - frame.endMs });
              return { text, finalAt };
            });
            void result.catch((error: unknown) => failSource(lane, error));
            lane.chain = lane.chain.then(async () => { const value = await result; await translate(lane, value.text, false, value.finalAt, sourceId); })
              .catch((error: unknown) => failSource(lane, error));
          }
        } catch (error) { failSource(lane, error); }
      }
      for (const lane of direct) if (lane.active) {
        try { lane.translator.append(frame.pcm); lane.audioBytes += frame.pcm.length; }
        catch (error) { lane.active = false; lane.failed = true; lane.translator.close();
          diagnostic('audio_benchmark_lane_failed', { lane: lane.id, code: code(error) }); globalError(error); }
      }
    }, { signal: controller.signal });
    drainTimer = setTimeout(() => {
      for (const lane of sources) if (!lane.failed && !lane.complete) failSource(lane, new AudioBenchmarkError('benchmark_drain_timeout', '마지막 번역 대기 시간이 초과되었습니다.'));
      for (const lane of direct) if (!lane.failed && !lane.complete) {
        lane.failed = true; diagnostic('audio_benchmark_lane_failed', { lane: lane.id, code: 'benchmark_drain_timeout' });
      }
      stop();
    }, 60_000);
    await Promise.all([
      ...sources.map(async (lane) => {
        await lane.chain;
        if (lane.failed || controller.signal.aborted) return;
        try {
          if (lane.pipeline) {
            lane.pipeline.finishInput('recording');
            while (!lane.pipeline.isSettled() && !lane.failed && !controller.signal.aborted) await new Promise<void>((done) => setTimeout(done, 50));
          } else await translate(lane, '', true, elapsed());
          if (lane.pendingFinals.size) await new Promise<void>((done) => lane.finalWaiters.push(done));
          if (lane.failed || controller.signal.aborted) return;
          lane.audioReservation!.settle({ audioMs: lane.audioBytes / 48 });
          const text = [...lane.source.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join(' ');
          if (reference !== undefined) {
            try { diagnostic('audio_benchmark_transcription_score', { lane: lane.id, ...transcriptionErrorRates(reference, text) }); }
            catch (error) { diagnostic('audio_benchmark_score_unavailable', { lane: lane.id, code: code(error) }); }
          }
          lane.complete = true;
          diagnostic('audio_benchmark_lane_summary', { lane: lane.id, status: 'complete', transcript: text,
            captions: lane.captionCount, finalCaptions: lane.finalCount, reviewedCaptions: lane.reviewedCount,
            firstPartialMs: lane.firstPartialMs, firstFinalMs: lane.firstFinalMs,
            firstCaptionMs: lane.firstCaptionMs, meanFinalLagMs: lane.finalLags.length ? lane.finalLags.reduce((sum, value) => sum + value, 0) / lane.finalLags.length : 0 });
        } catch (error) { failSource(lane, error); }
      }),
      ...direct.map(async (lane) => {
        if (!lane.active || controller.signal.aborted) return;
        try {
          const text = await lane.translator.finish();
          lane.audioReservation!.settle({ audioMs: lane.audioBytes / 48 });
          lane.complete = true;
          diagnostic('audio_benchmark_lane_summary', { lane: lane.id, status: 'complete', translatedText: text, firstTextMs: lane.firstTextMs });
        } catch (error) { lane.failed = true; diagnostic('audio_benchmark_lane_failed', { lane: lane.id, code: code(error) }); globalError(error); }
      }),
    ]);
    clearTimeout(drainTimer); drainTimer = undefined;
    for (const lane of [...sources, ...direct]) if (!lane.complete && !lane.failed) {
      diagnostic('audio_benchmark_lane_summary', { lane: lane.id, status: 'aborted' });
    }
    const failures = sources.filter((lane) => lane.failed).length + direct.filter((lane) => lane.failed).length;
    diagnostic('audio_benchmark_finished', { failures, aborted: controller.signal.aborted,
      estimatedUsd: usage.snapshot().estimatedUsd - before, totalLanes: sources.length + direct.length });
    process.exitCode = failures || controller.signal.aborted ? 1 : 0;
  }
} catch (error) {
  diagnostic('audio_benchmark_failed', { code: code(error) });
  console.error(error instanceof AudioBenchmarkError || error instanceof ConfigError ? error.message : '녹음 비교를 완료하지 못했습니다. 설정·월 사용량 한도·실행 로그를 확인하세요.');
  process.exitCode = 1;
} finally {
  clearTimeout(drainTimer);
  stop();
  await Promise.allSettled(sources.map((lane) => lane.chain));
  pcm?.fill(0);
  for (const lane of [...sources, ...direct]) if (lane.audioBytes === 0) {
    try { lane.audioReservation?.settle({ audioMs: 0 }); } catch { /* A failed ledger must never be rewritten during cleanup. */ }
  }
  usage?.close();
  closeRunLog();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
