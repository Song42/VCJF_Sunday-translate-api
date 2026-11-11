import type { DashboardCaption, DashboardTranscript } from '../../src/dashboard-state.js';
export interface DashboardSnapshot {
  file: string; generation: number; meeting: string; updatedAt: string; error: string; notice: string;
  config: Record<string, string | number | boolean>; speakers: Record<string, string>;
  transcripts: DashboardTranscript[]; captions: DashboardCaption[];
  events: { event: string; at: string; sequence: number; text: string }[];
}
export interface ViewReset { key: string; at: number }
export const MAX_IMPORT_BYTES: number;
export function emptySnapshot(): DashboardSnapshot;
export function parseDashboardJSON(json: string, filename?: string): DashboardSnapshot;
export function createViewReset(snapshot: DashboardSnapshot, now?: number): ViewReset;
export function afterViewReset(snapshot: DashboardSnapshot, reset: ViewReset | null): DashboardSnapshot;
