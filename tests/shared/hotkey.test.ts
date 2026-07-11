import { describe, it, expect } from 'vitest'
import {
  matchesHotkey,
  formatHotkeyLabel,
  hotkeyFromKeyboardEvent,
  codeToKeyLabel,
} from '../../src/shared/hotkey'
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

describe('formatHotkeyLabel', () => {
  it('uses Option for alt', () => {
    expect(formatHotkeyLabel(DEFAULT_SETTINGS.hotkey)).toBe('Option+Shift+L')
  })

  it('includes Ctrl and Meta when set', () => {
    expect(
      formatHotkeyLabel({
        altKey: false,
        shiftKey: false,
        ctrlKey: true,
        metaKey: true,
        code: 'KeyK',
      }),
    ).toBe('Ctrl+⌘+K')
  })
})

describe('codeToKeyLabel', () => {
  it('maps Key and Digit codes', () => {
    expect(codeToKeyLabel('KeyA')).toBe('A')
    expect(codeToKeyLabel('Digit3')).toBe('3')
  })
})

describe('hotkeyFromKeyboardEvent', () => {
  it('ignores pure modifier keys', () => {
    expect(
      hotkeyFromKeyboardEvent({
        code: 'ShiftLeft',
        altKey: false,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBeNull()
  })

  it('captures chord with letter', () => {
    expect(
      hotkeyFromKeyboardEvent({
        code: 'KeyL',
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toEqual({
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
    })
  })
})
