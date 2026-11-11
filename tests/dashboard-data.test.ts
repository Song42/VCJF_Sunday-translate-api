import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot, parseDashboardJSON, createViewReset, afterViewReset } from '../web/dashboard/data.js';
import { DashboardState } from '../src/dashboard-state.js';

function saved() {
  const state = new DashboardState(); state.reset('run.log');
  state.apply({ event: 'caption_pipeline_configured', targetLanguages: 'ko,ru,kk', model: 'test-model', at: '2026-11-05T20:00:00Z' });
  state.apply({ event: 'live_transcript', sourceId: 'source-1', speakerId: 'A', text: 'Grace.', final: true, at: '2026-11-05T20:00:01Z' });
  state.apply({ type: 'caption', sequence: 1, speakerId: 'A', speakerName: 'Speaker A', originalText: 'Grace.', status: 'final', revision: 1,
    translations: { ko: '은혜.', ru: 'Благодать.', kk: 'Рақым.' }, at: '2026-11-05T20:00:02Z' });
  return { ...state.snapshot(), notice: '' };
}

test('saved dashboard JSON round-trips captions, language keys, revisions and transcript state', () => {
  const snapshot = saved();
  assert.deepEqual(parseDashboardJSON(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(Object.keys(parseDashboardJSON(JSON.stringify(snapshot)).captions[0]!.translations), ['ko', 'ru', 'kk']);
});

test('a recording caption JSON can be opened without inventing transcript or prior history', () => {
  const snapshot = parseDashboardJSON(JSON.stringify({ type: 'caption', sequence: 5, originalText: 'Hello.',
    translations: { ru: 'Привет.' }, status: 'final', revision: 3, createdAt: Date.parse('2026-11-05T20:00:00Z'),
    accuracy: { state: 'verified' }, sourceSegmentIds: ['source-1'] }), 'caption.json');
  assert.equal(snapshot.file, 'caption.json');
  assert.equal(snapshot.captions[0]!.accuracy, 'verified');
  assert.equal(snapshot.captions[0]!.sourceIds[0], 'source-1');
  assert.equal(snapshot.captions[0]!.history.length, 1);
  assert.equal(snapshot.transcripts.length, 0);
  assert.match(snapshot.notice, /단일 자막/);
});

test('invalid or unrelated JSON fails and imported fields remain bounded untrusted text', () => {
  for (const value of ['{broken', 'null', '[]', '{"foo":1}']) assert.throws(() => parseDashboardJSON(value));
  const snapshot = saved();
  const imported = parseDashboardJSON(JSON.stringify({ ...snapshot, config: { ...snapshot.config, secret: 'do-not-retain' },
    captions: [{ ...snapshot.captions[0], originalText: '<img src=x onerror=alert(1)>', translations: { ko: 'a', unsupported: 'b' } }] }));
  assert.equal(imported.config.secret, undefined);
  assert.equal(imported.captions[0]!.originalText, '<img src=x onerror=alert(1)>');
  assert.deepEqual(imported.captions[0]!.translations, { ko: 'a' });
  assert.throws(() => parseDashboardJSON(JSON.stringify({ ...snapshot, captions: [snapshot.captions[0], snapshot.captions[0]] })));
});

test('view reset hides prior rows and history across repeated snapshots but allows subsequent changes', () => {
  const snapshot = saved(), reset = createViewReset(snapshot, Date.parse('2026-11-05T20:00:03Z'));
  const cleared = afterViewReset(snapshot, reset);
  assert.equal(cleared.captions.length, 0); assert.equal(cleared.transcripts.length, 0); assert.equal(cleared.events.length, 0);
  assert.equal(afterViewReset(snapshot, reset).captions.length, 0);
  assert.equal(snapshot.captions.length, 1, 'reset must not mutate the saved source');
  const at = '2026-11-05T20:00:04Z';
  const updated = { ...snapshot, captions: [{ ...snapshot.captions[0]!, at, revision: 2,
    history: [...snapshot.captions[0]!.history, { ...snapshot.captions[0]!.history[0]!, at, revision: 2 }] }] };
  assert.equal(afterViewReset(updated, reset).captions[0]!.history.length, 1);
  assert.equal(afterViewReset({ ...updated, file: 'new.log' }, reset).captions.length, 1);
  assert.equal(afterViewReset(emptySnapshot(), null).captions.length, 0);
});
