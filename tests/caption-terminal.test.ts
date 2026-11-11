import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptionTerminal } from '../src/caption-terminal.js';
import type { Caption } from '../src/types.js';
const caption = (text: string, status: Caption['status'], revision: number): Caption => ({
  type: 'caption', sequence: 1, segmentId: 'source-1', speakerId: 'A', speakerName: 'Test', originalText: text,
  translations: { ko: text, ru: 'ru', kk: 'kk', en: 'en' }, createdAt: 0, revision, ...(status ? { status } : {}),
});
test('TTY replaces the live original text and commits the final only once', () => {
  const writes: string[] = [];
  const terminal = new CaptionTerminal({ isTTY: true, columns: 80, write: (text) => writes.push(text) });
  terminal.render(caption('시작', 'draft', 0)); terminal.render(caption('시작했습니다.', 'draft', 1));
  terminal.render(caption('시작했습니다.', 'final', 2));
  const count = writes.length; terminal.render(caption('시작했습니다.', 'final', 2));
  assert.ok(writes.some((text) => text.includes('\x1b['))); assert.equal(writes.length, count);
});
test('piped terminal output contains only the final original while logs can retain all revisions', () => {
  const lines: string[] = [];
  const terminal = new CaptionTerminal({ isTTY: false, write: () => {} }, (text) => lines.push(text));
  terminal.render(caption('시작', 'draft', 0)); terminal.render(caption('시작했습니다.', 'final', 2));
  assert.deepEqual(lines, ['시작했습니다.']);
});
