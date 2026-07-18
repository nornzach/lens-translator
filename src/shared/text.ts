export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function isTranslatableText(text: string, minLength: number): boolean {
  const t = normalizeText(text)
  if (t.length < minLength) return false
  // Must contain at least one letter (any script)
  if (!/\p{L}/u.test(t)) return false
  // Reject if almost no letters vs length (pure punctuation/numbers)
  const letters = t.match(/\p{L}/gu)?.length ?? 0
  if (letters / t.length < 0.3) return false
  return true
}

const TARGET_SCRIPT_RULES: Record<string, RegExp> = {
  ar: /\p{Script=Arabic}/u,
  bg: /\p{Script=Cyrillic}/u,
  bn: /\p{Script=Bengali}/u,
  el: /\p{Script=Greek}/u,
  fa: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u,
  hi: /\p{Script=Devanagari}/u,
  kn: /\p{Script=Kannada}/u,
  ko: /\p{Script=Hangul}/u,
  mr: /\p{Script=Devanagari}/u,
  ru: /\p{Script=Cyrillic}/u,
  ta: /\p{Script=Tamil}/u,
  te: /\p{Script=Telugu}/u,
  th: /\p{Script=Thai}/u,
  uk: /\p{Script=Cyrillic}/u,
  ur: /\p{Script=Arabic}/u,
  zh: /\p{Script=Han}/u,
}

/**
 * Conservatively detect target-language text by script before translation.
 * Latin languages are intentionally not guessed because script alone cannot
 * distinguish English, French, Spanish, and other Latin-script languages.
 */
export function isPredominantlyTargetLanguage(text: string, targetLanguage: string): boolean {
  const letters = normalizeText(text).match(/\p{L}/gu) ?? []
  if (!letters.length) return false

  const language = targetLanguage.toLowerCase().split('-')[0]
  if (language === 'ja') {
    const kana = letters.filter((char) =>
      /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
    ).length
    const japanese = letters.filter((char) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
    ).length
    return kana > 0 && japanese / letters.length >= 0.45
  }

  const script = TARGET_SCRIPT_RULES[language]
  if (!script) return false
  const matching = letters.filter((char) => script.test(char)).length
  return matching / letters.length >= 0.45
}

const STANDALONE_URL_RE =
  /^(?:(?:https?:\/\/|www\.)\S+|(?:[\p{L}\p{N}-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?)$/iu
const STANDALONE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const SOCIAL_TOKEN_RE = /^[@#][\p{L}\p{N}_-]+$/u

function isPageNoiseToken(token: string): boolean {
  if (STANDALONE_URL_RE.test(token) || STANDALONE_EMAIL_RE.test(token)) return true
  if (SOCIAL_TOKEN_RE.test(token)) return true
  return !/\p{L}/u.test(token)
}

/** Full-page mode excludes standalone destinations and social metadata before translation. */
export function isPageTranslatableText(text: string, minLength: number): boolean {
  const t = normalizeText(text)
  if (!isTranslatableText(t, minLength)) return false
  return !t.split(/\s+/u).every(isPageNoiseToken)
}
