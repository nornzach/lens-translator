import { describe, expect, it } from 'vitest'
import { ImageRegistry } from '../../src/content/image-registry'

describe('ImageRegistry', () => {
  it('reuses a translation for separate images with the same resource URL', () => {
    // Registry only uses these as identity keys; no DOM methods are invoked.
    const firstImage = {} as HTMLImageElement
    const secondImage = {} as HTMLImageElement
    const registry = new ImageRegistry()

    registry.upsert('first', firstImage, 'https://images.example.test/banner.png')
    registry.setTranslation('first', '夏季促销')
    const second = registry.upsert('second', secondImage, 'https://images.example.test/banner.png')
    expect(second).toMatchObject({ status: 'ready', translation: '夏季促销' })
  })

  it('prunes detached images and stays within its entry bound', () => {
    const registry = new ImageRegistry(2, 2)
    const detached = { isConnected: false } as HTMLImageElement
    const connectedA = { isConnected: true } as HTMLImageElement
    const connectedB = { isConnected: true } as HTMLImageElement

    registry.upsert('detached', detached, 'https://images.example.test/old.png')
    registry.upsert('a', connectedA, 'https://images.example.test/a.png')
    registry.upsert('b', connectedB, 'https://images.example.test/b.png')

    expect(registry.get('detached')).toBeUndefined()
    expect(registry.get('a')).toBeDefined()
    expect(registry.get('b')).toBeDefined()
  })
})
