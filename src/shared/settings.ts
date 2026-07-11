import { mergeSettings, type UserSettings } from './settings-defaults'

const STORAGE_KEY = 'settings'

export async function loadSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return mergeSettings(result[STORAGE_KEY] as Partial<UserSettings> | undefined)
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export { DEFAULT_SETTINGS, mergeSettings, isConfigured } from './settings-defaults'
export type { UserSettings, HotkeyConfig } from './settings-defaults'
