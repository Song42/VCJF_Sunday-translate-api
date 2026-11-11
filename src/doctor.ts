import { assertRuntime, ConfigError, loadEnvironment, readConfig } from './config.js';
import { COMPARISON_PRESETS } from './model-comparison.js';
import { INTERPRETATION_REASONING_EFFORT } from './interpret.js';

// No Discord login, HTTP calls, microphone access, or user audio in this command.
let failed = false;
try {
  assertRuntime();
  console.log(`PASS Node.js ${process.versions.node}`);
} catch (error) {
  failed = true;
  console.error(error instanceof ConfigError ? error.message : 'FAIL runtime');
}
try {
  // Native Opus is CommonJS; use default interop in both tsx and emitted ESM.
  const { default: opus } = await import('@discordjs/opus');
  const encoder = new opus.OpusEncoder(48_000, 2);
  const decoder = new opus.OpusEncoder(24_000, 1);
  const input = Buffer.alloc(960 * 2 * 2);
  for (let i = 0; i < 960; i += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / 48_000) * 10_000);
    input.writeInt16LE(sample, i * 4);
    input.writeInt16LE(sample, i * 4 + 2);
  }
  const packet = encoder.encode(input);
  const output = decoder.decode(packet);
  const valid = output.length === 960 && output.some((byte) => byte !== 0);
  input.fill(0);
  packet.fill(0);
  output.fill(0);
  if (!valid) throw new Error('PCM format mismatch');
  console.log('PASS native Opus: stereo 48 kHz → PCM s16le mono 24 kHz (20 ms)');
  const { generateDependencyReport } = await import('@discordjs/voice');
  console.log(generateDependencyReport());
} catch {
  failed = true;
  console.error('FAIL native Opus/voice: Node 버전과 npm ci 결과를 확인하세요.');
}
if (!process.argv.includes('--audio-only')) {
  try {
    loadEnvironment();
    const config = readConfig();
    console.log('PASS required Discord configuration is present (values hidden)');
    console.log(config.recording
      ? `LOCAL AUDIO RECORDING: ${config.recording.scope}; ${config.translation?.captionMode === 'streaming' ? 'continuous source WAV + caption JSON/JSONL; source-turn ranges, no guessed word cuts' : 'WAV in recordings/; legacy translation-unit or probe splitting'}`
      : 'LOCAL AUDIO RECORDING: disabled');
    console.log(config.consentConfirmed
      ? 'PASS participant consent confirmation is enabled'
      : 'WAIT participant consent: /start remains disabled until explicitly confirmed');
    if (config.translation) {
      console.log('PASS translation settings and OpenAI key are present (key hidden; API access not checked)');
      console.log(`API monthly estimate limit: $${config.translation.monthlyLimitUsd}`);
      console.log(`STT context hints: ${config.translation.sttLanguages.length} languages, ${config.translation.sttKeywords.length} terms`);
      console.log(`Participant name glossary: ${config.translation.participantNames.length} entries from config/participants.json (STT and translation)`);
      console.log(`Christian/custom glossary: ${config.translation.glossary.length} entries; STT delay: ${config.translation.sttDelay}`);
      console.log(`Accuracy review: ${config.translation.reviewEnabled}; shared conversation memory: ${config.translation.contextMemoryEnabled}`);
      console.log(`STT audio segment maximum: ${config.translation.segmentMs / 1000}s (separate from caption hold)`);
      console.log(config.translation.captionMode === 'compare'
        ? `Caption mode: compare; shared STT -> ${COMPARISON_PRESETS.map((item) => item.variantId).join(', ')}`
        : config.translation.captionMode === 'streaming'
        ? `Caption mode: streaming; partial STT -> ${config.translation.targetLanguages.length} parallel ${config.translation.translationModel} drafts -> background semantic commitment -> selective final review`
        : config.translation.captionMode === 'combined'
        ? `Caption mode: combined; ${config.translation.translationModel}, reasoning ${INTERPRETATION_REASONING_EFFORT} (boundaries + ${config.translation.targetLanguages.length} translations in one request)`
        : `Caption mode: separate; shared ${config.translation.segmentationModel} boundaries -> ${config.translation.targetLanguages.length} parallel ${config.translation.translationModel} translations, reasoning low`);
      console.log(`Output languages: ${config.translation.targetLanguages.join(', ')}`);
      console.log(config.translation.captionMode === 'streaming'
        ? `Live drafts: every >=${config.translation.draftIntervalMs / 1000}s; source speech silence ${config.translation.speechSilenceMs / 1000}s; STT checkpoints do not finalize sentences`
        : `Caption deadlines: silence ${config.translation.captionSilenceMs / 1000}s, maximum hold ${config.translation.captionMaxHoldMs / 1000}s (API processing time is additional)`);
      console.log(`STT idle timeout: ${config.translation.idleSessionMs / 1000}s; all requests share the monthly budget`);
      console.log(config.translation.openaiConsentConfirmed
        ? 'PASS OpenAI audio transfer consent confirmation is enabled'
        : 'WAIT OpenAI audio transfer consent: translation /start remains disabled');
      console.log(config.translation.localPreview
        ? 'LOCAL PREVIEW: original text in the bot terminal; full captions and diagnostics in logs/<local-date-time>.log'
        : 'PRIVATE: bot logs contain diagnostics only; caption text is neither printed nor saved');
      console.log('Run npm run api:check to check model visibility without sending audio or requesting a translation.');
    } else {
      console.log('VOICE PROBE ONLY: TRANSLATION_ENABLED=false. See README for Phase 2 settings.');
    }
  } catch (error) {
    failed = true;
    console.error(error instanceof ConfigError ? error.message : 'FAIL configuration');
  }
}
console.log('실제 Discord A/B 수신 검증은 아직 별도로 수행해야 합니다.');
process.exitCode = failed ? 1 : 0;
