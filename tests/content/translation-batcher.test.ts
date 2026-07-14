import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TranslationBatcher } from '../../src/content/translation-batcher'

describe('TranslationBatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces calls within the window into one flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const batcher = new TranslationBatcher(flush, 80)

    batcher.enqueue({ id: 'a', tag: 'p', text: 'Hello' })
    batcher.enqueue({ id: 'b', tag: 'p', text: 'World' })
    batcher.enqueue({ id: 'a', tag: 'p', text: 'Hello' }) // duplicate id — deduped

    await vi.runAllTimersAsync()

    expect(flush).toHaveBeenCalledOnce()
    const [blocks] = flush.mock.calls[0]
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b: { id: string }) => b.id).sort()).toEqual(['a', 'b'])
  })

  it('does not flush if nothing was enqueued', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    new TranslationBatcher(flush, 80)
    await vi.runAllTimersAsync()
    expect(flush).not.toHaveBeenCalled()
  })

  it('accepts a second batch after the first window closes', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const batcher = new TranslationBatcher(flush, 80)

    batcher.enqueue({ id: 'x', tag: 'p', text: 'First' })
    await vi.runAllTimersAsync()
    expect(flush).toHaveBeenCalledOnce()

    batcher.enqueue({ id: 'y', tag: 'p', text: 'Second' })
    await vi.runAllTimersAsync()
    expect(flush).toHaveBeenCalledTimes(2)
    const [blocks] = flush.mock.calls[1]
    expect(blocks[0].id).toBe('y')
  })

  it('last enqueue wins for duplicate ids', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const batcher = new TranslationBatcher(flush, 80)

    batcher.enqueue({ id: 'a', tag: 'p', text: 'first' })
    batcher.enqueue({ id: 'a', tag: 'h2', text: 'second' })
    await vi.runAllTimersAsync()

    const [blocks] = flush.mock.calls[0]
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('second')
  })
})
