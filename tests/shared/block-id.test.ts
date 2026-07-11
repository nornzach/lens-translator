import { describe, it, expect } from 'vitest'
import { makeBlockId } from '../../src/shared/block-id'

describe('makeBlockId', () => {
  it('is stable for same inputs', () => {
    const a = makeBlockId('p', 'Hello world', '/body/div[1]/p[2]')
    const b = makeBlockId('p', 'Hello world', '/body/div[1]/p[2]')
    expect(a).toBe(b)
    expect(a.startsWith('b_')).toBe(true)
  })

  it('changes when text changes', () => {
    const a = makeBlockId('p', 'Hello', '/x')
    const b = makeBlockId('p', 'Hello!', '/x')
    expect(a).not.toBe(b)
  })

  it('normalizes text before hashing', () => {
    const a = makeBlockId('p', 'Hello   world', '/x')
    const b = makeBlockId('p', 'Hello world', '/x')
    expect(a).toBe(b)
  })
})
