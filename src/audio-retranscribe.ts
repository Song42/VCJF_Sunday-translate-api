/** Independent, bounded audio evidence for selective caption review; never writes audio to disk. */
export interface AudioRetranscriptionRequest {
  pcm: Buffer;
  signal: AbortSignal;
  prompt?: string;
  keywords?: readonly string[];
  languages?: readonly string[];
}
export interface AudioRetranscriptionResult { text: string }
export interface AudioRetranscriber {
  transcribe(input: AudioRetranscriptionRequest): Promise<AudioRetranscriptionResult>;
}
export interface OpenAIAudioRetranscriberOptions { apiKey: string; timeoutMs?: number }
export type RetranscriptionErrorCode = 'retranscription_configuration' | 'retranscription_audio'
  | 'retranscription_auth' | 'retranscription_model' | 'retranscription_rate_limit'
  | 'retranscription_timeout' | 'retranscription_aborted' | 'retranscription_network'
  | 'retranscription_response' | 'retranscription_provider';
export class RetranscriptionError extends Error {
  constructor(readonly code: RetranscriptionErrorCode) { super(`Audio verification failed: ${code}`); this.name = 'RetranscriptionError'; }
}

const MAX_PCM_BYTES = 30 * 48_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** WAV PCM s16le, mono 24 kHz. Caller owns the returned temporary buffer. */
export function pcmToWav(pcm: Buffer): Buffer {
  if (!Buffer.isBuffer(pcm) || pcm.length < 4_800 || pcm.length % 2 || pcm.length > MAX_PCM_BYTES) {
    throw new RetranscriptionError('retranscription_audio');
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

async function parseResponse(response: Response): Promise<AudioRetranscriptionResult> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel(); throw new RetranscriptionError('retranscription_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new RetranscriptionError('retranscription_response'); }
      chunks.push(value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { throw new RetranscriptionError('retranscription_response'); }
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || value.text.length > 50_000) {
      throw new RetranscriptionError('retranscription_response');
    }
    return { text: value.text.trim() };
  } finally { reader.releaseLock(); }
}

export class OpenAIAudioRetranscriber implements AudioRetranscriber {
  private readonly timeoutMs: number;
  constructor(private readonly options: OpenAIAudioRetranscriberOptions, private readonly request: typeof fetch = fetch) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!options.apiKey.trim() || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new RetranscriptionError('retranscription_configuration');
    }
  }

  async transcribe(input: AudioRetranscriptionRequest): Promise<AudioRetranscriptionResult> {
    if (input.signal.aborted) throw new RetranscriptionError('retranscription_aborted');
    if ((input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 1_000))
      || (input.keywords !== undefined && (!Array.isArray(input.keywords) || input.keywords.length > 50
        || input.keywords.some((word) => typeof word !== 'string' || !word.trim() || word.length > 80 || /[\r\n<>]/.test(word))))
      || (input.languages !== undefined && (!Array.isArray(input.languages) || input.languages.length > 8
        || input.languages.some((language) => typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language))))) {
      throw new RetranscriptionError('retranscription_configuration');
    }
    const wav = pcmToWav(input.pcm);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = AbortSignal.any([input.signal, controller.signal]);
    try {
      const body = new FormData();
      body.set('model', 'gpt-transcribe');
      body.set('response_format', 'json');
      body.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav');
      if (input.prompt?.trim()) body.set('prompt', input.prompt.trim());
      for (const keyword of input.keywords ?? []) body.append('keywords[]', keyword.trim());
      for (const language of input.languages ?? []) body.append('languages[]', language);
      const response = await this.request('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.options.apiKey}` }, body, signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RetranscriptionError(response.status === 401 || response.status === 403 ? 'retranscription_auth'
          : response.status === 404 ? 'retranscription_model' : response.status === 429 ? 'retranscription_rate_limit'
          : response.status === 408 ? 'retranscription_timeout' : 'retranscription_provider');
      }
      const result = await parseResponse(response);
      if (signal.aborted) throw new RetranscriptionError(input.signal.aborted ? 'retranscription_aborted' : 'retranscription_timeout');
      return result;
    } catch (error) {
      if (input.signal.aborted) throw new RetranscriptionError('retranscription_aborted');
      if (controller.signal.aborted) throw new RetranscriptionError('retranscription_timeout');
      if (error instanceof RetranscriptionError) throw error;
      throw new RetranscriptionError('retranscription_network');
    } finally {
      clearTimeout(timer);
      wav.fill(0); // The caller retains its own PCM; transport-owned Blob memory is released after this request.
    }
  }
}
