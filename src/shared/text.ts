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
