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

export function isLikelySourceLanguage(
  sourceLanguage: string,
  declaredLanguage: string,
  textSample: string,
): boolean {
  const source = primaryLanguage(sourceLanguage)
  const declared = primaryLanguage(declaredLanguage)
  if (declared) return declared === source
  return source === 'en' && isLikelyEnglishText(textSample)
}

export function pageMatchesSourceLanguage(
  sourceLanguage: string,
  root: Document = document,
): boolean {
  const declaredLanguage =
    root.documentElement.lang ||
    root.querySelector<HTMLMetaElement>('meta[http-equiv="content-language" i]')?.content ||
    ''
  const sample = (root.body?.innerText || root.body?.textContent || '').slice(0, 12_000)
  return isLikelySourceLanguage(sourceLanguage, declaredLanguage, sample)
}
