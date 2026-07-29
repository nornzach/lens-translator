/**
 * Source-language detection for `sourceLang: 'auto'`.
 *
 * Two layers:
 * 1. Chrome's on-device LanguageDetector (Chrome 138+, same API family as
 *    Translator) — used page-locally only. No host-window fallback: when the
 *    page blocks one API it blocks the family, and the heuristic below still
 *    covers the scripts that matter for auto-translate.
 * 2. Script heuristic — distinguishes ja/zh/ko/ru/ar/hi/th/he/el/bn/ta/te/kn
 *    reliably; Latin-script languages are indistinguishable by script, so the
 *    caller's fallback (the fixed sourceLang default) wins there.
 */

type LanguageDetectorResult = { detectedLanguage: string; confidence: number }

type LanguageDetectorApi = {
  availability(): Promise<string>
  create(): Promise<{
    detect(text: string): Promise<LanguageDetectorResult[]>
    destroy?(): void
  }>
}

type DetectorGlobal = typeof globalThis & { LanguageDetector?: LanguageDetectorApi }

const SCRIPT_RULES: Array<{ lang: string; re: RegExp }> = [
  { lang: 'ja', re: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
  { lang: 'ko', re: /\p{Script=Hangul}/u },
  { lang: 'zh', re: /\p{Script=Han}/u },
  { lang: 'ru', re: /\p{Script=Cyrillic}/u },
  { lang: 'ar', re: /\p{Script=Arabic}/u },
  { lang: 'hi', re: /\p{Script=Devanagari}/u },
  { lang: 'th', re: /\p{Script=Thai}/u },
  { lang: 'he', re: /\p{Script=Hebrew}/u },
  { lang: 'el', re: /\p{Script=Greek}/u },
  { lang: 'bn', re: /\p{Script=Bengali}/u },
  { lang: 'ta', re: /\p{Script=Tamil}/u },
  { lang: 'te', re: /\p{Script=Telugu}/u },
  { lang: 'kn', re: /\p{Script=Kannada}/u },
]

const MIN_SCRIPT_RATIO = 0.45

/**
 * Detect language by dominant script. Returns null for Latin-script text
 * (English/French/Spanish/… are indistinguishable without a real model).
 */
export function detectLanguageByScript(text: string): string | null {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 8) return null
  for (const { lang, re } of SCRIPT_RULES) {
    const matching = letters.filter((char) => re.test(char)).length
    if (matching / letters.length >= MIN_SCRIPT_RATIO) return lang
  }
  return null
}

let detectorPromise: Promise<{ detect(text: string): Promise<LanguageDetectorResult[]> } | null> | null =
  null

/** Shared LanguageDetector session; null when the API is missing/unusable. */
function getDetector(): Promise<{
  detect(text: string): Promise<LanguageDetectorResult[]>
} | null> {
  if (detectorPromise) return detectorPromise
  detectorPromise = (async () => {
    const api = (globalThis as DetectorGlobal).LanguageDetector
    if (!api) return null
    try {
      const availability = await api.availability()
      // Only create when the model is already on device — triggering a silent
      // download on a hover/scan path would surprise the user (same rule as the
      // alignment back-translation).
      if (availability !== 'available') return null
      return await api.create()
    } catch {
      return null
    }
  })()
  return detectorPromise
}

/** On-device detection; null when unavailable or low-confidence. */
export async function detectLanguageWithApi(text: string): Promise<string | null> {
  const detector = await getDetector()
  if (!detector) return null
  try {
    const results = await detector.detect(text.slice(0, 4000))
    const best = results[0]
    if (!best || best.confidence < 0.5) return null
    const tag = best.detectedLanguage?.trim()
    return tag ? tag.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Resolve the effective source language for a page/sample: API first, then
 * script heuristic, then the caller's fixed fallback.
 */
export async function resolveSourceLanguage(
  sampleText: string,
  fallback: string,
): Promise<string> {
  const detected = await detectLanguageWithApi(sampleText)
  if (detected) return detected
  return detectLanguageByScript(sampleText) ?? fallback
}

/** Test hook: drop the cached detector session between cases. */
export function _resetLanguageDetectorForTests(): void {
  detectorPromise = null
}
