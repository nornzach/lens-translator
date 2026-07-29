import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const HOST_URL = 'chrome-extension://test-id/src/offscreen/index.html'

type ChromeMock = {
  runtime: {
    getURL: (path: string) => string
    getContexts: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
    ContextType: { TAB: string }
  }
  windows: {
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }
}

function installChrome(): ChromeMock {
  // Mirror the real lifecycle: no host context exists until create() opens one.
  const contexts: unknown[] = []
  const mock: ChromeMock = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      getContexts: vi.fn(async () => contexts),
      // Ready probe: answer like a live host page.
      sendMessage: vi.fn((_message: unknown, callback: (response: unknown) => void) => {
        callback({ ok: true, supported: true })
      }),
      ContextType: { TAB: 'TAB' },
    },
    windows: {
      create: vi.fn(async () => {
        contexts.push({ contextType: 'TAB' })
        return { id: 7 }
      }),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
    },
  }
  vi.stubGlobal('chrome', mock)
  return mock
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureTranslatorHost', () => {
  it('minimizes the host popup right after creation (best-effort)', async () => {
    const mock = installChrome()
    const { ensureTranslatorHost } = await import('../../src/background/browser-translate')

    await ensureTranslatorHost()

    expect(mock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'popup', focused: false }),
    )
    expect(mock.windows.update).toHaveBeenCalledWith(7, { state: 'minimized' })
  })

  it('still becomes ready when minimizing is unsupported on the platform', async () => {
    const mock = installChrome()
    mock.windows.update.mockRejectedValue(new Error('not supported for popup windows'))
    const { ensureTranslatorHost } = await import('../../src/background/browser-translate')

    await expect(ensureTranslatorHost()).resolves.toBeUndefined()
  })
})

describe('handleCloseTranslatorHost', () => {
  it('refuses to close windows for senders that are not the host page', async () => {
    const mock = installChrome()
    const { handleCloseTranslatorHost } = await import('../../src/background/browser-translate')

    const result = await handleCloseTranslatorHost({
      url: 'https://evil.example.com/',
      tab: { windowId: 7 },
    } as chrome.runtime.MessageSender)

    expect(result).toEqual({ type: 'close-translator-host-result', ok: false })
    expect(mock.windows.remove).not.toHaveBeenCalled()
  })

  it('closes the window the real host page lives in', async () => {
    const mock = installChrome()
    const { handleCloseTranslatorHost } = await import('../../src/background/browser-translate')

    const result = await handleCloseTranslatorHost({
      url: HOST_URL,
      tab: { windowId: 7 },
    } as chrome.runtime.MessageSender)

    expect(result).toEqual({ type: 'close-translator-host-result', ok: true })
    expect(mock.windows.remove).toHaveBeenCalledWith(7)
  })

  it('reports ok when the window is already gone', async () => {
    const mock = installChrome()
    mock.windows.remove.mockRejectedValue(new Error('No window with id: 7.'))
    const { handleCloseTranslatorHost } = await import('../../src/background/browser-translate')

    const result = await handleCloseTranslatorHost({
      url: HOST_URL,
      tab: { windowId: 7 },
    } as chrome.runtime.MessageSender)

    expect(result.ok).toBe(true)
  })
})
