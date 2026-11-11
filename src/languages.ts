export const SUPPORTED_TARGET_LANGUAGES = ['ko', 'ru', 'kk', 'en'] as const;
export type TargetLanguage = typeof SUPPORTED_TARGET_LANGUAGES[number];
export const DEFAULT_TARGET_LANGUAGES: readonly TargetLanguage[] = ['ko', 'ru', 'kk'];

/** Output selection is independent of the languages accepted by transcription. */
export function targetLanguages(value: readonly string[]): TargetLanguage[] {
  if (!Array.isArray(value) || !value.length || value.length > SUPPORTED_TARGET_LANGUAGES.length
    || new Set(value).size !== value.length
    || value.some(language => !SUPPORTED_TARGET_LANGUAGES.includes(language as TargetLanguage))) {
    throw new RangeError('TRANSLATION_LANGUAGES must contain unique language codes from ko,ru,kk,en (at least one).');
  }
  return [...value] as TargetLanguage[];
}

export function translationProperties(languages: readonly TargetLanguage[]) {
  return Object.fromEntries(languages.map(language => [language, { type: 'string' }]));
}
