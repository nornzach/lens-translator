import type { TranslateBlock } from './messages'

export function splitIntoBatches(
  blocks: TranslateBlock[],
  charLimit: number,
  maxBlocks: number,
): TranslateBlock[][] {
  const batches: TranslateBlock[][] = []
  let current: TranslateBlock[] = []
  let chars = 0

  for (const b of blocks) {
    const len = b.text.length
    const wouldExceed =
      current.length > 0 &&
      (current.length >= maxBlocks || chars + len > charLimit)

    if (wouldExceed) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(b)
    chars += len
  }
  if (current.length) batches.push(current)
  return batches
}
