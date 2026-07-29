import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLanguageDetectorForTests,
  detectLanguageByScript,
  detectLanguageWithApi,
  resolveSourceLanguage,
} from '../../src/shared/language-detect'

type DetectorGlobal = typeof globalThis & { LanguageDetector?: unknown }
const testGlobal = globalThis as DetectorGlobal
const original = testGlobal.LanguageDetector

afterEach(() => {
  if (original === undefined) delete testGlobal.LanguageDetector
  else testGlobal.LanguageDetector = original
  _resetLanguageDetectorForTests()
})

describe('detectLanguageByScript', () => {
  it('detects non-Latin scripts by dominance', () => {
    expect(detectLanguageByScript('これは日本語のテキストです。とても良いですね')).toBe('ja')
    expect(detectLanguageByScript('这是一段中文文本，用来测试脚本检测是否正常工作。')).toBe('zh')
    expect(detectLanguageByScript('이것은 한국어 텍스트입니다')).toBe('ko')
    expect(detectLanguageByScript('Это русский текст для проверки определения языка')).toBe('ru')
    expect(detectLanguageByScript('هذا نص عربي لاختبار كشف اللغة بشكل صحيح')).toBe('ar')
    expect(detectLanguageByScript('यह हिन्दी पाठ है भाषा पहचान के लिए')).toBe('hi')
    expect(detectLanguageByScript('นี่คือข้อความภาษาไทยสำหรับทดสอบ')).toBe('th')
  })

  it('returns null for Latin-script text and short samples', () => {
    expect(detectLanguageByScript('This is English text that should not match any script rule.')).toBeNull()
    expect(detectLanguageByScript("C'est un texte français avec des accents éàü.")).toBeNull()
    expect(detectLanguageByScript('短い')).toBeNull()
  })
})

describe('detectLanguageWithApi', () => {
  it('returns null when the API is missing', async () => {
    delete testGlobal.LanguageDetector
    await expect(detectLanguageWithApi('hello world')).resolves.toBeNull()
  })

  it('uses the best detection above the confidence floor', async () => {
    testGlobal.LanguageDetector = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        detect: vi.fn(async () => [{ detectedLanguage: 'ja', confidence: 0.92 }]),
      })),
    }
    await expect(detectLanguageWithApi('これはテストです')).resolves.toBe('ja')
  })

  it('rejects low-confidence results and API failures', async () => {
    testGlobal.LanguageDetector = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        detect: vi.fn(async () => [{ detectedLanguage: 'en', confidence: 0.3 }]),
      })),
    }
    await expect(detectLanguageWithApi('mixed 混合 text')).resolves.toBeNull()

    _resetLanguageDetectorForTests()
    testGlobal.LanguageDetector = {
      availability: vi.fn(async () => {
        throw new Error('policy blocked')
      }),
      create: vi.fn(),
    }
    await expect(detectLanguageWithApi('hello')).resolves.toBeNull()
  })
})

describe('resolveSourceLanguage', () => {
  it('prefers API, then heuristic, then fallback', async () => {
    // No API → heuristic wins for non-Latin scripts.
    delete testGlobal.LanguageDetector
    await expect(
      resolveSourceLanguage('これは日本語のサンプルテキストです。', 'en'),
    ).resolves.toBe('ja')
    // Latin text → fallback.
    await expect(resolveSourceLanguage('Plain English sample text for detection.', 'en')).resolves.toBe(
      'en',
    )
  })
})
