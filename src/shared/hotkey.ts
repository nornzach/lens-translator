import type { HotkeyConfig } from './settings-defaults'

export type KeyLike = {
  code: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export function matchesHotkey(e: KeyLike, hotkey: HotkeyConfig): boolean {
  return (
    e.code === hotkey.code &&
    e.altKey === hotkey.altKey &&
    e.shiftKey === hotkey.shiftKey &&
    e.ctrlKey === hotkey.ctrlKey &&
    e.metaKey === hotkey.metaKey
  )
}

export function hotkeysEqual(a: HotkeyConfig, b: HotkeyConfig): boolean {
  return matchesHotkey(a, b)
}

/** Human-readable label; uses Option (not Alt) for mac-friendly UX. */
export function formatHotkeyLabel(hotkey: HotkeyConfig): string {
  const parts: string[] = []
  if (hotkey.ctrlKey) parts.push('Ctrl')
  if (hotkey.altKey) parts.push('Option')
  if (hotkey.shiftKey) parts.push('Shift')
  if (hotkey.metaKey) parts.push('⌘')
  parts.push(codeToKeyLabel(hotkey.code))
  return parts.join('+')
}

export function codeToKeyLabel(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (code.startsWith('Numpad') && code.length > 6) return code.slice(6)
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Escape: 'Esc',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
  }
  return map[code] ?? code
}

/** Capture a non-modifier keydown into a HotkeyConfig. */
export function hotkeyFromKeyboardEvent(e: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>): HotkeyConfig | null {
  if (
    e.code === 'ShiftLeft' ||
    e.code === 'ShiftRight' ||
    e.code === 'AltLeft' ||
    e.code === 'AltRight' ||
    e.code === 'ControlLeft' ||
    e.code === 'ControlRight' ||
    e.code === 'MetaLeft' ||
    e.code === 'MetaRight'
  ) {
    return null
  }
  return {
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    code: e.code,
  }
}
