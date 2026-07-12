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

function hashNormalizedText64(text: string): string {
  const payload = normalizeText(text)
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < payload.length; i++) {
    hash ^= BigInt(payload.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(36)
}

/**
 * Page-scoped cache key. A 64-bit hash avoids retaining source text in cache
 * keys while making accidental cross-sentence reuse negligibly likely.
 */
export function makeTranslationCacheKey(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  text: string,
): string {
  return `${pageKey}|${sourceLang}|${targetLang}|${hashNormalizedText64(text)}`
}
