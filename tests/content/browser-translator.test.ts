import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTranslator } from '../../src/content/browser-translator'

type TestTranslatorGlobal = typeof globalThis & { Translator?: unknown }
const testGlobal = globalThis as TestTranslatorGlobal
const originalTranslator = testGlobal.Translator

afterEach(() => {
  if (originalTranslator === undefined) {
    delete testGlobal.Translator
  } else {
    testGlobal.Translator = originalTranslator
  }
})

describe('BrowserTranslator', () => {
  it('uses Chrome’s available on-device translator and reuses its session', async () => {
    const translate = vi.fn(async (text: string) => `中文：${text}`)
    const create = vi.fn(async () => ({ translate }))
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create,
    }

    const fallback = new BrowserTranslator()
    await expect(fallback.translate('hello', 'en', 'zh')).resolves.toBe('中文：hello')
    await expect(fallback.translate('world', 'en', 'zh')).resolves.toBe('中文：world')

    expect(create).toHaveBeenCalledTimes(1)
    expect(translate).toHaveBeenCalledWith('hello')
    expect(translate).toHaveBeenCalledWith('world')
  })

  it('does not create a translator for an unsupported language pair', async () => {
    const create = vi.fn()
    testGlobal.Translator = {
      availability: vi.fn(async () => 'unavailable'),
      create,
    }

    const fallback = new BrowserTranslator()
    await expect(fallback.translate('hello', 'en', 'zh')).resolves.toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('serializes translations across language-pair changes', async () => {
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const create = vi.fn(async (options: { sourceLanguage: string; targetLanguage: string }) => {
      if (options.sourceLanguage === 'en') await firstGate
      return {
        translate: async (text: string) =>
          `${options.sourceLanguage}-${options.targetLanguage}:${text}`,
      }
    })
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create,
    }

    const fallback = new BrowserTranslator()
    const english = fallback.translate('hello', 'en', 'zh')
    const french = fallback.translate('bonjour', 'fr', 'en')
    releaseFirst?.()

    await expect(english).resolves.toBe('en-zh:hello')
    await expect(french).resolves.toBe('fr-en:bonjour')
    expect(create).toHaveBeenCalledTimes(2)
  })
})
