import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioBenchmarkError, consumeBenchmarkSource, parseBenchmarkArguments, parseBenchmarkWav, replayBenchmarkAudio, transcriptionErrorRates } from '../src/audio-benchmark-core.js';
import { pcmToWav } from '../src/audio-retranscribe.js';

test('benchmark argument parser supports safe help, reference and explicit opt-in direct comparison', () => {
  assert.deepEqual(parseBenchmarkArguments(['--help']), { help: true, direct: false });
  assert.deepEqual(parseBenchmarkArguments(['file.wav', '--reference', 'reference.txt', '--direct']),
    { help: false, direct: true, file: 'file.wav', reference: 'reference.txt' });
  for (const args of [[], ['--direct'], ['file.wav', '--bad'], ['file.wav', '--reference'], ['file.wav', '--direct', '--direct']]) {
    assert.throws(() => parseBenchmarkArguments(args), AudioBenchmarkError);
  }
});

test('WAV parser accepts unknown padded chunks and rejects truncation, compressed/stereo audio and duplicate data', () => {
  const original = pcmToWav(Buffer.alloc(4800, 42));
  assert.deepEqual(parseBenchmarkWav(original), Buffer.alloc(4800, 42));
  const extra = Buffer.alloc(10); extra.write('JUNK'); extra.writeUInt32LE(1, 4); extra[8] = 13;
  const file = Buffer.concat([original.subarray(0, 12), extra, original.subarray(12)]); file.writeUInt32LE(file.length - 8, 4);
  assert.deepEqual(parseBenchmarkWav(file), Buffer.alloc(4800, 42));
  for (const offset of [20, 22, 24, 28, 32, 34]) {
    const invalid = Buffer.from(original); invalid[offset] = 3;
    assert.throws(() => parseBenchmarkWav(invalid), AudioBenchmarkError);
  }
  assert.throws(() => parseBenchmarkWav(original.subarray(0, original.length - 1)), AudioBenchmarkError);
  const duplicate = Buffer.concat([original, original.subarray(36)]); duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => parseBenchmarkWav(duplicate), AudioBenchmarkError);
});

test('WAV parser accepts five minutes and rejects audio exceeding five minutes', () => {
  const wavWithDuration = (pcmBytes: number) => {
    const wav = Buffer.alloc(44 + pcmBytes);
    pcmToWav(Buffer.alloc(4_800)).copy(wav, 0, 0, 44);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt32LE(pcmBytes, 40);
    return wav;
  };
  const fiveMinutes = wavWithDuration(300 * 48_000);
  assert.equal(parseBenchmarkWav(fiveMinutes).length, 300 * 48_000);
  const overLimit = wavWithDuration(300 * 48_000 + 2);
  assert.throws(() => parseBenchmarkWav(overLimit), AudioBenchmarkError);
});

test('shared real-time replay emits identical 100ms frames, four-second boundaries and no sub100ms final turn', async () => {
  const pcm = Buffer.alloc(4 * 48_000 + 2400, 9); let clock = 0;
  const bytes: Buffer[] = []; const boundaries: number[] = []; const frameTimes: number[] = [];
  await replayBenchmarkAudio(pcm, (frame) => { bytes.push(frame.pcm); frameTimes.push(clock); if (frame.commit) boundaries.push(frame.endMs); }, {
    signal: new AbortController().signal, now: () => clock, wait: async (ms) => { clock += ms; },
  });
  assert.deepEqual(Buffer.concat(bytes), pcm); assert.deepEqual(boundaries, [4050]);
  assert.equal(frameTimes[0], 100); assert.equal(frameTimes[1], 200); assert.equal(clock, 4050);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(replayBenchmarkAudio(pcm, () => assert.fail('no audio after abort'), { signal: controller.signal }), AudioBenchmarkError);
});

test('normalized error rates compare source transcripts without claiming translation accuracy', () => {
  assert.equal(transcriptionErrorRates('Grace, Тестель! 예시이름.', 'grace Тестель 예시이름').normalizedCer, 0);
  assert.equal(transcriptionErrorRates('a b', 'a c').normalizedWhitespaceWer, 0.5);
  assert.equal(transcriptionErrorRates('abc', 'ab').normalizedCer, 1 / 3);
  assert.equal(transcriptionErrorRates('a', 'a b c').normalizedWhitespaceWer, 2);
  assert.throws(() => transcriptionErrorRates(' ', 'anything'), AudioBenchmarkError);
});

test('released captions retain exact audio provenance across held tails and multiple source turns', () => {
  const spans = [{ id: 'one', text: '첫 문장. 아직' }, { id: 'two', text: ' 끝나지 않은 말입니다.' }];
  assert.deepEqual(consumeBenchmarkSource(spans, '첫 문장.'), ['one']);
  assert.equal(spans.map((span) => span.text).join('').trim(), '아직 끝나지 않은 말입니다.');
  assert.deepEqual(consumeBenchmarkSource(spans, '아직 끝나지 않은 말입니다.'), ['one', 'two']);
  assert.deepEqual(spans, []);
  assert.throws(() => consumeBenchmarkSource([{ id: 'one', text: '원문' }], '추측'), AudioBenchmarkError);
});
