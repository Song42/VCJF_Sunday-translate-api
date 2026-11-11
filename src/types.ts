import type { Translations } from './translate.js';
import type { ComparedCaption } from './model-comparison.js';

export type CaptionBoundary = 'semantic' | 'silence' | 'fallback' | 'sentence' | 'timeout' | 'limit' | 'gap';

export interface Caption {
  type: 'caption';
  sequence: number;
  segmentId: string;
  speakerId: string;
  speakerName: string;
  originalText: string;
  translations: Translations;
  createdAt: number;
  sourceSegmentIds?: string[];
  boundary?: CaptionBoundary;
  comparison?: ComparedCaption['comparison'];
  status?: 'draft' | 'initial' | 'final';
  revision?: number;
  accuracy?: { state: 'not_needed' | 'verified' | 'uncertain' | 'failed' | 'skipped'; reasons: string[] };
  recording?: { path: string; metadataPath: string; alignment: 'stt-boundary' | 'estimated' | 'source-turn';
    audioSpans?: { path: string; startMs: number; endMs: number }[] };
}
