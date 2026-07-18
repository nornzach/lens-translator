import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../../src/content/registry'

function element(): Element {
  return { isConnected: true, parentElement: null } as unknown as Element
}

describe('BlockRegistry', () => {
  it('invalidates cached results when the translation engine changes', () => {
    const registry = new BlockRegistry()
    registry.upsert({ id: 'a', el: element(), tag: 'p', text: 'Hello world' })
    registry.setTranslation('a', '你好世界')
    expect(registry.get('a')?.status).toBe('ready')

    registry.resetTranslationsToPending()

    expect(registry.get('a')).toMatchObject({
      status: 'pending',
      translation: undefined,
      error: undefined,
    })
    const duplicate = registry.upsert({
      id: 'b',
      el: element(),
      tag: 'p',
      text: 'Hello world',
    })
    expect(duplicate.status).toBe('pending')
  })
})
