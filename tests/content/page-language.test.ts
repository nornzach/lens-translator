import { describe, expect, it } from 'vitest'
import {
  isLikelyEnglishText,
  isLikelySourceLanguage,
} from '../../src/content/page-language'

describe('page language detection', () => {
  it('trusts a declared BCP 47 language before text heuristics', () => {
    expect(isLikelySourceLanguage('en', 'en-US', '短中文')).toBe(true)
    expect(isLikelySourceLanguage('en', 'zh-CN', 'This page is written in English.')).toBe(false)
  })

  it('recognizes an English prose sample without a declared language', () => {
    const text =
      'The browser can translate this page on the device, and the original text will remain visible for people who want to compare both languages.'
    expect(isLikelyEnglishText(text)).toBe(true)
    expect(isLikelySourceLanguage('en', '', text)).toBe(true)
  })

  it('rejects short labels and non-English prose', () => {
    expect(isLikelyEnglishText('Home Explore Profile')).toBe(false)
    expect(
      isLikelyEnglishText('这是一个用于验证页面语言检测逻辑的中文段落，不应该被判断为英文页面。'),
    ).toBe(false)
  })
})
