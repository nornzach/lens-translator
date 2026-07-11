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
