type RecordData = Record<string, unknown>;
export interface DashboardTranscript { id: string; speakerId: string; text: string; final: boolean; failed: boolean; at: string }
export interface DashboardCaption {
  sequence: number; speakerId: string; speakerName: string; originalText: string; status: string; revision: number;
  translations: Record<string, string>; sourceIds: string[]; target: string; pending: string; acceptedPrefix: string;
  reason: string; latencyMs: number | null; at: string; accuracy: string;
  history: { at: string; status: string; revision: number; originalText: string; translations: Record<string, string> }[];
}
const allowed = new Set(['live_transcript', 'live_translation_requested', 'live_translation_published', 'live_boundary_decision',
  'live_caption_settling', 'live_translation_ready', 'meeting_started', 'meeting_stopped', 'caption_pipeline_configured',
  'run_started', 'run_finished', 'bot_ready', 'pipeline_error', 'accuracy_review_finished', 'accuracy_review_failed',
  'speech_silence', 'usage_summary', 'recording_failed', 'recording_started', 'recording_stopped', 'translation_ready']);
const string = (value: unknown, maximum = 12_000): string => typeof value === 'string' ? value.slice(0, maximum) : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 64).map((item) => string(item, 200)).filter(Boolean) : [];
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const object = (value: unknown): RecordData => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordData : {};
function translations(value: unknown): Record<string, string> {
  const entry = object(value);
  return Object.fromEntries(['ko', 'ru', 'kk', 'en'].filter(language => typeof entry[language] === 'string')
    .map((language) => [language, string(entry[language])]));
}

/** Whitelisted, bounded text-only view. Never expose arbitrary log fields or credentials. */
export class DashboardState {
  private file = '';
  private meeting = 'waiting';
  private generation = 0;
  private updatedAt = '';
  private error = '';
  private benchmark = false;
  private benchmarkLanes = ['low', 'medium'];
  private config: Record<string, string | number | boolean> = {};
  private readonly transcripts = new Map<string, DashboardTranscript>();
  private readonly captions = new Map<number, DashboardCaption>();
  private readonly speakers = new Map<string, string>();
  private readonly events: { event: string; at: string; sequence: number; text: string }[] = [];

  reset(file: string): void {
    this.file = file; this.meeting = 'waiting'; this.generation++; this.updatedAt = ''; this.error = ''; this.config = {}; this.benchmark = false;
    this.transcripts.clear(); this.captions.clear(); this.speakers.clear(); this.events.length = 0;
    this.benchmarkLanes = ['low', 'medium'];
  }
  apply(value: unknown): boolean {
    let row = object(value);
    const rawEvent = string(row.event, 100);
    if (rawEvent === 'audio_benchmark_started') {
      this.benchmark = true;
      const delay = string(row.sttDelay, 30);
      this.benchmarkLanes = ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(delay) ? [delay] : ['low', 'medium'];
      this.config = { mode: string(row.captionMode, 100), model: string(row.translationModel, 100),
        sttModel: string(row.sttModel, 100) || 'gpt-live-transcribe', sttDelay: this.benchmarkLanes.join(' / ') };
      if (typeof row.targetLanguages === 'string') this.config.targetLanguages = string(row.targetLanguages, 100);
      if (typeof row.reasoningEffort === 'string') this.config.reasoningEffort = string(row.reasoningEffort, 100);
      row = { event: 'meeting_started', at: row.at };
    } else if (rawEvent === 'audio_benchmark_finished') {
      row = { event: 'meeting_stopped', at: row.at };
    } else if (rawEvent === 'audio_benchmark_failed' || rawEvent === 'audio_benchmark_lane_failed') {
      row = { event: 'pipeline_error', at: row.at, code: `${string(row.lane, 30)} ${string(row.code, 100)}`.trim() };
    } else if (['audio_benchmark_caption', 'audio_benchmark_live_trace', 'audio_benchmark_partial', 'audio_benchmark_source'].includes(rawEvent)
      || this.benchmark && this.benchmarkLanes.includes(String(row.lane)) && allowed.has(rawEvent)) {
      const lane = row.lane;
      if (typeof lane !== 'string' || !this.benchmarkLanes.includes(lane)) return false;
      let details: RecordData;
      if (rawEvent === 'audio_benchmark_live_trace') {
        if (typeof row.details !== 'string' || row.details.length > 200_000) return false;
        try { details = object(JSON.parse(row.details)); } catch { return false; }
      } else if (rawEvent === 'audio_benchmark_caption') {
        details = { type: 'caption', sequence: row.caption, status: row.status, revision: row.revision,
          originalText: row.originalText, translations: translations(row), sourceSegmentIds: row.sourceIds,
          accuracy: { state: row.accuracyState } };
      } else if (rawEvent === 'audio_benchmark_partial' || rawEvent === 'audio_benchmark_source') {
        const turn = integer(rawEvent === 'audio_benchmark_partial' ? row.commitIndex : row.turn);
        if (!turn) return false;
        details = { event: 'live_transcript', sourceId: `turn-${turn}`,
          text: rawEvent === 'audio_benchmark_partial' ? row.text : row.originalText,
          final: rawEvent === 'audio_benchmark_source' };
      } else details = row;
      const sourceId = (id: string) => `${lane}:${id}`;
      const sequence = integer(details.sequence);
      const laneCount = this.benchmarkLanes.length;
      if (sequence > Math.floor(Number.MAX_SAFE_INTEGER / laneCount)) return false;
      row = { ...details, at: row.at, sequence: sequence ? (sequence - 1) * laneCount + this.benchmarkLanes.indexOf(lane) + 1 : 0,
        speakerId: `benchmark:${lane}`, speakerName: `STT ${lane}`,
        sourceId: details.sourceId ? sourceId(string(details.sourceId, 180)) : '',
        sourceIds: strings(details.sourceIds).map(sourceId),
        sourceSegmentIds: strings(details.sourceSegmentIds).map(sourceId) };
    } else if (this.benchmark && (row.type === 'caption' || rawEvent.startsWith('live_') || rawEvent === 'translation_ready')) {
      // Benchmark traces contain lane identity; unlabelled duplicate diagnostics do not.
      return false;
    }
    const event = row.type === 'caption' ? 'caption' : string(row.event, 100);
    if (event !== 'caption' && !allowed.has(event)) return false;
    const at = string(row.at, 50) || new Date().toISOString();
    if (event === 'meeting_started') {
      this.transcripts.clear(); this.captions.clear(); this.speakers.clear(); this.events.length = 0;
      this.generation++; this.meeting = 'running'; this.error = '';
      if (this.benchmark) {
        for (const lane of this.benchmarkLanes) this.speakers.set(`benchmark:${lane}`, `STT ${lane}`);
      }
    }
    if (event === 'meeting_stopped' || event === 'run_finished') this.meeting = 'stopped';
    if (this.meeting === 'waiting' && (event === 'caption' || event === 'live_transcript')) this.meeting = 'running';
    this.updatedAt = at;
    if (event === 'caption_pipeline_configured') {
      for (const key of ['mode', 'model', 'sttModel', 'sttDelay', 'reasoningEffort', 'audioSegmentMs', 'draftIntervalMs', 'speechSilenceMs', 'accuracyReview', 'targetLanguages']) {
        const field = row[key];
        if (typeof field === 'string' || typeof field === 'boolean' || typeof field === 'number') this.config[key] = typeof field === 'string' ? field.slice(0, 100) : field;
      }
    }
    if (event === 'pipeline_error' || event === 'recording_failed') this.error = string(row.code, 100) || event;
    if (event === 'live_transcript') {
      const id = string(row.sourceId, 200);
      if (!id) return false;
      this.transcripts.delete(id);
      this.transcripts.set(id, { id, speakerId: string(row.speakerId, 100), text: string(row.text),
        final: row.final === true, failed: row.failed === true, at });
      while (this.transcripts.size > 36) this.transcripts.delete(this.transcripts.keys().next().value!);
    }
    const sequence = integer(row.sequence);
    if (sequence > 0) {
      const caption = this.captions.get(sequence) ?? this.newCaption(sequence);
      caption.at = at;
      if (row.speakerId) caption.speakerId = string(row.speakerId, 100);
      if (event === 'caption') {
        const revision = integer(row.revision);
        const status = ['draft', 'initial', 'final'].includes(String(row.status)) ? String(row.status) : 'initial';
        if (revision < caption.revision || caption.status === 'final' && status !== 'final') return false;
        caption.originalText = string(row.originalText); caption.translations = translations(row.translations);
        caption.speakerName = string(row.speakerName, 100); caption.status = status; caption.revision = revision;
        caption.sourceIds = strings(row.sourceSegmentIds);
        caption.accuracy = string(object(row.accuracy).state, 100);
        if (caption.speakerName) this.speakers.set(caption.speakerId, caption.speakerName);
        caption.history.push({ at, status, revision, originalText: caption.originalText, translations: { ...caption.translations } });
        if (caption.history.length > 16) caption.history.shift();
      }
      if (event === 'live_translation_requested') {
        caption.target = string(row.targetText); caption.sourceIds = strings(row.sourceIds);
        if (caption.status === 'waiting') caption.status = 'translating';
      }
      if (event === 'live_translation_published') caption.pending = string(row.pendingText);
      if (event === 'live_boundary_decision') { caption.pending = string(row.heldText); caption.acceptedPrefix = string(row.acceptedPrefix); }
      if (event === 'live_caption_settling') { caption.target = string(row.targetText); caption.pending = string(row.pendingText); caption.reason = string(row.reason, 100); }
      if ((event === 'live_translation_ready' || event === 'translation_ready') && typeof row.latencyMs === 'number') caption.latencyMs = row.latencyMs;
      this.captions.set(sequence, caption);
      if (this.captions.size > 120) this.captions.delete([...this.captions.keys()].sort((a, b) => a - b)[0]!);
    }
    if (event !== 'live_transcript' && event !== 'caption') {
      const text = string(row.reason, 150) || string(row.code, 150) || string(row.targetText, 180) || string(row.acceptedPrefix, 180);
      this.events.push({ event, at, sequence, text });
      if (this.events.length > 90) this.events.shift();
    }
    return true;
  }
  snapshot() {
    return { file: this.file, generation: this.generation, meeting: this.meeting, updatedAt: this.updatedAt, error: this.error,
      config: { ...this.config }, speakers: Object.fromEntries(this.speakers),
      transcripts: [...this.transcripts.values()].map((entry) => ({ ...entry })),
      captions: [...this.captions.values()].sort((a, b) => b.sequence - a.sequence).map((entry) => ({ ...entry,
        translations: { ...entry.translations }, sourceIds: [...entry.sourceIds], history: entry.history.map((item) => ({ ...item, translations: { ...item.translations } })) })),
      events: this.events.slice().reverse().map((entry) => ({ ...entry })) };
  }
  private newCaption(sequence: number): DashboardCaption {
    return { sequence, speakerId: '', speakerName: '', originalText: '', status: 'waiting', revision: 0,
      translations: translations(null), sourceIds: [], target: '', pending: '', acceptedPrefix: '', reason: '', latencyMs: null,
      at: '', accuracy: '', history: [] };
  }
}
