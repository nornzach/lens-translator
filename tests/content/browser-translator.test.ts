import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserTranslator } from '../../src/content/browser-translator'
import { BrowserTranslatorCore } from '../../src/shared/browser-translator-core'

type TestTranslatorGlobal = typeof globalThis & { Translator?: unknown }
const testGlobal = globalThis as TestTranslatorGlobal
const originalTranslator = testGlobal.Translator

type RuntimeMock = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendMessage: (...args: any[]) => void
  lastError?: { message?: string }
}

function installChrome(runtime: RuntimeMock): void {
  Object.assign(globalThis, {
    chrome: { runtime },
  })
}

function uninstallChrome(): void {
  Reflect.deleteProperty(globalThis, 'chrome')
}

afterEach(() => {
  if (originalTranslator === undefined) {
    delete testGlobal.Translator
  } else {
    testGlobal.Translator = originalTranslator
  }
  vi.restoreAllMocks()
  uninstallChrome()
})

describe('BrowserTranslatorCore', () => {
  it('reports API and language-pair availability', async () => {
    delete testGlobal.Translator
    const translator = new BrowserTranslatorCore()
    await expect(translator.availability('en', 'zh')).resolves.toBe('unsupported')

    testGlobal.Translator = {
      availability: vi.fn(async () => 'downloadable'),
      create: vi.fn(),
    }
    await expect(translator.availability('en', 'zh')).resolves.toBe('downloadable')
  })

  it('uses Chrome’s available on-device translator and reuses its session', async () => {
    const translate = vi.fn(async (text: string) => `中文：${text}`)
    const create = vi.fn(async () => ({ translate }))
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create,
    }

    const core = new BrowserTranslatorCore()
    await expect(core.translate('hello', 'en', 'zh')).resolves.toBe('中文：hello')
    await expect(core.translate('world', 'en', 'zh')).resolves.toBe('中文：world')

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

    const core = new BrowserTranslatorCore()
    await expect(core.translate('hello', 'en', 'zh')).resolves.toBeNull()
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

    const core = new BrowserTranslatorCore()
    const english = core.translate('hello', 'en', 'zh')
    const french = core.translate('bonjour', 'fr', 'en')
    releaseFirst?.()

    await expect(english).resolves.toBe('en-zh:hello')
    await expect(french).resolves.toBe('fr-en:bonjour')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('records lastError when create throws', async () => {
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => {
        throw new Error('The on-device translation is not available.')
      }),
    }
    const core = new BrowserTranslatorCore()
    await expect(core.prepare('en', 'zh')).resolves.toBe(false)
    expect(core.lastError).toMatch(/on-device translation is not available/i)
  })

  it('uses bare zh when Chrome reports it usable (not only zh-Hans)', async () => {
    const availability = vi.fn(async (opts: { targetLanguage: string }) =>
      opts.targetLanguage === 'zh' ? 'downloadable' : 'unavailable',
    )
    const create = vi.fn(async () => ({
      translate: async (text: string) => text,
    }))
    testGlobal.Translator = { availability, create }

    const core = new BrowserTranslatorCore()
    await expect(core.prepare('en', 'zh')).resolves.toBe(true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      }),
    )
  })

  it('falls back to zh-Hans when bare zh is unavailable', async () => {
    const availability = vi.fn(async (opts: { targetLanguage: string }) =>
      opts.targetLanguage === 'zh-Hans' ? 'available' : 'unavailable',
    )
    const create = vi.fn(async () => ({
      translate: async (text: string) => text,
    }))
    testGlobal.Translator = { availability, create }

    const core = new BrowserTranslatorCore()
    await expect(core.prepare('en', 'zh')).resolves.toBe(true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'en',
        targetLanguage: 'zh-Hans',
      }),
    )
  })
})

describe('BrowserTranslator (hybrid local + remote)', () => {
  function mockChrome(handler: (message: unknown) => unknown) {
    installChrome({
      sendMessage: (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(handler(_message))
      },
    })
  }

  it('uses page-local Translator when available (no remote call)', async () => {
    const translate = vi.fn(async (text: string) => `L:${text}`)
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({ translate })),
    }
    const sendMessage = vi.fn()
    installChrome({ sendMessage })

    const translator = new BrowserTranslator()
    await expect(translator.availability('en', 'zh')).resolves.toBe('available')
    await expect(translator.translate('hello', 'en', 'zh')).resolves.toBe('L:hello')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to remote when page-local pair is unavailable (e.g. Gmail policy)', async () => {
    testGlobal.Translator = {
      availability: vi.fn(async () => 'unavailable'),
      create: vi.fn(),
    }
    mockChrome((message) => {
      expect(message).toMatchObject({
        type: 'browser-translator',
        op: 'availability',
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      })
      return {
        type: 'browser-translator-result',
        ok: true,
        op: 'availability',
        availability: 'available',
      }
    })

    const translator = new BrowserTranslator()
    await expect(translator.availability('en', 'zh')).resolves.toBe('available')
  })

  it('uses remote translate after remote route is selected', async () => {
    testGlobal.Translator = {
      availability: vi.fn(async () => 'unavailable'),
      create: vi.fn(),
    }
    mockChrome((message) => {
      const msg = message as { op?: string }
      if (msg.op === 'availability') {
        return {
          type: 'browser-translator-result',
          ok: true,
          op: 'availability',
          availability: 'available',
        }
      }
      if (msg.op === 'translate') {
        return {
          type: 'browser-translator-result',
          ok: true,
          op: 'translate',
          translation: '远程你好',
        }
      }
      if (msg.op === 'prepare') {
        return { type: 'browser-translator-result', ok: true, op: 'prepare', ready: true }
      }
      return { type: 'browser-translator-result', ok: false, error: 'unexpected' }
    })

    const translator = new BrowserTranslator()
    await translator.availability('en', 'zh')
    await expect(translator.translate('hello', 'en', 'zh')).resolves.toBe('远程你好')
  })

  it('maps messaging failure on remote probe to unavailable when local also fails', async () => {
    delete testGlobal.Translator
    const runtime: RuntimeMock = {
      sendMessage: (_message: unknown, callback?: (response: unknown) => void) => {
        runtime.lastError = { message: 'Extension context invalidated.' }
        callback?.(undefined)
      },
    }
    installChrome(runtime)
    const translator = new BrowserTranslator()
    await expect(translator.availability('en', 'zh')).resolves.toBe('unavailable')
  })

  it('does not treat remote transport errors as whole-browser unsupported', async () => {
    delete testGlobal.Translator
    mockChrome(() => ({
      type: 'browser-translator-result',
      ok: false,
      error: 'Translator API missing in this context',
    }))

    const translator = new BrowserTranslator()
    // Host/messaging flakes are transient — never claim the browser lacks Translator forever.
    await expect(translator.availability('en', 'zh')).resolves.toBe('unavailable')
  })

  it('re-checks page-local Translator after a prior remote-only route', async () => {
    const localAvailability = vi
      .fn()
      .mockResolvedValueOnce('unavailable') // first probe: policy-blocked page
      .mockResolvedValue('available') // later probes: local works again
    const localTranslate = vi.fn(async (text: string) => `L:${text}`)
    testGlobal.Translator = {
      availability: localAvailability,
      create: vi.fn(async () => ({ translate: localTranslate })),
    }

    let remoteCalls = 0
    mockChrome((message) => {
      const msg = message as { op?: string }
      remoteCalls += 1
      if (msg.op === 'availability') {
        return {
          type: 'browser-translator-result',
          ok: true,
          op: 'availability',
          // Remote dies after the first successful handoff.
          availability: remoteCalls === 1 ? 'available' : 'unavailable',
        }
      }
      return { type: 'browser-translator-result', ok: false, error: 'remote dead' }
    })

    const translator = new BrowserTranslator()
    await expect(translator.availability('en', 'zh')).resolves.toBe('available')
    // Sticky remote would skip local forever and then fail when host dies.
    await expect(translator.availability('en', 'zh')).resolves.toBe('available')
    await expect(translator.translate('hello', 'en', 'zh')).resolves.toBe('L:hello')
    // Probe + translate each re-check local (must not stay sticky-remote).
    expect(localAvailability.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(localTranslate).toHaveBeenCalledWith('hello')
  })

  it('tries page-local prepare before opening the remote host path', async () => {
    const create = vi.fn(async () => ({
      translate: async (text: string) => `L:${text}`,
    }))
    testGlobal.Translator = {
      availability: vi.fn(async () => 'downloadable'),
      create,
    }
    const sendMessage = vi.fn()
    installChrome({ sendMessage })

    const translator = new BrowserTranslator()
    const progress = vi.fn()
    await expect(translator.prepare('en', 'zh', progress)).resolves.toBe(true)
    expect(create).toHaveBeenCalled()
    // Download from the options/onboarding click must not bounce through the host first.
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('exposes lastError when prepare fails locally', async () => {
    testGlobal.Translator = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => {
        throw new Error('Network error while downloading language pack')
      }),
    }
    // Remote also fails so prepare returns false with the local error retained.
    mockChrome(() => ({
      type: 'browser-translator-result',
      ok: false,
      error: 'host down',
    }))

    const translator = new BrowserTranslator()
    await expect(translator.prepare('en', 'zh')).resolves.toBe(false)
    expect(translator.lastError).toMatch(/Network error|host down|prepare failed/i)
  })

  it('only reports unsupported when host affirmatively has no Translator API', async () => {
    delete testGlobal.Translator
    mockChrome((message) => {
      const msg = message as { op?: string }
      if (msg.op === 'availability') {
        return {
          type: 'browser-translator-result',
          ok: true,
          op: 'availability',
          availability: 'unsupported',
        }
      }
      if (msg.op === 'is-supported') {
        return {
          type: 'browser-translator-result',
          ok: true,
          op: 'is-supported',
          supported: false,
        }
      }
      return { type: 'browser-translator-result', ok: false, error: 'unexpected' }
    })

    const translator = new BrowserTranslator()
    await expect(translator.availability('en', 'zh')).resolves.toBe('unsupported')
  })
})
