import { describe, it, expect } from 'vitest'
import { matchesHotkey } from '../../src/shared/hotkey'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

describe('matchesHotkey', () => {
  const hk = DEFAULT_SETTINGS.hotkey

  it('matches Alt+Shift+L', () => {
    expect(
      matchesHotkey(
        { code: 'KeyL', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(true)
  })

  it('rejects wrong key', () => {
    expect(
      matchesHotkey(
        { code: 'KeyK', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })

  it('rejects missing modifier', () => {
    expect(
      matchesHotkey(
        { code: 'KeyL', altKey: false, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })
})
