const ENGLISH_MARKERS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'will',
  'with',
  'you',
])

function primaryLanguage(language: string): string {
  return language.trim().toLocaleLowerCase().split(/[-_]/u)[0]
}

export function isLikelyEnglishText(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 40) return false
  const latinLetters = text.match(/[a-z]/giu)?.length ?? 0
  if (latinLetters / letters.length < 0.78) return false

  const words = text.toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/gu) ?? []
  if (words.length < 12) return false
  const markerCount = words.reduce(
    (total, word) => total + (ENGLISH_MARKERS.has(word) ? 1 : 0),
    0,
  )
  return markerCount >= Math.max(2, Math.ceil(words.length * 0.035))
}

/**
 * Sample is too short to trust text heuristics (SPA shell, still hydrating).
 * Callers should retry later rather than treating this as "not English".
 */
export function isInsufficientLanguageSample(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  return letters.length < 40
}

export function isLikelySourceLanguage(
  sourceLanguage: string,
  declaredLanguage: string,
  textSample: string,
): boolean {
  const source = primaryLanguage(sourceLanguage)
  const declared = primaryLanguage(declaredLanguage)
  const englishText = source === 'en' && isLikelyEnglishText(textSample)

  // Strong body text can override a wrong/stale html[lang] (common CMS mistake).
  if (englishText) return true

  if (declared) {
    if (declared !== source) return false
    // Declared match alone is enough when the body is still empty/short (early SPA).
    // Once there is a long sample, require English body signal so Chinese sites
    // that incorrectly ship lang="en" do not auto-translate everything.
    if (source !== 'en') return true
    return isInsufficientLanguageSample(textSample) || englishText
  }

  return englishText
}

export type PageLanguageMatch = {
  matches: boolean
  /** True when we should wait for more DOM text before deciding. */
  shouldRetry: boolean
  reason: string
}

export function evaluatePageLanguageMatch(
  sourceLanguage: string,
  root: Document = document,
): PageLanguageMatch {
  const declaredLanguage =
    root.documentElement.lang ||
    root.querySelector<HTMLMetaElement>('meta[http-equiv="content-language" i]')?.content ||
    ''
  const sample = (root.body?.innerText || root.body?.textContent || '').slice(0, 12_000)
  const source = primaryLanguage(sourceLanguage)
  const declared = primaryLanguage(declaredLanguage)
  const insufficient = isInsufficientLanguageSample(sample)
  const englishText = source === 'en' && isLikelyEnglishText(sample)

  if (englishText) {
    return { matches: true, shouldRetry: false, reason: 'english-text' }
  }

  if (declared) {
    if (declared !== source) {
      return {
        matches: false,
        shouldRetry: insufficient && source === 'en',
        reason: `declared-mismatch:${declared}`,
      }
    }
    if (source !== 'en') {
      return { matches: true, shouldRetry: false, reason: `declared:${declared}` }
    }
    // source en + declared en
    if (insufficient) {
      return { matches: true, shouldRetry: true, reason: 'declared-en-waiting-body' }
    }
    // Long sample but not English-looking despite lang=en
    return { matches: false, shouldRetry: false, reason: 'declared-en-body-not-english' }
  }

  if (insufficient) {
    return { matches: false, shouldRetry: source === 'en', reason: 'insufficient-sample' }
  }
  return { matches: false, shouldRetry: false, reason: 'text-not-source' }
}

export function pageMatchesSourceLanguage(
  sourceLanguage: string,
  root: Document = document,
): boolean {
  return evaluatePageLanguageMatch(sourceLanguage, root).matches
}
