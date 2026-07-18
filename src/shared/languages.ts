/** Shared language labels for any configured source/target pair (not hard-coded EN→ZH). */

const LANGUAGE_NAMES: Record<string, string> = {
  ar: '阿拉伯语',
  bg: '保加利亚语',
  bn: '孟加拉语',
  cs: '捷克语',
  da: '丹麦语',
  de: '德语',
  el: '希腊语',
  en: '英语',
  es: '西班牙语',
  fa: '波斯语',
  fi: '芬兰语',
  fr: '法语',
  he: '希伯来语',
  hi: '印地语',
  hr: '克罗地亚语',
  hu: '匈牙利语',
  id: '印度尼西亚语',
  it: '意大利语',
  ja: '日语',
  kn: '卡纳达语',
  ko: '韩语',
  lt: '立陶宛语',
  mr: '马拉地语',
  nl: '荷兰语',
  no: '挪威语',
  pl: '波兰语',
  pt: '葡萄牙语',
  ro: '罗马尼亚语',
  ru: '俄语',
  sk: '斯洛伐克语',
  sl: '斯洛文尼亚语',
  sv: '瑞典语',
  ta: '泰米尔语',
  te: '泰卢固语',
  th: '泰语',
  tr: '土耳其语',
  uk: '乌克兰语',
  ur: '乌尔都语',
  vi: '越南语',
  zh: '中文',
  'zh-hant': '繁体中文',
  'zh-hans': '简体中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁体中文',
  'zh-hk': '繁体中文',
}

/** Short badge labels for compact UI (lens panel, etc.). */
const SHORT_LABELS: Record<string, string> = {
  ar: 'AR',
  bg: 'BG',
  bn: 'BN',
  cs: 'CS',
  da: 'DA',
  de: 'DE',
  el: 'EL',
  en: 'EN',
  es: 'ES',
  fa: 'FA',
  fi: 'FI',
  fr: 'FR',
  he: 'HE',
  hi: 'HI',
  hr: 'HR',
  hu: 'HU',
  id: 'ID',
  it: 'IT',
  ja: 'JA',
  kn: 'KN',
  ko: 'KO',
  lt: 'LT',
  mr: 'MR',
  nl: 'NL',
  no: 'NO',
  pl: 'PL',
  pt: 'PT',
  ro: 'RO',
  ru: 'RU',
  sk: 'SK',
  sl: 'SL',
  sv: 'SV',
  ta: 'TA',
  te: 'TE',
  th: 'TH',
  tr: 'TR',
  uk: 'UK',
  ur: 'UR',
  vi: 'VI',
  zh: '中文',
  'zh-hant': '繁中',
  'zh-hans': '简中',
  'zh-cn': '简中',
  'zh-tw': '繁中',
  'zh-hk': '繁中',
}

export function normalizeLangCode(code: string): string {
  return code.trim().toLowerCase()
}

export function languageName(code: string): string {
  const raw = normalizeLangCode(code)
  if (!raw) return '未知语言'
  if (LANGUAGE_NAMES[raw]) return LANGUAGE_NAMES[raw]
  const base = raw.split('-')[0]
  if (LANGUAGE_NAMES[base]) return LANGUAGE_NAMES[base]
  return code
}

/** Compact label for source/target badges inside the lens. */
export function languageShortLabel(code: string): string {
  const raw = normalizeLangCode(code)
  if (!raw) return '?'
  if (SHORT_LABELS[raw]) return SHORT_LABELS[raw]
  const base = raw.split('-')[0]
  if (SHORT_LABELS[base]) return SHORT_LABELS[base]
  return raw.slice(0, 4).toUpperCase()
}

export function languagePairLabel(sourceLang: string, targetLang: string): string {
  return `${languageName(sourceLang)} → ${languageName(targetLang)}`
}
