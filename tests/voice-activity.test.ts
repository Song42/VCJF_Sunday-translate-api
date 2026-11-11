import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceActivityDetector } from '../src/voice-activity.js';

test('quiet PCM packets are not speech and strong speech resumes after background adaptation', () => {
  const vad = new VoiceActivityDetector();
  const quiet = Buffer.alloc(960), speech = Buffer.alloc(960);
  for (let offset = 0; offset < quiet.length; offset += 2) {
    quiet.writeInt16LE(40, offset); speech.writeInt16LE(offset % 4 ? -2_000 : 2_000, offset);
  }
  for (let frame = 0; frame < 100; frame++) assert.equal(vad.speech(quiet), false);
  assert.equal(vad.speech(speech), true);
  assert.equal(vad.speech(Buffer.alloc(960)), false);
});
