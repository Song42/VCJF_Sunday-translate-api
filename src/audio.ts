import { performance } from 'node:perf_hooks';
import opus, { type OpusEncoder as NativeOpusEncoder } from '@discordjs/opus';
import {
  EndBehaviorType,
  type AudioReceiveStream,
  type VoiceReceiver,
} from '@discordjs/voice';

export interface AudioDiagnostic {
  event: string;
  speakerId?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface SpeakerCaptureSummary {
  packets: number;
  pcmBytes: number;
  audioMs: number;
  decodeErrors: number;
  receiveErrors: number;
  streams: number;
}

export interface CaptureSummary {
  elapsedMs: number;
  totalPackets: number;
  totalPcmBytes: number;
  totalAudioMs: number;
  decodeErrors: number;
  receiveErrors: number;
  activeSpeakers: number;
  speakers: Record<string, SpeakerCaptureSummary>;
}

export interface VoiceCaptureOptions {
  onDiagnostic: (event: AudioDiagnostic) => void;
  canReceive: (userId: string) => boolean;
  silenceMs?: number;
  /** Synchronous borrowed PCM; copy any bytes retained after this callback. */
  onPcm?: (speakerId: string, pcm: Buffer) => void;
  onUtteranceEnd?: (speakerId: string, reason: 'silence' | 'error' | 'left' | 'stop') => void;
}

interface SpeakerStream {
  stream: AudioReceiveStream;
  decoder: NativeOpusEncoder | undefined;
  finished: boolean;
  failed: boolean;
}

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const { OpusEncoder } = opus;

/** Discord receiver. Decoded PCM is borrowed by the consumer, then immediately wiped. */
export class VoiceCapture {
  private readonly active = new Map<string, SpeakerStream>();
  private readonly statistics = new Map<string, SpeakerCaptureSummary>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  private startedAt = 0;
  private endedAt = 0;
  private readonly silenceMs: number;

  constructor(
    private readonly receiver: VoiceReceiver,
    private readonly options: VoiceCaptureOptions,
  ) {
    this.silenceMs = options.silenceMs ?? 850;
    if (!Number.isFinite(this.silenceMs) || this.silenceMs < 100) {
      throw new Error('silenceMs must be a finite duration of at least 100 ms');
    }
  }

  start(): void {
    if (this.state === 'stopped') return;
    if (this.state === 'idle') {
      this.state = 'running';
      this.startedAt = performance.now();
      this.receiver.speaking.on('start', this.onSpeakingStart);
    }
    // A speaker may already be talking when the voice connection becomes Ready.
    for (const userId of this.receiver.speaking.users.keys()) this.subscribe(userId);
  }

  stop(): CaptureSummary {
    if (this.state !== 'stopped') {
      this.endedAt = this.state === 'running' ? performance.now() : 0;
      this.state = 'stopped';
      this.receiver.speaking.off('start', this.onSpeakingStart);
      for (const timer of this.retries.values()) clearTimeout(timer);
      this.retries.clear();
      for (const userId of [...this.active.keys()]) this.removeSpeaker(userId);
    }
    return this.snapshot();
  }

  removeSpeaker(userId: string): void {
    const retry = this.retries.get(userId);
    if (retry) clearTimeout(retry);
    this.retries.delete(userId);
    const entry = this.active.get(userId);
    if (!entry) return;
    this.finish(userId, entry, this.state === 'stopped' ? 'stop' : 'left');
    entry.stream.destroy();
  }

  snapshot(): CaptureSummary {
    const speakers: Record<string, SpeakerCaptureSummary> = {};
    let totalPackets = 0;
    let totalPcmBytes = 0;
    let decodeErrors = 0;
    let receiveErrors = 0;
    for (const [id, stats] of this.statistics) {
      // Return copies so diagnostics consumers cannot mutate receive state.
      Object.defineProperty(speakers, id, {
        value: { ...stats }, enumerable: true, writable: true, configurable: true,
      });
      totalPackets += stats.packets;
      totalPcmBytes += stats.pcmBytes;
      decodeErrors += stats.decodeErrors;
      receiveErrors += stats.receiveErrors;
    }
    const elapsed = this.state === 'running' ? performance.now() - this.startedAt
      : this.state === 'stopped' ? this.endedAt - this.startedAt : 0;
    return {
      elapsedMs: Math.max(0, Math.round(elapsed)),
      totalPackets,
      totalPcmBytes,
      totalAudioMs: totalPcmBytes / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1_000,
      decodeErrors,
      receiveErrors,
      activeSpeakers: this.active.size,
      speakers,
    };
  }

  private readonly onSpeakingStart = (userId: string): void => {
    this.subscribe(userId);
  };

  private subscribe(userId: string): void {
    if (this.state !== 'running' || this.active.has(userId) || !this.options.canReceive(userId)) return;
    const previous = this.receiver.subscriptions.get(userId);
    if (previous?.destroyed || previous?.readableEnded) {
      // A new speaking event can arrive between the old stream's end and close.
      this.scheduleRetry(userId, 50);
      return;
    }
    const retry = this.retries.get(userId);
    if (retry) clearTimeout(retry);
    this.retries.delete(userId);
    let stats = this.statistics.get(userId);
    if (!stats) {
      stats = { packets: 0, pcmBytes: 0, audioMs: 0, decodeErrors: 0, receiveErrors: 0, streams: 0 };
      this.statistics.set(userId, stats);
    }
    let stream: AudioReceiveStream;
    try {
      stream = this.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
      });
    } catch {
      stats.receiveErrors += 1;
      this.options.onDiagnostic({ event: 'audio_receive_error', speakerId: userId });
      return;
    }
    const entry: SpeakerStream = { stream, decoder: undefined, finished: false, failed: false };
    this.active.set(userId, entry);
    stats.streams += 1;
    stream.on('data', (packet: Buffer) => this.decode(userId, entry, packet));
    stream.on('error', () => {
      if (entry.finished || this.state !== 'running') return;
      stats.receiveErrors += 1;
      entry.failed = true;
      this.options.onDiagnostic({ event: 'audio_receive_error', speakerId: userId });
      // Never propagate provider errors: they may contain audio or transport data.
      stream.destroy();
    });
    stream.once('end', () => {
      this.finish(userId, entry, entry.failed ? 'error' : 'silence');
      stream.destroy();
    });
    stream.once('close', () => {
      this.finish(userId, entry, entry.failed ? 'error' : 'silence');
      if (entry.failed && this.state === 'running' && !this.active.has(userId)) {
        // The receiver removes its old subscription on close. Retry after that.
        this.scheduleRetry(userId, 250);
      }
    });
    this.options.onDiagnostic({
      event: 'audio_speaker_started', speakerId: userId,
      sampleRate: SAMPLE_RATE, channels: CHANNELS,
    });
  }

  private scheduleRetry(userId: string, delayMs: number): void {
    if (this.state !== 'running' || this.retries.has(userId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(userId);
      if (this.receiver.speaking.users.has(userId)) this.subscribe(userId);
    }, delayMs);
    timer.unref();
    this.retries.set(userId, timer);
  }

  private decode(userId: string, entry: SpeakerStream, packet: Buffer): void {
    if (entry.finished || this.state !== 'running') return;
    if (!this.options.canReceive(userId)) {
      this.removeSpeaker(userId);
      return;
    }
    const stats = this.statistics.get(userId)!;
    stats.packets += 1;
    let pcm: Buffer | undefined;
    let decoded = false;
    try {
      if (!Buffer.isBuffer(packet) || packet.length === 0) throw new Error('Invalid Opus packet');
      // libopus performs its own resampling/downmixing to the requested format.
      entry.decoder ??= new OpusEncoder(SAMPLE_RATE, CHANNELS);
      pcm = entry.decoder.decode(packet);
      if (pcm.length === 0 || pcm.length % BYTES_PER_SAMPLE !== 0) throw new Error('Invalid PCM');
      stats.pcmBytes += pcm.length;
      stats.audioMs = stats.pcmBytes / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) * 1_000;
      decoded = true;
    } catch {
      stats.decodeErrors += 1;
      entry.decoder = undefined;
      this.options.onDiagnostic({ event: 'audio_decode_error', speakerId: userId });
      this.notifyEnd(userId, 'error');
    } finally {
      if (decoded && pcm) {
        try { this.options.onPcm?.(userId, pcm); }
        catch { this.options.onDiagnostic({ event: 'audio_consumer_error', speakerId: userId }); }
      }
      pcm?.fill(0);
    }
  }

  private finish(userId: string, entry: SpeakerStream, reason: 'silence' | 'error' | 'left' | 'stop'): void {
    if (entry.finished) return;
    entry.finished = true;
    entry.decoder = undefined;
    if (this.active.get(userId) === entry) this.active.delete(userId);
    this.notifyEnd(userId, reason);
    const stats = this.statistics.get(userId)!;
    this.options.onDiagnostic({
      event: 'audio_speaker_finished', speakerId: userId,
      packets: stats.packets, pcmBytes: stats.pcmBytes,
      audioMs: stats.audioMs, decodeErrors: stats.decodeErrors,
    });
  }

  private notifyEnd(userId: string, reason: 'silence' | 'error' | 'left' | 'stop'): void {
    try { this.options.onUtteranceEnd?.(userId, reason); }
    catch { this.options.onDiagnostic({ event: 'audio_consumer_error', speakerId: userId }); }
  }
}
