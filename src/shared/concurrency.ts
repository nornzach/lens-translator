/**
 * Run `worker` over `items` with at most `limit` in flight. Items start in
 * queue order; each settles independently, so per-item latency never holds
 * back the rest of the queue.
 * Contract: `worker` must handle its own errors and never reject.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice()
  const runNext = async (): Promise<void> => {
    const item = queue.shift()
    if (item === undefined) return
    await worker(item)
    await runNext()
  }
  const runners: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runNext())
  await Promise.all(runners)
}
