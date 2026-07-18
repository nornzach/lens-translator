import { describe, expect, it } from 'vitest'
import {
  languageName,
  languagePairLabel,
  languageShortLabel,
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
})
