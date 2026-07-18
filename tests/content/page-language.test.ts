import { describe, expect, it } from 'vitest'
import {
  evaluatePageLanguageMatch,
  isInsufficientLanguageSample,
  isLikelyEnglishText,
  isLikelySourceLanguage,
} from '../../src/content/page-language'

const ENGLISH =
  'The browser can translate this page on the device, and the original text will remain visible for people who want to compare both languages while reading carefully.'

describe('page language detection', () => {
  it('trusts strong English body text even when html lang is wrong', () => {
    expect(isLikelySourceLanguage('en', 'zh-CN', ENGLISH)).toBe(true)
  })

  it('allows declared en when the body sample is still too short (SPA shell)', () => {
    expect(isLikelySourceLanguage('en', 'en-US', 'Loading…')).toBe(true)
  })

  it('does not treat long non-English body as English just because lang=en', () => {
    const chinese =
      '这是一个用于验证页面语言检测逻辑的中文段落，不应该被判断为英文页面。这里再补一些汉字让样本量足够长，避免被当成不足样本。'
    expect(isLikelyEnglishText(chinese)).toBe(false)
    expect(isLikelySourceLanguage('en', 'en', chinese)).toBe(false)
  })

  it('recognizes an English prose sample without a declared language', () => {
    expect(isLikelyEnglishText(ENGLISH)).toBe(true)
    expect(isLikelySourceLanguage('en', '', ENGLISH)).toBe(true)
  })

  it('rejects short labels and non-English prose', () => {
    expect(isLikelyEnglishText('Home Explore Profile')).toBe(false)
    expect(
      isLikelyEnglishText('这是一个用于验证页面语言检测逻辑的中文段落，不应该被判断为英文页面。'),
    ).toBe(false)
  })

  it('flags short samples as insufficient for later retry', () => {
    expect(isInsufficientLanguageSample('Hi there')).toBe(true)
    expect(isInsufficientLanguageSample(ENGLISH)).toBe(false)
  })

  it('evaluatePageLanguageMatch asks to retry on empty SPA shells', () => {
    const doc = {
      documentElement: { lang: '' },
      querySelector: () => null,
      body: { innerText: '', textContent: '' },
    } as unknown as Document
    const result = evaluatePageLanguageMatch('en', doc)
    expect(result.matches).toBe(false)
    expect(result.shouldRetry).toBe(true)
    expect(result.reason).toBe('insufficient-sample')
  })

  it('evaluatePageLanguageMatch starts on declared en even when body is empty', () => {
    const doc = {
      documentElement: { lang: 'en' },
      querySelector: () => null,
      body: { innerText: '', textContent: '' },
    } as unknown as Document
    const result = evaluatePageLanguageMatch('en', doc)
    expect(result.matches).toBe(true)
    expect(result.shouldRetry).toBe(true)
  })
})
