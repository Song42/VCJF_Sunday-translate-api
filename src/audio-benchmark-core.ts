export const MAX_BENCHMARK_AUDIO_SECONDS = 300;
export const MAX_BENCHMARK_WAV_BYTES = 16 * 1024 * 1024;

export class AudioBenchmarkError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AudioBenchmarkError'; }
}

export interface BenchmarkArguments { help: boolean; file?: string; reference?: string; direct: boolean }
export function parseBenchmarkArguments(args: readonly string[]): BenchmarkArguments {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true, direct: false };
  const result: BenchmarkArguments = { help: false, direct: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--direct' && !result.direct) result.direct = true;
    else if (arg === '--reference' && !result.reference && args[i + 1] && !args[i + 1]!.startsWith('--')) result.reference = args[++i]!;
    else if (!arg.startsWith('-') && !result.file) result.file = arg;
    else throw new AudioBenchmarkError('benchmark_arguments', '사용법: npm run audio:benchmark -- recording.wav [--reference reference.txt] [--direct]');
  }
  if (!result.file) throw new AudioBenchmarkError('benchmark_arguments', '비교할 WAV 파일 경로가 필요합니다. --help로 사용법을 확인하세요.');
  return result;
}

/** Accept RIFF chunks in any order, but only uncompressed mono PCM16 at exactly 24 kHz. */
export function parseBenchmarkWav(file: Buffer): Buffer {
  const fail = () => new AudioBenchmarkError('benchmark_wav', 'WAV는 24kHz 모노 PCM16, 0.1~300초여야 합니다. 압축 형식·스테레오는 지원하지 않습니다.');
  if (!Buffer.isBuffer(file) || file.length < 44 || file.length > MAX_BENCHMARK_WAV_BYTES
    || file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE'
    || file.readUInt32LE(4) !== file.length - 8) throw fail();
  let format = false;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset < file.length;) {
    if (offset + 8 > file.length) throw fail();
    const kind = file.toString('ascii', offset, offset + 4);
    const length = file.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (end > file.length || end + length % 2 > file.length) throw fail();
    if (kind === 'fmt ') {
      if (format || length < 16 || file.readUInt16LE(start) !== 1 || file.readUInt16LE(start + 2) !== 1
        || file.readUInt32LE(start + 4) !== 24_000 || file.readUInt32LE(start + 8) !== 48_000
        || file.readUInt16LE(start + 12) !== 2 || file.readUInt16LE(start + 14) !== 16) throw fail();
      format = true;
    } else if (kind === 'data') {
      if (pcm || length < 4_800 || length > MAX_BENCHMARK_AUDIO_SECONDS * 48_000 || length % 2) throw fail();
      pcm = file.subarray(start, end);
    }
    offset = end + length % 2;
  }
  if (!format || !pcm) throw fail();
  return Buffer.from(pcm);
}

export interface ReplayFrame { pcm: Buffer; startMs: number; endMs: number; commit: boolean; final: boolean; turnIndex: number }

export interface BenchmarkSourceSpan { id: string; text: string; receivedAtMs?: number }
/** Consume only the exact released source prefix, retaining provenance for an unfinished tail. */
export function consumeBenchmarkSource(spans: BenchmarkSourceSpan[], original: string): string[] {
  while (spans.length) {
    spans[0]!.text = spans[0]!.text.trimStart();
    if (spans[0]!.text) break;
    spans.shift();
  }
  const expected = original.trim();
  let consumed = '', remaining = expected.length;
  const ids: string[] = [];
  while (remaining && spans.length) {
    const span = spans[0]!, count = Math.min(remaining, span.text.length);
    consumed += span.text.slice(0, count);
    if (!ids.includes(span.id)) ids.push(span.id);
    span.text = span.text.slice(count); remaining -= count;
    if (!span.text) spans.shift();
  }
  if (!expected || consumed !== expected || remaining) throw new AudioBenchmarkError('benchmark_provenance', '자막과 원음 구간의 연결을 확인할 수 없습니다.');
  return ids;
}
/** One shared replay clock fans out identical audio; four-second commits with a >=100 ms final turn. */
export async function replayBenchmarkAudio(pcm: Buffer, consume: (frame: ReplayFrame) => void, options: {
  signal: AbortSignal; now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  if (!pcm.length || pcm.length % 2) throw new AudioBenchmarkError('benchmark_audio', '비교용 PCM 오디오가 올바르지 않습니다.');
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new AudioBenchmarkError('benchmark_aborted', '시험이 중지되었습니다.')); return; }
    const aborted = () => { clearTimeout(timer); reject(new AudioBenchmarkError('benchmark_aborted', '시험이 중지되었습니다.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  }));
  const started = now();
  let turnIndex = 1, turnBytes = 0;
  for (let offset = 0; offset < pcm.length;) {
    if (options.signal.aborted) throw new AudioBenchmarkError('benchmark_aborted', '시험이 중지되었습니다.');
    const end = Math.min(pcm.length, offset + 4_800);
    turnBytes += end - offset;
    const final = end === pcm.length;
    const commit = final || (turnBytes >= 4 * 48_000 && pcm.length - end >= 4_800);
    const delay = started + end / 48 - now();
    if (delay > 0) await wait(delay, options.signal);
    if (options.signal.aborted) throw new AudioBenchmarkError('benchmark_aborted', '시험이 중지되었습니다.');
    consume({ pcm: pcm.subarray(offset, end), startMs: offset / 48, endMs: end / 48, commit, final, turnIndex });
    if (commit) { turnBytes = 0; turnIndex++; }
    offset = end;
  }
}

function distance(a: readonly string[], b: readonly string[]): number {
  if (a.length * b.length > 25_000_000) throw new AudioBenchmarkError('benchmark_reference_size', '오류율 계산용 텍스트가 너무 깁니다. 더 짧은 구간으로 나누어 점수를 계산하세요.');
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j]! + 1, previous[j + 1]! + 1, previous[j]! + (a[i] === b[j] ? 0 : 1)));
    previous = next;
  }
  return previous[b.length]!;
}
function normalized(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
/** Transcription-only measures; these do not score translated meaning. */
export function transcriptionErrorRates(reference: string, actual: string): {
  normalizedCer: number; normalizedWhitespaceWer: number; referenceCharacters: number; referenceWords: number;
} {
  const ref = normalized(reference), hypothesis = normalized(actual);
  if (!ref) throw new AudioBenchmarkError('benchmark_reference_empty', '정답 원문에 실제 발언 텍스트가 필요합니다.');
  const refChars = Array.from(ref.replace(/\s/gu, '')), hypChars = Array.from(hypothesis.replace(/\s/gu, ''));
  const refWords = ref.split(' '), hypWords = hypothesis ? hypothesis.split(' ') : [];
  return { normalizedCer: distance(refChars, hypChars) / refChars.length,
    normalizedWhitespaceWer: distance(refWords, hypWords) / refWords.length,
    referenceCharacters: refChars.length, referenceWords: refWords.length };
}
