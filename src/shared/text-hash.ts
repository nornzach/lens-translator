import { normalizeText } from './text'

/** FNV-1a 32-bit of normalized text → base36 (fast equality key for identical sentences). */
export function hashNormalizedText(text: string): string {
  const payload = normalizeText(text)
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Page-scoped translation cache key: same sentence + langs on same page → one entry. */
export function makeTranslationCacheKey(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  text: string,
): string {
  return `${pageKey}|${sourceLang}|${targetLang}|${hashNormalizedText(text)}`
}
