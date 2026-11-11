import { DEFAULT_TARGET_LANGUAGES, targetLanguages, type TargetLanguage } from './languages.js';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { loadParticipantNames, ParticipantNamesError, type ParticipantName } from './participants.js';
import { BUILT_IN_GLOSSARY, CHRISTIAN_DISCUSSION_PROMPT, loadCustomGlossary, mergeGlossaries,
  participantNamesToGlossary, GlossaryError, type GlossaryEntry } from './glossary.js';
import type { TranscriptionDelay } from './stt.js';
import type { TranslationReasoningEffort } from './parallel-translate.js';
import { readReceiverConfig, type ReceiverConfig } from './receiver-publisher.js';

export interface Config {
  botToken: string;
  clientId: string;
  guildId: string;
  voiceChannelId: string;
  adminUserId: string;
  consentConfirmed: boolean;
  silenceMs: number;
  recording?: { scope: 'admin' | 'all' };
  translation?: TranslationConfig;
  receiver?: ReceiverConfig;
}

export interface TranslationConfig {
  apiKey: string;
  sttModel: string;
  sttDelay: TranscriptionDelay;
  glossary: readonly GlossaryEntry[];
  reviewEnabled: boolean;
  contextMemoryEnabled: boolean;
  sttLanguages: string[];
  sttPrompt: string;
  sttKeywords: string[];
  participantNames: readonly ParticipantName[];
  translationModel: string;
  translationReasoningEffort: TranslationReasoningEffort;
  targetLanguages: TargetLanguage[];
  captionMode: 'streaming' | 'combined' | 'separate' | 'compare';
  draftIntervalMs: number;
  speechSilenceMs: number;
  segmentationModel: string;
  openaiConsentConfirmed: boolean;
  localPreview: boolean;
  segmentMs: number;
  captionSilenceMs: number;
  captionMaxHoldMs: number;
  idleSessionMs: number;
  monthlyLimitUsd: number;
  sttPerMinuteUsd: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  segmentationInputPerMillionUsd: number;
  segmentationOutputPerMillionUsd: number;
}

function booleanSetting(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const value = env[key] ?? String(fallback);
  if (value !== 'true' && value !== 'false') throw new ConfigError(`${key}는 true 또는 false여야 합니다.`);
  return value === 'true';
}

function positiveSetting(env: NodeJS.ProcessEnv, key: string, fallback?: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${key}에 양수를 입력하세요.`);
  return value;
}

export function readTranslationConfig(env: NodeJS.ProcessEnv = process.env): TranslationConfig | undefined {
  if (!booleanSetting(env, 'TRANSLATION_ENABLED')) return undefined;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new ConfigError('번역 모드에는 .env의 OPENAI_API_KEY가 필요합니다. 키를 채팅에 보내지 마세요.');
  const sttModel = env.STT_MODEL?.trim() || 'gpt-live-transcribe';
  const sttDelay = env.STT_DELAY?.trim() || 'low';
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(sttDelay)) {
    throw new ConfigError('STT_DELAY는 minimal, low, medium, high, xhigh 중 하나여야 합니다.');
  }
  const sttLanguages = (env.STT_LANGUAGES ?? 'ko,ru,kk,en').split(',').map((item) => item.trim()).filter(Boolean);
  if (sttLanguages.length > 8 || new Set(sttLanguages).size !== sttLanguages.length ||
      sttLanguages.some((item) => !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(item))) {
    throw new ConfigError('STT_LANGUAGES에는 쉼표로 구분된 언어 코드를 입력하세요. 비우면 언어 힌트를 보내지 않습니다.');
  }
  const sttPrompt = (env.STT_PROMPT ?? CHRISTIAN_DISCUSSION_PROMPT).trim();
  const sttKeywords = (env.STT_KEYWORDS ?? '')
    .split(',').map((word) => word.trim()).filter(Boolean);
  if (sttPrompt.length > 1000 || sttKeywords.length > 50 ||
      sttKeywords.some((word) => word.length > 80 || /[<>\r\n]/.test(word))) {
    throw new ConfigError('STT_PROMPT는 1000자 이하, STT_KEYWORDS는 항목당 80자 이하의 용어 최대 50개여야 합니다. 용어에는 줄바꿈이나 꺾쇠를 넣지 마세요.');
  }
  let outputLanguages: TargetLanguage[];
  try { outputLanguages = targetLanguages((env.TRANSLATION_LANGUAGES ?? DEFAULT_TARGET_LANGUAGES.join(',')).split(',').map(item => item.trim())); }
  catch (error) { throw new ConfigError(error instanceof Error ? error.message : 'Invalid TRANSLATION_LANGUAGES'); }
  const translationModel = env.TRANSLATION_MODEL?.trim() || 'gpt-6-luna';
  const translationReasoningEffort = env.TRANSLATION_REASONING_EFFORT?.trim() ?? 'medium';
  if (!['none', 'low', 'medium', 'high'].includes(translationReasoningEffort)) {
    throw new ConfigError('TRANSLATION_REASONING_EFFORT는 none, low, medium, high 중 하나여야 합니다.');
  }
  let participantNames: readonly ParticipantName[];
  let glossary: readonly GlossaryEntry[];
  try {
    participantNames = loadParticipantNames();
    // The registered glossary may exceed one STT request's vocabulary capacity.
    // buildTranscriptionHints bounds the outgoing hints; translation selects from the full catalog.
    glossary = mergeGlossaries({ builtIn: BUILT_IN_GLOSSARY,
      custom: [...participantNamesToGlossary(participantNames), ...loadCustomGlossary()] });
  } catch (error) {
    if (error instanceof ParticipantNamesError || error instanceof GlossaryError) throw new ConfigError(error.message);
    throw error;
  }
  const captionMode = env.CAPTION_MODE?.trim() ?? 'streaming';
  if (!['streaming', 'combined', 'separate', 'compare'].includes(captionMode)) {
    throw new ConfigError('CAPTION_MODE는 streaming, combined, separate 또는 compare여야 합니다.');
  }
  const segmentationModel = env.SEGMENTATION_MODEL?.trim() || 'gpt-6.1-terra';
  const localPreview = booleanSetting(env, 'LOCAL_CAPTION_PREVIEW');
  if (localPreview && env.NODE_ENV === 'production') {
    throw new ConfigError('배포 환경에서는 LOCAL_CAPTION_PREVIEW를 켤 수 없습니다.');
  }
  const segmentMs = positiveSetting(env, 'AUDIO_SEGMENT_MS', 5_000);
  if (!Number.isInteger(segmentMs) || segmentMs < 3_000 || segmentMs > 12_000) {
    throw new ConfigError('AUDIO_SEGMENT_MS는 3000~12000 사이의 정수여야 합니다.');
  }
  const captionSilenceMs = positiveSetting(env, 'CAPTION_SILENCE_MS', 4_000);
  const captionMaxHoldMs = positiveSetting(env, 'CAPTION_MAX_HOLD_MS', 8_000);
  const idleSessionMs = positiveSetting(env, 'STT_IDLE_TIMEOUT_MS', 60_000);
  const draftIntervalMs = positiveSetting(env, 'DRAFT_INTERVAL_MS', 1_000);
  const speechSilenceMs = positiveSetting(env, 'SPEECH_SILENCE_MS', 2_000);
  if (!Number.isSafeInteger(draftIntervalMs) || draftIntervalMs < 500 || draftIntervalMs > 5_000
    || !Number.isSafeInteger(speechSilenceMs) || speechSilenceMs < 500 || speechSilenceMs > 10_000) {
    throw new ConfigError('DRAFT_INTERVAL_MS는 500~5000, SPEECH_SILENCE_MS는 500~10000의 정수여야 합니다.');
  }
  if (!Number.isInteger(captionSilenceMs) || captionSilenceMs < 1000 || captionSilenceMs > 30_000) {
    throw new ConfigError('CAPTION_SILENCE_MS는 1000~30000 사이의 정수여야 합니다.');
  }
  if (!Number.isInteger(captionMaxHoldMs) || captionMaxHoldMs < captionSilenceMs || captionMaxHoldMs > 60_000) {
    throw new ConfigError('CAPTION_MAX_HOLD_MS는 CAPTION_SILENCE_MS 이상, 60000 이하의 정수여야 합니다.');
  }
  if (!Number.isInteger(idleSessionMs) || idleSessionMs < 10_000 || idleSessionMs > 300_000) {
    throw new ConfigError('STT_IDLE_TIMEOUT_MS는 10000~300000 사이의 정수여야 합니다.');
  }
  return {
    apiKey, sttModel, sttLanguages, sttPrompt, sttKeywords, participantNames, translationModel, localPreview, segmentMs,
    sttDelay: sttDelay as TranscriptionDelay, glossary, targetLanguages: outputLanguages,
    translationReasoningEffort: translationReasoningEffort as TranslationReasoningEffort,
    draftIntervalMs, speechSilenceMs,
    reviewEnabled: booleanSetting(env, 'ACCURACY_REVIEW_ENABLED', true),
    contextMemoryEnabled: booleanSetting(env, 'CONTEXT_MEMORY_ENABLED', true),
    captionMode: captionMode as TranslationConfig['captionMode'], segmentationModel, captionSilenceMs, captionMaxHoldMs, idleSessionMs,
    openaiConsentConfirmed: booleanSetting(env, 'OPENAI_AUDIO_CONSENT_CONFIRMED'),
    // Keep hosting headroom within the spec's lower $30 total budget until resolved.
    monthlyLimitUsd: positiveSetting(env, 'API_MONTHLY_LIMIT_USD', 10),
    sttPerMinuteUsd: positiveSetting(env, 'STT_USD_PER_MINUTE',
      sttModel === 'gpt-transcribe' ? 0.0045 : sttModel === 'gpt-live-transcribe' ? 0.017 : undefined),
    inputPerMillionUsd: positiveSetting(env, 'TRANSLATION_INPUT_USD_PER_MILLION', translationModel === 'gpt-6-luna' ? 0.1 : undefined),
    outputPerMillionUsd: positiveSetting(env, 'TRANSLATION_OUTPUT_USD_PER_MILLION', translationModel === 'gpt-6-luna' ? 0.5 : undefined),
    segmentationInputPerMillionUsd: positiveSetting(env, 'SEGMENTATION_INPUT_USD_PER_MILLION',
      segmentationModel === 'gpt-6.1-terra' ? 1 : segmentationModel === 'gpt-6-luna' ? 0.1 : undefined),
    segmentationOutputPerMillionUsd: positiveSetting(env, 'SEGMENTATION_OUTPUT_USD_PER_MILLION',
      segmentationModel === 'gpt-6.1-terra' ? 5 : segmentationModel === 'gpt-6-luna' ? 0.5 : undefined),
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function assertRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 17)) {
    throw new ConfigError('Node.js 24.17.0 이상이 필요합니다. README의 런타임 설정을 확인하세요.');
  }
}

export function loadEnvironment(): void {
  if (existsSync('.env')) {
    try {
      loadEnvFile('.env');
    } catch {
      throw new ConfigError('.env 파일을 읽을 수 없습니다. 권한과 UTF-8 인코딩을 확인하세요.');
    }
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID',
    'DISCORD_VOICE_CHANNEL_ID', 'ADMIN_DISCORD_USER_ID'] as const;
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new ConfigError(`.env에 필요한 설정이 없습니다: ${missing.join(', ')}`);
  for (const key of required.slice(1)) {
    if (!/^\d{17,20}$/.test(env[key]!.trim())) {
      throw new ConfigError(`${key}에는 Discord의 숫자 ID를 입력하세요.`);
    }
  }
  const silenceMs = Number(env.AUDIO_SILENCE_MS ?? 850);
  if (!Number.isInteger(silenceMs) || silenceMs < 700 || silenceMs > 1000) {
    throw new ConfigError('AUDIO_SILENCE_MS는 700~1000 사이의 정수여야 합니다.');
  }
  const consent = env.VOICE_CAPTURE_CONSENT_CONFIRMED ?? 'false';
  if (consent !== 'true' && consent !== 'false') {
    throw new ConfigError('VOICE_CAPTURE_CONSENT_CONFIRMED는 true 또는 false여야 합니다.');
  }
  const translation = readTranslationConfig(env);
  let receiver: ReceiverConfig | undefined;
  try { receiver = readReceiverConfig(env); }
  catch (error) { throw new ConfigError(error instanceof Error ? error.message : 'Invalid receiver configuration'); }
  const recordingEnabled = booleanSetting(env, 'AUDIO_RECORDING_ENABLED');
  const recordingScope = env.AUDIO_RECORDING_SCOPE?.trim() || 'admin';
  if (!['admin', 'all'].includes(recordingScope)) throw new ConfigError('AUDIO_RECORDING_SCOPE는 admin 또는 all이어야 합니다.');
  return {
    botToken: env.DISCORD_BOT_TOKEN!.trim(),
    clientId: env.DISCORD_CLIENT_ID!.trim(),
    guildId: env.DISCORD_GUILD_ID!.trim(),
    voiceChannelId: env.DISCORD_VOICE_CHANNEL_ID!.trim(),
    adminUserId: env.ADMIN_DISCORD_USER_ID!.trim(),
    consentConfirmed: consent === 'true',
    silenceMs,
    ...(recordingEnabled ? { recording: { scope: recordingScope as 'admin' | 'all' } } : {}),
    ...(translation ? { translation } : {}),
    ...(receiver ? { receiver } : {}),
  };
}

export function canControlMeeting(config: Pick<Config, 'guildId' | 'adminUserId'>,
  guildId: string | null, userId: string): boolean {
  return guildId === config.guildId && userId === config.adminUserId;
}
