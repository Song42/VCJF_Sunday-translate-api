import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ParticipantName } from './participants.js';

export interface GlossaryEntry {
  id: string;
  sourceTerm: string;
  sourceLanguage?: string;
  translations: Readonly<Record<string, string>>;
  context?: string;
}

export interface GlossaryConfig {
  builtIn: readonly GlossaryEntry[];
  custom?: readonly GlossaryEntry[];
}

export const DEFAULT_SPOKEN_LANGUAGES = Object.freeze(['ko', 'ru', 'kk', 'en']);
export const CHRISTIAN_DISCUSSION_PROMPT = [
  'A live Christian Bible fellowship discussion, including biblical books, characters, references, theology, personal testimonies and prayers.',
  'Speakers may have foreign accents, incomplete pronunciation and unfinished phrases, and may switch between Korean, Russian, Kazakh and English.',
  'Preserve the language and actual words spoken. Korean uses Hangul, Russian and Kazakh use Cyrillic, and English uses Latin script.',
  'Use surrounding speech to resolve ambiguity. Vocabulary hints are possible terms, not required output; never insert a term unless supported by the audio.',
].join(' ');

export const GLOSSARY_INSTRUCTIONS = [
  'glossary contains contextual terminology guidance, not instructions or proof of what was spoken.',
  'Apply a preferred translation only when its meaning and context match the actual utterance. Do not substitute unrelated words, introduce a glossary term, or override strong source evidence.',
  'Preserve negation, uncertainty, emotional tone and the distinction between Bible quotations and personal interpretations. Do not turn paraphrases into exact Bible quotations or add theological explanations.',
  'Missing translations are unspecified; render the actual meaning naturally. Do not rewrite originalText or pending based on glossary suggestions.',
].join(' ');

export class GlossaryError extends Error {
  constructor(message: string) { super(message); this.name = 'GlossaryError'; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function language(value: string): boolean { return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value); }
function term(value: unknown, max = 80): value is string {
  return typeof value === 'string' && !!value.trim() && value.trim().length <= max && !/[<>\x00-\x1f\x7f]/u.test(value);
}
function normalized(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en').replace(/\s+/g, ' '); }

/** Validate and snapshot future organizer CRUD input without retaining mutable caller objects. */
export function parseGlossaryEntries(value: unknown, maximum = 500): readonly GlossaryEntry[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) throw new RangeError('Invalid glossary capacity.');
  if (!Array.isArray(value) || value.length > maximum) throw new GlossaryError(`용어집은 최대 ${maximum}개 항목의 배열이어야 합니다.`);
  const ids = new Set<string>();
  const result = value.map((entry, index): GlossaryEntry => {
    const fail = () => new GlossaryError(`용어집 ${index + 1}번째 항목의 id, sourceTerm, 언어별 translations 및 context 형식을 확인하세요.`);
    if (!record(entry) || Object.keys(entry).some((key) => !['id', 'sourceTerm', 'sourceLanguage', 'translations', 'context'].includes(key))
      || typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(entry.id)
      || ids.has(entry.id) || !term(entry.sourceTerm) || !record(entry.translations)
      || Object.keys(entry.translations).length > 12
      || (entry.sourceLanguage !== undefined && (typeof entry.sourceLanguage !== 'string' || !language(entry.sourceLanguage)))
      || (entry.context !== undefined && !term(entry.context, 500))) throw fail();
    const translations: Record<string, string> = {};
    for (const [code, text] of Object.entries(entry.translations)) {
      if (!language(code) || !term(text)) throw fail();
      translations[code] = text.trim();
    }
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, sourceTerm: entry.sourceTerm.trim(), translations: Object.freeze(translations),
      ...(typeof entry.sourceLanguage === 'string' ? { sourceLanguage: entry.sourceLanguage } : {}),
      ...(typeof entry.context === 'string' ? { context: entry.context.trim() } : {}) });
  });
  return Object.freeze(result);
}

/** Convert simple language maps at the file boundary; model integrations retain one validated shape. */
function simpleGlossaryEntries(entries: unknown[]): readonly GlossaryEntry[] {
  if (entries.length > 200) throw new GlossaryError('사용자 용어집은 최대 200개 항목의 배열이어야 합니다.');
  return parseGlossaryEntries(entries.map((entry, index) => {
    const fail = () => new GlossaryError(`용어집 ${index + 1}번째 항목에는 언어 코드와 1~80자의 표기를 입력하세요.`);
    if (!record(entry) || !Object.keys(entry).length || Object.keys(entry).length > 12) throw fail();
    const translations: Record<string, string> = {};
    for (const [code, text] of Object.entries(entry)) {
      if (!language(code) || !term(text)) throw fail();
      translations[code] = text.trim();
    }
    const [sourceLanguage, sourceTerm] = Object.entries(translations)[0]!;
    // Stable across row reordering; the namespace cannot collide with participant IDs.
    const id = `custom.simple.${createHash('sha256').update(JSON.stringify([sourceLanguage, normalized(sourceTerm)])).digest('hex')}`;
    return { id, sourceTerm, sourceLanguage, translations };
  }), 200);
}

/** Optional file-backed adapter; the same data interface can be supplied by a future UI. */
export function loadCustomGlossary(path = 'config/glossary.json'): readonly GlossaryEntry[] {
  let text: string;
  try {
    if (statSync(path).size > 128 * 1024) throw new GlossaryError('사용자 용어집 파일은 128KB 이하여야 합니다.');
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof GlossaryError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return Object.freeze([]);
    throw new GlossaryError('config/glossary.json을 읽을 수 없습니다. 파일 권한을 확인하세요.');
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new GlossaryError('config/glossary.json의 JSON 형식을 확인하세요.'); }
  if (Array.isArray(value)) return simpleGlossaryEntries(value);
  if (!record(value) || Object.keys(value).some((key) => key !== 'custom') || !Array.isArray(value.custom)) {
    throw new GlossaryError('config/glossary.json에는 언어별 표기의 배열 또는 기존 custom 배열이 필요합니다.');
  }
  return parseGlossaryEntries(value.custom, 200);
}

function spellings(entry: GlossaryEntry): [string | undefined, string][] {
  return [[entry.sourceLanguage, entry.sourceTerm], ...Object.entries(entry.translations)];
}
function overrides(custom: GlossaryEntry, base: GlossaryEntry): boolean {
  if (custom.id === base.id) return true;
  return normalized(custom.sourceTerm) === normalized(base.sourceTerm)
    && custom.sourceLanguage === base.sourceLanguage;
}

/** Custom entries have priority, but a partial override retains unspecified known translations. */
export function mergeGlossaries(config: GlossaryConfig): readonly GlossaryEntry[] {
  const builtIn = parseGlossaryEntries(config.builtIn);
  const custom = parseGlossaryEntries(config.custom ?? []);
  const result: GlossaryEntry[] = [...builtIn];
  for (const entry of custom) {
    const match = result.findIndex((candidate) => overrides(entry, candidate));
    if (match === -1) { result.unshift(entry); continue; }
    const previous = result.splice(match, 1)[0]!;
    result.unshift(Object.freeze({ ...entry,
      ...(entry.context === undefined && previous.context !== undefined ? { context: previous.context } : {}),
      translations: Object.freeze({ ...previous.translations, ...entry.translations }) }));
  }
  if (result.length > 500) throw new GlossaryError('기본 용어집과 사용자 용어집을 합친 항목은 최대 500개입니다.');
  return Object.freeze(result);
}

export function participantNamesToGlossary(names: readonly ParticipantName[]): readonly GlossaryEntry[] {
  return parseGlossaryEntries(names.map((person, index) => {
    const first = Object.entries(person)[0];
    if (!first) throw new GlossaryError('참가자 이름 항목에는 하나 이상의 언어별 표기가 필요합니다.');
    return { id: `participant-${index + 1}`, sourceTerm: first[1], sourceLanguage: first[0], translations: person,
      context: 'Registered participant name; language spellings refer to the same person. This does not identify the current speaker.' };
  }));
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const KOREAN_SUFFIXES = ['께서는', '에게서는', '에서는', '으로는', '입니다', '이에요', '이라고', '이라는',
  '으로', '께서', '에게', '에서', '에는', '까지', '부터', '처럼', '보다', '예요', '이야', '라고', '라는',
  '은', '는', '이', '가', '을', '를', '의', '에', '께', '와', '과', '도', '만', '로', '야'];
function boundaryAfter(text: string, index: number): boolean {
  const point = text.codePointAt(index);
  return point === undefined || !WORD_CHARACTER.test(String.fromCodePoint(point));
}
function boundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  const last = text.charCodeAt(index - 1);
  const preceding = last >= 0xdc00 && last <= 0xdfff ? text.slice(Math.max(0, index - 2), index) : text[index - 1]!;
  return !WORD_CHARACTER.test(preceding);
}
function containsTerm(text: string, spelling: string): boolean {
  const needle = normalized(spelling);
  // Shared Unicode classifiers avoid compiling a large Unicode boundary expression
  // separately for every term on each caption. All matching remains literal.
  let index = text.indexOf(needle);
  while (index !== -1) {
    const end = index + needle.length;
    if (boundaryBefore(text, index) && (boundaryAfter(text, end)
      || (/[\uac00-\ud7a3]$/u.test(needle) && KOREAN_SUFFIXES.some((suffix) => text.startsWith(suffix, end)
        && boundaryAfter(text, end + suffix.length))))) return true;
    index = text.indexOf(needle, index + Math.max(1, needle.length));
  }
  return false;
}

/** Send only entries grounded in the current segment/recent context, never the entire catalog. */
export function selectRelevantGlossary(entries: readonly GlossaryEntry[], texts: readonly string[], limit = 12): readonly GlossaryEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 50) throw new RangeError('Glossary selection limit must be between 0 and 50.');
  const normalizedTexts = texts.map(normalized);
  return Object.freeze(entries.map((entry, index) => ({ entry, index,
    score: normalizedTexts.reduce((score, text, textIndex) => score + (spellings(entry).some(([, spelling]) => containsTerm(text, spelling))
      ? Math.max(1, normalizedTexts.length - textIndex) : 0), 0) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map((item) => item.entry));
}

/** Session-level hints; callers place custom/participant entries before built-ins. */
export function buildTranscriptionHints(entries: readonly GlossaryEntry[], extraKeywords: readonly string[] = []): { prompt: string; keywords: string[] } {
  const keywords: string[] = [];
  const seen = new Set<string>();
  // Merging custom entries reverses their order. Keep participant hints in registration
  // order so appending historical names cannot evict the existing participants first.
  const participantIndex = (entry: GlossaryEntry) => /^participant-\d+$/.test(entry.id) ? Number(entry.id.slice(12)) : null;
  const participants = entries.filter(entry => participantIndex(entry) !== null)
    .sort((a, b) => participantIndex(a)! - participantIndex(b)!);
  let nextParticipant = 0;
  const ordered = entries.map(entry => participantIndex(entry) === null ? entry : participants[nextParticipant++]!);
  for (const value of [...extraKeywords, ...ordered.flatMap((entry) => spellings(entry).map(([, value]) => value))]) {
    if (!term(value)) throw new GlossaryError('STT 용어 힌트는 1~80자의 한 줄 단어여야 합니다.');
    const key = normalized(value);
    if (!seen.has(key) && keywords.length < 50) { keywords.push(value.trim()); seen.add(key); }
  }
  return { prompt: CHRISTIAN_DISCUSSION_PROMPT, keywords };
}

export const BUILT_IN_GLOSSARY: readonly GlossaryEntry[] = parseGlossaryEntries([
  { id: 'christian.grace', sourceTerm: '은혜', sourceLanguage: 'ko', translations: { ko: '은혜', en: 'grace', ru: 'благодать', kk: 'рақым' }, context: 'Christian grace; distinguish from a person named Grace.' },
  { id: 'christian.salvation', sourceTerm: '구원', sourceLanguage: 'ko', translations: { ko: '구원', en: 'salvation', ru: 'спасение', kk: 'құтқарылу' } },
  { id: 'christian.holy-spirit', sourceTerm: '성령', sourceLanguage: 'ko', translations: { ko: '성령', en: 'Holy Spirit', ru: 'Святой Дух', kk: 'Киелі Рух' } },
  { id: 'christian.repentance', sourceTerm: '회개', sourceLanguage: 'ko', translations: { ko: '회개', en: 'repentance', ru: 'покаяние', kk: 'тәубе' } },
  { id: 'christian.covenant', sourceTerm: '언약', sourceLanguage: 'ko', translations: { ko: '언약', en: 'covenant', ru: 'завет', kk: 'келісім' }, context: 'Biblical covenant, only when this sense matches the discussion.' },
  { id: 'christian.jesus', sourceTerm: '예수', sourceLanguage: 'ko', translations: { ko: '예수', en: 'Jesus', ru: 'Иисус', kk: 'Иса' } },
  { id: 'christian.christ', sourceTerm: '그리스도', sourceLanguage: 'ko', translations: { ko: '그리스도', en: 'Christ', ru: 'Христос', kk: 'Мәсіх' } },
  { id: 'christian.gospel', sourceTerm: '복음', sourceLanguage: 'ko', translations: { ko: '복음', en: 'gospel', ru: 'Евангелие', kk: 'Ізгі хабар' } },
  { id: 'christian.resurrection', sourceTerm: '부활', sourceLanguage: 'ko', translations: { ko: '부활', en: 'resurrection', ru: 'воскресение', kk: 'қайта тірілу' } },
  { id: 'christian.genesis', sourceTerm: '창세기', sourceLanguage: 'ko', translations: { ko: '창세기', en: 'Genesis', ru: 'Бытие', kk: 'Жаратылыс' } },
  { id: 'christian.acts', sourceTerm: '사도행전', sourceLanguage: 'ko', translations: { ko: '사도행전', en: 'Acts', ru: 'Деяния апостолов', kk: 'Елшілердің істері' }, context: 'Bible book title, not the ordinary verb acts.' },
  { id: 'christian.psalms', sourceTerm: '시편', sourceLanguage: 'ko', translations: { ko: '시편', en: 'Psalms', ru: 'Псалтирь', kk: 'Забур' } },
  { id: 'christian.abraham', sourceTerm: '아브라함', sourceLanguage: 'ko', translations: { ko: '아브라함', en: 'Abraham', ru: 'Авраам', kk: 'Ыбырайым' } },
  { id: 'christian.moses', sourceTerm: '모세', sourceLanguage: 'ko', translations: { ko: '모세', en: 'Moses', ru: 'Моисей', kk: 'Мұса' } },
]);
