import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardState } from '../src/dashboard-state.js';

test('benchmark lanes keep independent captions, transcripts, revisions and latency when replaying logs', () => {
  const state = new DashboardState(); state.reset('benchmark.log');
  state.apply({ event: 'audio_benchmark_started', captionMode: 'streaming', translationModel: 'test-model', targetLanguages: 'ko,ru,kk' });
  for (const lane of ['low', 'medium']) {
    state.apply({ event: 'audio_benchmark_live_trace', lane, details: JSON.stringify({ event: 'live_transcript',
      sourceId: 'same-source', text: `${lane} source`, final: false, apiKey: 'private-secret' }) });
    state.apply({ event: 'audio_benchmark_live_trace', lane, details: JSON.stringify({ event: 'live_translation_requested',
      sequence: 1, targetText: `${lane} source`, sourceIds: ['same-source'] }) });
    state.apply({ event: 'audio_benchmark_caption', lane, caption: 1, status: 'draft', revision: 0,
      originalText: `${lane} source`, ko: `${lane} translation`, sourceIds: ['same-source'] });
  }
  state.apply({ event: 'live_translation_ready', lane: 'medium', sequence: 1, latencyMs: 2345 });
  state.apply({ event: 'audio_benchmark_caption', lane: 'low', caption: 1, status: 'final', revision: 2,
    originalText: 'low final', ru: 'low result', accuracyState: 'verified' });
  state.apply({ event: 'audio_benchmark_caption', lane: 'low', caption: 1, status: 'draft', revision: 1, originalText: 'stale' });
  const snapshot = state.snapshot();
  assert.equal(snapshot.captions.length, 2);
  assert.equal(snapshot.transcripts.length, 2);
  assert.equal(snapshot.captions.find(row => row.speakerId === 'benchmark:low')?.originalText, 'low final');
  assert.equal(snapshot.captions.find(row => row.speakerId === 'benchmark:medium')?.latencyMs, 2345);
  assert.equal(snapshot.speakers['benchmark:medium'], 'STT medium');
  assert.equal(snapshot.config.targetLanguages, 'ko,ru,kk');
  assert.ok(!JSON.stringify(snapshot).includes('private-secret'));
  assert.equal(state.apply({ event: 'audio_benchmark_live_trace', lane: 'low', details: '{broken' }), false);
  state.apply({ event: 'audio_benchmark_finished', failures: 0 });
  assert.equal(state.snapshot().meeting, 'stopped');
});

test('legacy benchmark source turns update matching partials independently by lane', () => {
  const state = new DashboardState(); state.reset('legacy.log');
  state.apply({ event: 'audio_benchmark_started', captionMode: 'separate' });
  state.apply({ event: 'audio_benchmark_partial', lane: 'low', commitIndex: 1, text: 'partial' });
  state.apply({ event: 'audio_benchmark_source', lane: 'low', turn: 1, originalText: 'final' });
  state.apply({ event: 'audio_benchmark_partial', lane: 'medium', commitIndex: 1, text: 'other' });
  assert.equal(state.snapshot().transcripts.length, 2);
  assert.equal(state.snapshot().transcripts.find(row => row.id === 'low:turn-1')?.final, true);
});

test('single-lane benchmarks display only the configured delay and translation effort', () => {
  for (const delay of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
    const state = new DashboardState(); state.reset('single.log');
    state.apply({ event: 'audio_benchmark_started', sourceLanes: 1, sttDelay: delay,
      sttModel: 'gpt-live-transcribe', translationModel: 'gpt-6.1-terra', reasoningEffort: 'medium' });
    state.apply({ event: 'audio_benchmark_caption', lane: delay, caption: 1, status: 'final', revision: 1,
      originalText: 'source', ko: '번역' });
    const snapshot = state.snapshot();
    assert.equal(snapshot.config.sttDelay, delay);
    assert.equal(snapshot.config.reasoningEffort, 'medium');
    assert.deepEqual(Object.keys(snapshot.speakers), [`benchmark:${delay}`]);
    assert.equal(snapshot.captions[0]?.sequence, 1);
    assert.equal(snapshot.captions[0]?.translations.ko, '번역');
    assert.equal(state.apply({ event: 'audio_benchmark_caption', lane: delay === 'low' ? 'medium' : 'low',
      caption: 1, ko: 'unexpected' }), false);
  }
});

test('configured outputs and caption history omit inactive English', () => {
  const state = new DashboardState(); state.reset('three-languages.log');
  state.apply({ event: 'caption_pipeline_configured', targetLanguages: 'ko,ru,kk' });
  state.apply({ type: 'caption', sequence: 1, status: 'final', revision: 1, originalText: 'Hello.',
    translations: { ko: '안녕.', ru: 'Привет.', kk: 'Сәлем.' } });
  const snapshot = state.snapshot();
  assert.equal(snapshot.config.targetLanguages, 'ko,ru,kk');
  assert.deepEqual(Object.keys(snapshot.captions[0]!.translations), ['ko', 'ru', 'kk']);
  assert.equal(snapshot.captions[0]!.history[0]!.translations.en, undefined);
});

test('live STT revisions and four-language caption revisions retain the same visible caption identity', () => {
  const state = new DashboardState(); state.reset('run.log');
  state.apply({ event: 'meeting_started', at: '2026-11-05T20:00:00Z' });
  state.apply({ event: 'live_transcript', sourceId: 'source-1', speakerId: 'A', text: '시작해', final: false });
  state.apply({ event: 'live_transcript', sourceId: 'source-1', speakerId: 'A', text: '시작했습니다.', final: true });
  state.apply({ event: 'live_translation_requested', sequence: 1, speakerId: 'A', targetText: '시작했습니다.', sourceIds: ['source-1'] });
  state.apply({ type: 'caption', sequence: 1, speakerId: 'A', speakerName: '화자', originalText: '시작해', status: 'draft', revision: 0,
    translations: { ko: '시작해', ru: 'ru', kk: 'kk', en: 'Start' }, sourceSegmentIds: ['source-1'] });
  state.apply({ type: 'caption', sequence: 1, speakerId: 'A', speakerName: '화자', originalText: '시작했습니다.', status: 'final', revision: 2,
    translations: { ko: '시작했습니다.', ru: 'ru-final', kk: 'kk-final', en: 'Started.' }, sourceSegmentIds: ['source-1'] });
  const result = state.snapshot();
  assert.equal(result.captions.length, 1); assert.equal(result.transcripts.length, 1);
  assert.equal(result.captions[0]?.status, 'final'); assert.equal(result.captions[0]?.history.length, 2);
  assert.equal(result.transcripts[0]?.final, true); assert.equal(result.captions[0]?.translations.en, 'Started.');
  assert.equal(result.speakers.A, '화자');
});

test('a new meeting clears earlier sequence identities and stale drafts cannot replace finals', () => {
  const state = new DashboardState(); state.reset('run.log');
  state.apply({ type: 'caption', sequence: 1, originalText: '완료', status: 'final', revision: 3 });
  assert.equal(state.apply({ type: 'caption', sequence: 1, originalText: '예전 임시', status: 'draft', revision: 1 }), false);
  assert.equal(state.snapshot().captions[0]?.originalText, '완료');
  const before = state.snapshot().generation;
  state.apply({ event: 'meeting_started' });
  assert.equal(state.snapshot().captions.length, 0); assert.ok(state.snapshot().generation > before);
});

test('the view keeps pending/commit evidence and exposes only explicit whitelisted fields', () => {
  const state = new DashboardState(); state.reset('run.log');
  state.apply({ event: 'caption_pipeline_configured', mode: 'streaming', model: 'gpt-6.1-terra', apiKey: 'private-secret', botToken: 'private-token' });
  state.apply({ event: 'live_boundary_decision', sequence: 1, heldText: '다음 내용은', acceptedPrefix: '확정된 부분입니다.' });
  state.apply({ event: 'live_caption_settling', sequence: 1, targetText: '확정된 부분입니다.', pendingText: '다음 내용은', reason: 'stable_prefix' });
  state.apply({ event: 'live_translation_ready', sequence: 1, latencyMs: 1234 });
  assert.equal(state.apply({ event: 'unknown_raw_provider_error', apiKey: 'private-secret' }), false);
  const result = state.snapshot();
  assert.equal(result.captions[0]?.pending, '다음 내용은'); assert.equal(result.captions[0]?.latencyMs, 1234);
  assert.ok(!JSON.stringify(result).includes('private-secret')); assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('transcript, caption, event and revision retention stays bounded during long calls', () => {
  const state = new DashboardState(); state.reset('run.log');
  for (let index = 1; index <= 200; index++) {
    state.apply({ event: 'live_transcript', sourceId: `source-${index}`, speakerId: 'A', text: '원문', final: true });
    state.apply({ event: 'live_translation_requested', sequence: index, targetText: '원문' });
  }
  for (let revision = 0; revision < 30; revision++) state.apply({ type: 'caption', sequence: 200, originalText: '원문', status: 'draft', revision });
  const result = state.snapshot();
  assert.equal(result.transcripts.length, 36); assert.equal(result.captions.length, 120); assert.equal(result.events.length, 90);
  assert.equal(result.captions[0]?.history.length, 16);
});
