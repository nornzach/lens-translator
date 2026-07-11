import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings-defaults'

describe('DEFAULT_SETTINGS', () => {
  it('defaults to en→zh with autoTranslate on', () => {
    expect(DEFAULT_SETTINGS.sourceLang).toBe('en')
    expect(DEFAULT_SETTINGS.targetLang).toBe('zh')
    expect(DEFAULT_SETTINGS.autoTranslate).toBe(true)
    expect(DEFAULT_SETTINGS.lensWidthPx).toBe(320)
    expect(DEFAULT_SETTINGS.minTextLength).toBe(10)
    expect(DEFAULT_SETTINGS.batchCharLimit).toBe(6000)
    expect(DEFAULT_SETTINGS.hotkey).toEqual({
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      code: 'KeyL',
    })
    expect(DEFAULT_SETTINGS.pausedHostnames).toEqual([])
  })
})

describe('mergeSettings', () => {
  it('fills missing fields from defaults', () => {
    const merged = mergeSettings({ apiKey: 'sk-test' })
    expect(merged.apiKey).toBe('sk-test')
    expect(merged.autoTranslate).toBe(true)
    expect(merged.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('preserves pausedHostnames when provided', () => {
    const merged = mergeSettings({ pausedHostnames: ['example.com'] })
    expect(merged.pausedHostnames).toEqual(['example.com'])
  })
})
