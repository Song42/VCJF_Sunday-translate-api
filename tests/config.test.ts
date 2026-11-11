import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRuntime, canControlMeeting, ConfigError, readConfig, readTranslationConfig } from '../src/config.js';

test('output languages default to three and are independent of spoken language hints', () => {
  const enabled = { TRANSLATION_ENABLED: 'true', OPENAI_API_KEY: 'test-key' };
  assert.deepEqual(readTranslationConfig(enabled)!.targetLanguages, ['ko', 'ru', 'kk']);
  const config = readTranslationConfig({ ...enabled, TRANSLATION_LANGUAGES: 'ru, en' })!;
  assert.deepEqual(config.targetLanguages, ['ru', 'en']);
  assert.deepEqual(config.sttLanguages, ['ko', 'ru', 'kk', 'en']);
  for (const value of ['', 'ko,ko', 'ko,', 'ko,unknown', 'KO']) {
    assert.throws(() => readTranslationConfig({ ...enabled, TRANSLATION_LANGUAGES: value }), ConfigError);
  }
});

const env = {
  DISCORD_BOT_TOKEN: 'test-secret-never-log',
  DISCORD_CLIENT_ID: '111111111111111111',
  DISCORD_GUILD_ID: '222222222222222222',
  DISCORD_VOICE_CHANNEL_ID: '333333333333333333',
  ADMIN_DISCORD_USER_ID: '444444444444444444',
};

test('translation reasoning effort defaults to medium and validates explicit environment settings', () => {
  const enabled = { TRANSLATION_ENABLED: 'true', OPENAI_API_KEY: 'test-key' };
  assert.equal(readTranslationConfig(enabled)!.translationReasoningEffort, 'medium');
  for (const effort of ['none', 'low', 'medium', 'high']) {
    assert.equal(readTranslationConfig({ ...enabled, TRANSLATION_REASONING_EFFORT: effort })!.translationReasoningEffort, effort);
  }
  for (const effort of ['', 'light', 'MEDIUM']) {
    assert.throws(() => readTranslationConfig({ ...enabled, TRANSLATION_REASONING_EFFORT: effort }), ConfigError);
  }
});

test('missing or malformed configuration fails without revealing values', () => {
  assert.throws(() => readConfig({}), ConfigError);
  assert.throws(() => readConfig({ ...env, DISCORD_GUILD_ID: 'secret-invalid-value' }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.message.includes('DISCORD_GUILD_ID'));
    assert.ok(!error.message.includes('secret-invalid-value'));
    assert.ok(!error.message.includes(env.DISCORD_BOT_TOKEN));
    return true;
  });
  assert.throws(() => readConfig({ ...env, AUDIO_SILENCE_MS: 'NaN' }), ConfigError);
  assert.throws(() => readConfig({ ...env, AUDIO_SILENCE_MS: '0' }), ConfigError);
  assert.throws(() => readConfig({ ...env, VOICE_CAPTURE_CONSENT_CONFIRMED: 'yes' }), ConfigError);
});

test('capture consent defaults closed and requires explicit confirmation', () => {
  assert.equal(readConfig(env).consentConfirmed, false);
  assert.equal(readConfig({ ...env, VOICE_CAPTURE_CONSENT_CONFIRMED: 'false' }).consentConfirmed, false);
  assert.equal(readConfig({ ...env, VOICE_CAPTURE_CONSENT_CONFIRMED: 'true' }).consentConfirmed, true);
});

test('local recording is optional and defaults to the administrator when explicitly enabled', () => {
  assert.equal(readConfig(env).recording, undefined);
  assert.deepEqual(readConfig({ ...env, AUDIO_RECORDING_ENABLED: 'true' }).recording, { scope: 'admin' });
  assert.deepEqual(readConfig({ ...env, AUDIO_RECORDING_ENABLED: 'true', AUDIO_RECORDING_SCOPE: 'all' }).recording, { scope: 'all' });
  assert.throws(() => readConfig({ ...env, AUDIO_RECORDING_ENABLED: 'yes' }), ConfigError);
  assert.throws(() => readConfig({ ...env, AUDIO_RECORDING_SCOPE: 'unknown' }), ConfigError);
});

test('only the configured administrator in the configured guild controls capture', () => {
  const config = readConfig(env);
  assert.equal(canControlMeeting(config, config.guildId, config.adminUserId), true);
  assert.equal(canControlMeeting(config, config.guildId, '555555555555555555'), false);
  assert.equal(canControlMeeting(config, '555555555555555555', config.adminUserId), false);
  assert.equal(canControlMeeting(config, null, config.adminUserId), false);
});

test('runtime enforces the specification minimum', () => {
  assert.throws(() => assertRuntime('22.15.1'), ConfigError);
  assert.throws(() => assertRuntime('24.16.9'), ConfigError);
  assert.doesNotThrow(() => assertRuntime('24.17.0'));
  assert.doesNotThrow(() => assertRuntime('26.0.0'));
});

test('translation is opt-in, requires a key, and separates OpenAI transfer consent', () => {
  assert.equal(readTranslationConfig({}), undefined);
  assert.throws(() => readTranslationConfig({ TRANSLATION_ENABLED: 'true' }), ConfigError);
  const enabled = { TRANSLATION_ENABLED: 'true', OPENAI_API_KEY: 'test-key' };
  const config = readTranslationConfig(enabled)!;
  assert.equal(config.openaiConsentConfirmed, false);
  assert.equal(config.localPreview, false);
  assert.equal(config.monthlyLimitUsd, 10);
  assert.equal(config.segmentMs, 5_000);
  assert.equal(config.sttModel, 'gpt-live-transcribe');
  assert.equal(config.sttPerMinuteUsd, 0.017);
  assert.equal(config.sttDelay, 'low');
  assert.equal(config.reviewEnabled, true);
  assert.equal(config.contextMemoryEnabled, true);
  assert.ok(config.glossary.length >= 5);
  assert.equal(config.captionMode, 'streaming');
  assert.equal(config.draftIntervalMs, 1_000);
  assert.equal(config.speechSilenceMs, 2_000);
  assert.throws(() => readTranslationConfig({ ...enabled, DRAFT_INTERVAL_MS: '0' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, SPEECH_SILENCE_MS: '10001' }), ConfigError);
  assert.equal(readTranslationConfig({ ...enabled, CAPTION_MODE: 'compare' })!.captionMode, 'compare');
  assert.equal(readTranslationConfig({ ...enabled, CAPTION_MODE: 'separate' })!.captionMode, 'separate');
  assert.throws(() => readTranslationConfig({ ...enabled, CAPTION_MODE: 'unknown-secret' }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes('unknown-secret'));
    return true;
  });
  assert.equal(config.segmentationModel, 'gpt-6.1-terra');
  assert.equal(config.segmentationInputPerMillionUsd, 1);
  assert.equal(config.segmentationOutputPerMillionUsd, 5);
  assert.equal(config.captionSilenceMs, 4_000);
  assert.equal(config.captionMaxHoldMs, 8_000);
  assert.equal(config.idleSessionMs, 60_000);
  assert.ok(config.sttPrompt.includes('Hangul'));
  assert.deepEqual(config.sttKeywords, []);
  assert.deepEqual(readTranslationConfig({ ...enabled, STT_KEYWORDS: ' 하와, 선악과 ' })!.sttKeywords, ['하와', '선악과']);
  assert.deepEqual(config.sttLanguages, ['ko', 'ru', 'kk', 'en']);
  assert.deepEqual(readTranslationConfig({ ...enabled, STT_LANGUAGES: '' })!.sttLanguages, []);
  assert.throws(() => readTranslationConfig({ ...enabled, NODE_ENV: 'production', LOCAL_CAPTION_PREVIEW: 'true' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, API_MONTHLY_LIMIT_USD: 'Infinity' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, AUDIO_SEGMENT_MS: '12001' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, AUDIO_SEGMENT_MS: '2999' }), ConfigError);
  assert.equal(readTranslationConfig({ ...enabled, AUDIO_SEGMENT_MS: '3000' })!.segmentMs, 3_000);
  assert.throws(() => readTranslationConfig({ ...enabled, STT_LANGUAGES: 'ko,ko' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, STT_KEYWORDS: '<word>' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, STT_PROMPT: 'x'.repeat(1001) }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, CAPTION_SILENCE_MS: '30001' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, CAPTION_MAX_HOLD_MS: '3999' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, CAPTION_MAX_HOLD_MS: '60001' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, STT_IDLE_TIMEOUT_MS: '9999' }), ConfigError);
  const emptyHints = readTranslationConfig({ ...enabled, STT_PROMPT: '', STT_KEYWORDS: '' })!;
  assert.equal(emptyHints.sttPrompt, '');
  assert.deepEqual(emptyHints.sttKeywords, []);
  assert.equal(readTranslationConfig({ ...enabled, STT_MODEL: 'gpt-live-transcribe' })!.sttPerMinuteUsd, 0.017);
});

test('changing models requires explicit prices instead of silently applying cheaper defaults', () => {
  const enabled = { TRANSLATION_ENABLED: 'true', OPENAI_API_KEY: 'test-key' };
  assert.throws(() => readTranslationConfig({ ...enabled, STT_MODEL: 'other-stt' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, TRANSLATION_MODEL: 'other-translator' }), ConfigError);
  assert.throws(() => readTranslationConfig({ ...enabled, SEGMENTATION_MODEL: 'other-segmenter' }), ConfigError);
  assert.ok(readTranslationConfig({ ...enabled, STT_MODEL: 'other-stt', STT_USD_PER_MINUTE: '0.02' }));
  const custom = readTranslationConfig({ ...enabled, SEGMENTATION_MODEL: 'other-segmenter',
    SEGMENTATION_INPUT_USD_PER_MILLION: '2', SEGMENTATION_OUTPUT_USD_PER_MILLION: '8' })!;
  assert.equal(custom.segmentationModel, 'other-segmenter');
  assert.equal(custom.segmentationInputPerMillionUsd, 2);
  assert.equal(custom.segmentationOutputPerMillionUsd, 8);
  assert.equal(custom.inputPerMillionUsd, 0.1);
});
