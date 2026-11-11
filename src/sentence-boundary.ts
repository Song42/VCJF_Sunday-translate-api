// Punctuation is an early commit hint, not proof that an interim STT result is final.
// Ambiguous dots fall back to the existing silence/semantic boundary handling.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'st', 'sr', 'jr', 'vs', 'etc', 'e.g', 'i.e',
  'г', 'гг', 'ул', 'им', 'св', 'рис', 'см', 'стр', 'ч', 'мин', 'сек', 'т', 'д', 'п', 'е', 'к',
  'т.д', 'т.п', 'т.е', 'т.к', 'т.б', 'т.с.с', 'ж', 'жж',
]);
const CLOSING = /[\u201d\u2019"'\u00bb\u300d\u300f)\]}]/u;
const INITIAL = /^[A-ZА-ЯЁӘІҢҒҮҰҚӨҺ]$/u;

function ambiguousDot(text: string, index: number): boolean {
  if (text[index - 1] === '.' || text[index + 1] === '.') return true;
  if (/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? '')) return true;
  const before = text.slice(0, index);
  const token = before.match(/[\p{L}.]+$/u)?.[0] ?? '';
  if (ABBREVIATIONS.has(token.toLowerCase()) || INITIAL.test(token)) return true;
  if (/^(?:\p{L}\.)+\p{L}$/u.test(token)) return true;
  // A list marker such as "1." is not a complete sentence.
  if (/^\s*\d+$/u.test(before)) return true;
  return false;
}

/** Complete confirmed sentence prefix; any unfinished suffix belongs to the next caption. */
export function completedSentencePrefix(value: string): string {
  const text = value.trim();
  let end = 0;
  for (let index = 0; index < text.length; index++) {
    if (!/[.!?。！？]/u.test(text[index]!)) continue;
    if (text[index] === '.' && ambiguousDot(text, index)) continue;
    let after = index + 1;
    while (after < text.length && /[!?！？]/u.test(text[after]!)) after++;
    while (after < text.length && CLOSING.test(text[after]!)) after++;
    // Require a word boundary: domains, abbreviations, and punctuation inside a token stay intact.
    if (after < text.length && !/\s/u.test(text[after]!)) continue;
    if (!/[\p{L}\p{N}]/u.test(text.slice(0, index))) continue;
    end = after;
    index = after - 1;
  }
  return text.slice(0, end).trim();
}

export function endsWithSentenceBoundary(text: string): boolean {
  const prefix = completedSentencePrefix(text);
  return !!prefix && prefix === text.trim();
}
