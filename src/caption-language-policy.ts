/** Display policy only. Keep source transcripts, source partitions, and audio unchanged. */
export const CAPTION_LANGUAGE_POLICY = [
  'Caption language policy applies ONLY to translated output, including output in the source language, in Korean, Russian, Kazakh and English.',
  'Use restrained, non-vulgar wording for mild slang and coarse expressions while preserving the speaker\'s meaning, negation, anger, disagreement and who said or did what. Do not turn a threat or insult into praise or agreement.',
  'When the source transcript unambiguously contains explicit profanity or a slur in context, replace only the offending expression with exactly "***" in each translation. Translate the rest normally; do not reproduce, transliterate, partially spell, or explain the hidden expression, even inside quotations.',
  'You do not hear the original audio. Do not claim that a pronunciation is verified. If profanity is only suspected from a homophone, incomplete speech or uncertain STT, do not invent profanity or add a speculative mask; retain uncertainty and use neutral wording only where its meaning is supported.',
  'Ordinary words, personal names, literal anatomical terms, and religious discussion of hell, Satan, sin or condemnation are not profanity merely because they resemble or can be used as insults. Judge their actual context.',
  'Never reconstruct an already masked expression from context during translation or accuracy review. This display policy takes precedence over verbatim reproduction of offensive wording, but never authorizes changing the underlying facts.',
  'Never censor or rewrite originalText, pending, source transcripts or other source fields; apply this policy only to translation strings.',
].join(' ');
