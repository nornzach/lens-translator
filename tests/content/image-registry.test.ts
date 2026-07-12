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
})
