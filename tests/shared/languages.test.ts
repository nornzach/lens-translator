import { describe, expect, it } from 'vitest'
import {
  languageName,
  languagePairLabel,
  languageShortLabel,
  toTranslatorLanguageTag,
  translatorLanguageTagCandidates,
} from '../../src/shared/languages'

describe('languages', () => {
  it('resolves common names and short labels', () => {
    expect(languageName('en')).toBe('英语')
    expect(languageName('zh')).toBe('中文')
    expect(languageName('ja')).toBe('日语')
    expect(languageShortLabel('en')).toBe('EN')
    expect(languageShortLabel('zh-Hant')).toBe('繁中')
    expect(languagePairLabel('en', 'zh')).toBe('英语 → 中文')
  })

  it('falls back for unknown codes', () => {
    expect(languageName('xx-YY')).toBe('xx-YY')
    expect(languageShortLabel('xx')).toBe('XX')
  })

  it('prefers bare zh first, then script/region forms for Chrome Translator', () => {
    expect(toTranslatorLanguageTag('en')).toBe('en')
    expect(toTranslatorLanguageTag('zh')).toBe('zh')
    expect(translatorLanguageTagCandidates('zh')).toEqual(['zh', 'zh-Hans', 'zh-CN'])
    expect(translatorLanguageTagCandidates('zh-Hans')).toEqual(['zh', 'zh-Hans', 'zh-CN'])
    expect(translatorLanguageTagCandidates('zh-Hant')).toEqual([
      'zh-Hant',
      'zh-TW',
      'zh-HK',
      'zh',
    ])
    expect(translatorLanguageTagCandidates('ja')).toEqual(['ja'])
  })
})
