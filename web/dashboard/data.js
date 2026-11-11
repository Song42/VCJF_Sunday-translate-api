const languages = ['ko', 'ru', 'kk', 'en'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 12000) => typeof value === 'string' ? value.slice(0, limit) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
const translations = value => Object.fromEntries(languages.filter(language => record(value) && typeof value[language] === 'string')
  .map(language => [language, text(value[language])]));
const sourceKey = snapshot => `${snapshot.file}:${snapshot.generation}`;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function emptySnapshot() {
  return { file: '', generation: 0, meeting: 'waiting', updatedAt: '', error: '', notice: '', config: {}, speakers: {},
    transcripts: [], captions: [], events: [] };
}

/** Local file data is bounded and copied field by field; it is never interpreted as HTML. */
export function parseDashboardJSON(json, filename = 'saved.json') {
  if (json.length > MAX_IMPORT_BYTES) throw new Error('8MB 이하의 JSON 파일을 선택하세요.');
  let value;
  try { value = JSON.parse(json.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 형식을 읽을 수 없습니다.'); }
  if (!record(value)) throw new Error('대시보드에서 저장한 JSON 또는 자막 JSON을 선택하세요.');
  let input = value;
  if (value.type === 'caption' && typeof value.originalText === 'string' && record(value.translations)) {
    const at = time(value.at) || (Number.isFinite(value.createdAt) && Math.abs(value.createdAt) <= 8.64e15 ? new Date(value.createdAt).toISOString() : '');
    const accuracy = typeof value.accuracy === 'string' ? value.accuracy : record(value.accuracy) ? value.accuracy.state : '';
    input = { ...emptySnapshot(), meeting: 'stopped', updatedAt: at, captions: [{ ...value, at, accuracy,
      history: [{ ...value, at }], sourceIds: value.sourceSegmentIds }],
      notice: '단일 자막 파일입니다. 실시간 전사·다른 자막·이전 수정 이력은 이 파일에 포함되지 않습니다.' };
  } else if (!Array.isArray(value.captions) || !Array.isArray(value.transcripts) || !Array.isArray(value.events)
    || !record(value.config) || !record(value.speakers)) {
    throw new Error('지원하지 않는 JSON입니다. 화면 데이터 저장으로 만든 파일 또는 recordings의 자막 .json을 선택하세요.');
  }
  const snapshot = emptySnapshot();
  snapshot.file = text(input.file, 200) || text(filename, 200);
  snapshot.generation = integer(input.generation);
  snapshot.meeting = ['waiting', 'running', 'stopped'].includes(input.meeting) ? input.meeting : 'waiting';
  snapshot.updatedAt = time(input.updatedAt); snapshot.error = text(input.error, 100); snapshot.notice = text(input.notice, 1000);
  for (const key of ['mode', 'model', 'sttModel', 'sttDelay', 'reasoningEffort', 'audioSegmentMs', 'draftIntervalMs', 'speechSilenceMs', 'accuracyReview', 'targetLanguages']) {
    const field = record(input.config) ? input.config[key] : undefined;
    if (typeof field === 'string' || typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field)) {
      snapshot.config[key] = typeof field === 'string' ? field.slice(0, 100) : field;
    }
  }
  snapshot.speakers = Object.fromEntries(Object.entries(input.speakers || {}).slice(0, 100).filter(([, name]) => typeof name === 'string')
    .map(([id, name]) => [id.slice(0, 100), text(name, 100)]));
  snapshot.transcripts = list(input.transcripts, 36).filter(record).map(item => ({ id: text(item.id, 200),
    speakerId: text(item.speakerId, 100), text: text(item.text), final: item.final === true, failed: item.failed === true, at: time(item.at) }));
  snapshot.captions = list(input.captions, 120).filter(record).map(item => {
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || !record(item.translations)) {
      throw new Error('자막 번호 또는 번역 데이터 형식이 잘못되었습니다.');
    }
    const status = value => ['waiting', 'translating', 'draft', 'initial', 'final'].includes(value) ? value : 'initial';
    return { sequence: item.sequence, speakerId: text(item.speakerId, 100), speakerName: text(item.speakerName, 100),
      originalText: text(item.originalText), status: status(item.status), revision: integer(item.revision), translations: translations(item.translations),
      sourceIds: list(item.sourceIds, 64).map(id => text(id, 200)), target: text(item.target), pending: text(item.pending),
      acceptedPrefix: text(item.acceptedPrefix), reason: text(item.reason || item.boundary, 100),
      latencyMs: typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs) && item.latencyMs >= 0 ? item.latencyMs : null,
      at: time(item.at), accuracy: text(item.accuracy, 100),
      history: list(item.history, 16).filter(record).map(entry => ({ at: time(entry.at), status: status(entry.status),
        revision: integer(entry.revision), originalText: text(entry.originalText), translations: translations(entry.translations) })) };
  }).sort((a, b) => b.sequence - a.sequence);
  snapshot.events = list(input.events, 90).filter(record).map(item => ({ event: text(item.event, 100), at: time(item.at),
    sequence: integer(item.sequence), text: text(item.text, 200) }));
  if (new Set(snapshot.captions.map(item => item.sequence)).size !== snapshot.captions.length) {
    throw new Error('중복된 자막 번호가 있습니다.');
  }
  return snapshot;
}

/** Clear this browser's view only. New snapshots cannot restore pre-clear rows. */
export function createViewReset(snapshot, now = Date.now()) {
  return { key: sourceKey(snapshot), at: Math.max(now, Date.parse(snapshot.updatedAt) || 0) };
}
export function afterViewReset(snapshot, reset) {
  if (!reset || sourceKey(snapshot) !== reset.key) return snapshot;
  const newer = item => (Date.parse(item.at) || 0) > reset.at;
  return { ...snapshot, error: snapshot.events.some(item => newer(item) && ['pipeline_error', 'recording_failed'].includes(item.event)) ? snapshot.error : '',
    notice: '', transcripts: snapshot.transcripts.filter(newer),
    captions: snapshot.captions.filter(newer).map(item => ({ ...item, history: item.history.filter(newer) })),
    events: snapshot.events.filter(newer) };
}
