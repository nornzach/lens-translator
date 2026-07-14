import type { TranslateBlock } from '../shared/messages'

export type BatchFlushFn = (blocks: TranslateBlock[]) => Promise<void>

/**
 * Coalesces rapid `enqueue` calls into a single `flush` within a time window.
 * When the lens sweeps over N paragraphs quickly, only one `translate-batch`
 * message reaches the service worker instead of N.
 *
 * Deduplication by block id happens here; content-level inflight tracking
 * still applies inside the flush callback.
 */
export class TranslationBatcher {
  private readonly pending = new Map<string, TranslateBlock>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flush: BatchFlushFn,
    private readonly windowMs = 80,
  ) {}

  enqueue(block: TranslateBlock): void {
    this.pending.set(block.id, block)
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      const blocks = [...this.pending.values()]
      this.pending.clear()
      if (blocks.length) void this.flush(blocks)
    }, this.windowMs)
  }
}
