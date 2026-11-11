import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import { VoiceCapture } from './audio.js';
import { LocalAudioRecorder, RecordingError } from './recording.js';
import { CaptionAudioRecorder } from './caption-recording.js';
import { ContinuousCaptionRecorder } from './continuous-recording.js';
import { canControlMeeting, type Config } from './config.js';
import { captionPreview, captionTrace, diagnostic } from './log.js';
import { LiveTranslationPipeline } from './pipeline.js';
import { RealtimeTranscriber } from './stt.js';
import { OpenAITranslator } from './translate.js';
import { OpenAIParallelTranslator } from './parallel-translate.js';
import { OpenAISegmenter } from './segment.js';
import { OpenAIInterpreter, INTERPRETATION_REASONING_EFFORT } from './interpret.js';
import { createComparisonVariants, COMPARISON_PRESETS } from './model-comparison.js';
import { buildTranscriptionHints } from './glossary.js';
import { ConversationMemory, OpenAISummarizer } from './conversation-memory.js';
import { OpenAIAccuracyReviewer } from './accuracy-review.js';
import { OpenAIAudioRetranscriber } from './audio-retranscribe.js';
import { UsageLedger, UsageLimitError, UsageStorageError } from './usage.js';
import { resolve } from 'node:path';
import { ReceiverPublisher } from './receiver-publisher.js';

export class VoiceProbeBot {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  private connection: VoiceConnection | undefined;
  private capture: VoiceCapture | undefined;
  private pipeline: LiveTranslationPipeline | undefined;
  private recorder: LocalAudioRecorder | undefined;
  private captionRecorder: CaptionAudioRecorder | undefined;
  private continuousRecorder: ContinuousCaptionRecorder | undefined;
  private readonly usage: UsageLedger | undefined;
  private readonly receiver: ReceiverPublisher | undefined;
  private generation = 0;
  private starting = false;
  private closing = false;

  constructor(private readonly config: Config) {
    this.receiver = config.receiver ? new ReceiverPublisher({ ...config.receiver, onDiagnostic: diagnostic }) : undefined;
    const translation = config.translation;
    this.usage = translation ? new UsageLedger({
      filePath: resolve('data/usage.json'), limitUsd: translation.monthlyLimitUsd,
      rates: { sttPerMinuteUsd: translation.sttPerMinuteUsd,
        inputPerMillionUsd: translation.inputPerMillionUsd, outputPerMillionUsd: translation.outputPerMillionUsd },
    }) : undefined;
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || !['start', 'stop'].includes(interaction.commandName)) return;
      void this.handleCommand(interaction).catch(() => diagnostic('command_reply_failed'));
    });
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (after.guild.id !== this.config.guildId) return;
      if (after.id === this.client.user?.id && this.connection &&
          (after.channelId !== this.config.voiceChannelId || after.serverDeaf || after.selfDeaf)) {
        this.stopMeeting('bot_moved_or_deafened');
      } else if (before.channelId === this.config.voiceChannelId &&
          after.channelId !== this.config.voiceChannelId) {
        this.capture?.removeSpeaker(after.id);
      }
    });
    // Voice membership cannot be trusted while the gateway is offline.
    this.client.on(Events.ShardDisconnect, () => this.stopMeeting('gateway_disconnected'));
    this.client.on(Events.Error, () => diagnostic('discord_client_error'));
    this.client.on(Events.ShardError, () => diagnostic('discord_gateway_error'));
    this.client.on(Events.ClientReady, () => diagnostic('bot_ready'));
  }

  async login(): Promise<void> {
    await this.client.login(this.config.botToken);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.stopMeeting('process_shutdown');
    try { await Promise.all([this.client.destroy(), this.receiver?.close()]); }
    finally { this.usage?.close(); }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!canControlMeeting(this.config, interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: '지정 서버의 설정된 관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'stop') {
      const active = Boolean(this.starting || this.connection || this.capture);
      this.stopMeeting('admin_stop');
      await interaction.editReply(active ? '모임을 종료하고 음성 수신·번역 요청 및 임시 자막을 정리했습니다. logs 폴더의 실행 로그에서 집계를 확인하세요.' : '진행 중인 모임이 없습니다.');
      return;
    }
    if (this.closing) {
      await interaction.editReply('프로세스 종료 중입니다.');
      return;
    }
    if (!this.config.consentConfirmed) {
      await interaction.editReply('참가자에게 수음 검증을 알리고 모두의 동의를 먼저 확보하세요. 이후 .env의 VOICE_CAPTURE_CONSENT_CONFIRMED=true로 설정하고 봇을 다시 실행하세요.');
      return;
    }
    if (this.config.translation && !this.config.translation.openaiConsentConfirmed) {
      await interaction.editReply('음성이 OpenAI로 전송되어 전사·번역된다는 점을 참가자에게 알리고 동의를 확인하세요. .env의 OPENAI_AUDIO_CONSENT_CONFIRMED=true 설정 후 봇을 다시 실행하세요.');
      return;
    }
    if (this.starting || this.connection) {
      await interaction.editReply('이미 음성 채널에 연결 중이거나 수신 중입니다.');
      return;
    }
    const generation = ++this.generation;
    this.starting = true;
    try {
      const guild = await this.client.guilds.fetch(this.config.guildId);
      const channel = await guild.channels.fetch(this.config.voiceChannelId);
      if (generation !== this.generation) {
        await interaction.editReply('시작 요청이 취소되었습니다.');
        return;
      }
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        this.starting = false;
        await interaction.editReply('DISCORD_VOICE_CHANNEL_ID가 이 서버의 일반 음성 채널인지 확인하세요.');
        return;
      }
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      if (generation !== this.generation) {
        await interaction.editReply('시작 요청이 취소되었습니다.');
        return;
      }
      if (!channel.permissionsFor(botMember).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
        this.starting = false;
        await interaction.editReply('봇에 대상 채널의 View Channel 및 Connect 권한을 허용하세요.');
        return;
      }
      const connection = joinVoiceChannel({
        guildId: guild.id,
        channelId: channel.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      this.connection = connection;
      connection.on('error', () => {
        if (this.connection !== connection) return;
        diagnostic('voice_connection_error');
        this.stopMeeting('voice_error');
      });
      connection.on('stateChange', (_oldState, state) => {
        if (this.connection !== connection) return;
        if (state.status === VoiceConnectionStatus.Ready) {
          this.capture?.start();
        } else if (state.status === VoiceConnectionStatus.Disconnected) {
          diagnostic('voice_disconnected');
          // The library reconnects resumable transports. Stop if it cannot recover.
          void entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch(() => {
            if (this.connection === connection) this.stopMeeting('voice_reconnect_timeout');
          });
        } else if (state.status === VoiceConnectionStatus.Destroyed) {
          this.stopMeeting('voice_destroyed');
        }
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      if (generation !== this.generation || this.connection !== connection) {
        await interaction.editReply('시작 요청이 취소되었습니다.');
        return;
      }
      const translation = this.config.translation;
      if (translation && this.usage) {
        const hints = buildTranscriptionHints(translation.glossary, translation.sttKeywords);
        this.receiver?.startSession(channel.name, translation.targetLanguages);
        const memory = translation.contextMemoryEnabled && translation.captionMode !== 'compare'
          ? new ConversationMemory({ summarizer: new OpenAISummarizer({ apiKey: translation.apiKey, model: translation.translationModel }),
            usage: this.usage, onDiagnostic: diagnostic,
            onError: (error) => {
              if (error instanceof UsageLimitError || error instanceof UsageStorageError) this.stopMeeting('context_budget_or_storage');
            } }) : undefined;
        this.pipeline = new LiveTranslationPipeline({
          segmentMs: translation.segmentMs,
          streamingCaptions: translation.captionMode === 'streaming', draftIntervalMs: translation.draftIntervalMs,
          speechSilenceMs: translation.speechSilenceMs,
          ...(translation.localPreview ? { onTrace: captionTrace } : {}),
          ...(memory ? { memory } : {}),
          ...(translation.reviewEnabled && translation.captionMode !== 'compare' ? { accuracy: {
            reviewer: new OpenAIAccuracyReviewer({ apiKey: translation.apiKey, model: translation.translationModel }),
            retranscriber: new OpenAIAudioRetranscriber({ apiKey: translation.apiKey }),
            glossary: translation.glossary, usage: this.usage,
            sttHints: { prompt: translation.sttPrompt, keywords: hints.keywords, languages: translation.sttLanguages },
            onDiagnostic: diagnostic,
          } } : {}),
          ...(translation.captionMode === 'compare' ? {
            comparisonVariants: createComparisonVariants(translation.apiKey, translation.participantNames, translation.glossary, translation.targetLanguages),
          } : translation.captionMode === 'combined' ? {
            interpreter: new OpenAIInterpreter({ apiKey: translation.apiKey, model: translation.translationModel, targetLanguages: translation.targetLanguages,
              participantNames: translation.participantNames, glossary: translation.glossary }),
          } : {
            segmenter: new OpenAISegmenter({ apiKey: translation.apiKey, model: translation.segmentationModel }),
            segmentationRates: { inputPerMillionUsd: translation.segmentationInputPerMillionUsd,
              outputPerMillionUsd: translation.segmentationOutputPerMillionUsd },
          }),
          captionSilenceMs: translation.captionSilenceMs,
          captionMaxHoldMs: translation.captionMaxHoldMs,
          idleSessionMs: translation.idleSessionMs,
          createTranscriber: () => new RealtimeTranscriber({
            apiKey: translation.apiKey, model: translation.sttModel, languages: translation.sttLanguages,
            prompt: translation.sttPrompt, keywords: hints.keywords, delay: translation.sttDelay,
            onDiagnostic: (event) => diagnostic(event),
          }),
          translator: translation.captionMode === 'separate' || translation.captionMode === 'streaming'
            ? new OpenAIParallelTranslator({ apiKey: translation.apiKey, model: translation.translationModel, targetLanguages: translation.targetLanguages,
              reasoningEffort: translation.translationReasoningEffort,
              participantNames: translation.participantNames, glossary: translation.glossary })
            : new OpenAITranslator({ apiKey: translation.apiKey, model: translation.translationModel, targetLanguages: translation.targetLanguages,
              participantNames: translation.participantNames, glossary: translation.glossary }),
          usage: this.usage,
          speakerName: (id) => guild.members.cache.get(id)?.displayName ?? id,
          onDiagnostic: diagnostic,
          onFatal: (code) => this.stopMeeting(code),
          onSourceAudio: (segmentId, speakerId, pcm) => {
            if (!this.recordsSpeaker(speakerId)) return;
            try {
              this.captionRecorder?.audio(segmentId, speakerId, pcm);
              this.continuousRecorder?.sourceAudio(segmentId, speakerId, pcm);
            }
            catch { this.stopRecording(true); }
          },
          onSourceTranscript: (segmentId, speakerId, text) => {
            if (!this.recordsSpeaker(speakerId)) return;
            try { this.captionRecorder?.transcript(segmentId, speakerId, text); }
            catch { this.stopRecording(true); }
          },
          onCaption: (caption) => {
            this.receiver?.publish(caption);
            if (this.continuousRecorder && this.recordsSpeaker(caption.speakerId)) {
              try {
                const recording = this.continuousRecorder.caption(caption);
                if (recording) caption.recording = recording;
              } catch { this.stopRecording(true); }
            }
            if (this.captionRecorder && this.recordsSpeaker(caption.speakerId)) {
              try {
                const recording = this.captionRecorder.caption(caption);
                if (recording) caption.recording = recording;
              } catch { this.stopRecording(true); }
            }
            // Local Phase 2 test output is explicitly opt-in and forbidden in production.
            if (translation.localPreview) captionPreview(caption);
          },
        });
        diagnostic('caption_pipeline_configured', { mode: translation.captionMode,
          targetLanguages: translation.targetLanguages.join(','), participantNameEntries: translation.participantNames.length,
          glossaryEntries: translation.glossary.length, sttModel: translation.sttModel, sttDelay: translation.sttDelay,
          accuracyReview: translation.reviewEnabled && translation.captionMode !== 'compare',
          conversationMemory: !!memory,
          draftIntervalMs: translation.draftIntervalMs, speechSilenceMs: translation.speechSilenceMs,
          reasoningEffort: translation.captionMode === 'compare' ? 'multiple'
            : translation.captionMode === 'streaming' || translation.captionMode === 'separate'
              ? translation.translationReasoningEffort : INTERPRETATION_REASONING_EFFORT,
          model: translation.captionMode === 'compare' ? 'multiple' : translation.translationModel, audioSegmentMs: translation.segmentMs,
          silenceMs: translation.captionSilenceMs, maxHoldMs: translation.captionMaxHoldMs });
        if (translation.localPreview) diagnostic('local_caption_preview_enabled');
      }
      const pipeline = this.pipeline;
      if (this.config.recording) {
        if (translation?.captionMode === 'streaming') this.continuousRecorder = new ContinuousCaptionRecorder({ onDiagnostic: diagnostic });
        else if (pipeline) this.captionRecorder = new CaptionAudioRecorder({ onDiagnostic: diagnostic,
          ...(translation?.captionMode === 'compare' ? { variants: COMPARISON_PRESETS.map((preset) => preset.variantId) } : {}) });
        else this.recorder = new LocalAudioRecorder({ onDiagnostic: diagnostic });
        diagnostic('recording_started', { directory: (this.continuousRecorder ?? this.captionRecorder ?? this.recorder)!.directory, scope: this.config.recording.scope,
          sampleRate: 24_000, channels: 1, pcmBits: 16, split: this.continuousRecorder ? 'continuous-source' : pipeline ? 'translation-unit' : '120s' });
      }
      this.capture = new VoiceCapture(connection.receiver, {
        silenceMs: this.config.silenceMs,
        canReceive: (userId) => connection.state.status === VoiceConnectionStatus.Ready &&
          userId !== this.client.user?.id &&
          guild.voiceStates.cache.get(userId)?.channelId === channel.id &&
          !guild.members.cache.get(userId)?.user.bot,
        onDiagnostic: ({ event, ...fields }) => diagnostic(event, fields),
        onPcm: (speakerId, pcm) => {
          if (this.continuousRecorder && this.recordsSpeaker(speakerId)) {
            try { this.continuousRecorder.append(speakerId, pcm); }
            catch { this.stopRecording(true); }
          }
          if (this.recorder && this.recordsSpeaker(speakerId)) {
            try { this.recorder.append(speakerId, pcm); }
            catch { this.stopRecording(true); }
          }
          pipeline?.push(speakerId, pcm);
        },
        onUtteranceEnd: (speakerId, reason) => {
          this.recorder?.end(speakerId);
          this.continuousRecorder?.end(speakerId);
          pipeline?.end(speakerId, reason);
        },
      });
      this.capture.start();
      this.starting = false;
      diagnostic('meeting_started', { translationEnabled: Boolean(translation) });
      const recordingNotice = this.config.recording
        ? ` 로컬 녹음이 켜져 있습니다. ${this.config.recording.scope === 'admin' ? '관리자 본인' : '참가자별'} 음성을 recordings 폴더에 ${this.continuousRecorder ? '연속 원음 WAV와 자막 수정 이력 JSON' : pipeline ? '번역 단위별 WAV와 자막 JSON' : 'WAV'}로 저장합니다.` : '';
      await interaction.editReply((translation
        ? `실시간 전사·문장 구분·${translation.targetLanguages.join(', ')} 번역을 시작했습니다. 음성과 텍스트는 OpenAI로 전송됩니다. 로컬 미리보기를 켜면 원문·번역·상세 로그는 logs 폴더에 저장됩니다. 자막은 터미널에 출력하지 않습니다. /stop으로 종료하세요.`
        : '음성 수신 검증을 시작했습니다. 전사·번역은 꺼져 있습니다. /stop으로 종료하세요.') + recordingNotice);
    } catch (error) {
      if (generation === this.generation) this.stopMeeting('start_failed');
      await interaction.editReply(error instanceof RecordingError ? error.message
        : '음성 연결에 실패했거나 시작이 취소되었습니다. 채널 ID, 권한, UDP 연결 및 npm run doctor 결과를 확인하세요.');
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }

  private stopMeeting(reason: string): void {
    ++this.generation;
    this.starting = false;
    const capture = this.capture;
    const pipeline = this.pipeline;
    const connection = this.connection;
    this.capture = undefined;
    this.pipeline = undefined;
    this.connection = undefined;
    pipeline?.stop();
    this.receiver?.endSession();
    if (capture) {
      const summary = capture.stop();
      diagnostic('capture_summary', {
        elapsedMs: summary.elapsedMs,
        speakers: Object.keys(summary.speakers).length,
        totalPackets: summary.totalPackets,
        totalPcmBytes: summary.totalPcmBytes,
        totalAudioMs: summary.totalAudioMs,
        decodeErrors: summary.decodeErrors,
        receiveErrors: summary.receiveErrors,
      });
      for (const [speakerId, stats] of Object.entries(summary.speakers)) {
        diagnostic('speaker_summary', { speakerId, ...stats });
      }
      diagnostic('meeting_stopped', { reason });
      if (this.usage) {
        try { diagnostic('usage_summary', { ...this.usage.snapshot() }); }
        catch { diagnostic('usage_snapshot_failed'); }
      }
    }
    this.stopRecording();
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  private stopRecording(failed = false): void {
    const recorder = this.continuousRecorder ?? this.captionRecorder ?? this.recorder;
    if (!recorder) return;
    this.recorder = undefined;
    this.captionRecorder = undefined;
    this.continuousRecorder = undefined;
    try {
      const summary = recorder.stop();
      diagnostic('recording_stopped', { ...summary, failed });
    } catch { failed = true; }
    if (failed) {
      diagnostic('recording_failed');
      console.error(new RecordingError().message);
    }
  }

  private recordsSpeaker(speakerId: string): boolean {
    return !!this.config.recording && (this.config.recording.scope === 'all' || speakerId === this.config.adminUserId);
  }
}
