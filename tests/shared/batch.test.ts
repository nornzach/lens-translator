import { describe, it, expect } from 'vitest'
import { splitIntoBatches } from '../../src/shared/batch'
import type { TranslateBlock } from '../../src/shared/messages'

function block(id: string, text: string): TranslateBlock {
  return { id, tag: 'p', text }
}

describe('splitIntoBatches', () => {
  it('keeps small lists in one batch', () => {
    const blocks = [block('a', 'hello world'), block('b', 'another line here')]
    expect(splitIntoBatches(blocks, 6000, 40)).toHaveLength(1)
  })

  it('splits when char limit exceeded', () => {
    const blocks = [
      block('a', 'a'.repeat(100)),
      block('b', 'b'.repeat(100)),
      block('c', 'c'.repeat(100)),
    ]
    const batches = splitIntoBatches(blocks, 150, 40)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat().map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('splits when max blocks exceeded', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => block(String(i), `text ${i} long enough`))
    const batches = splitIntoBatches(blocks, 100000, 2)
    expect(batches).toHaveLength(3)
  })
})
