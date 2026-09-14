import 'server-only'

// FIFO inference queue — ensures only one LLM call runs at a time.
// Local models (Ollama) cannot handle concurrent requests reliably on
// low-RAM machines; the queue serialises them so memory pressure stays
// bounded and latency measurements remain honest.

let tail: Promise<unknown> = Promise.resolve()
let pending = 0

export function inferenceQueueLength(): number {
  return pending
}

export async function withInferenceQueue<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1
  const run = tail.then(() => fn())
  tail = run.then(
    () => { pending = Math.max(0, pending - 1) },
    () => { pending = Math.max(0, pending - 1) },
  )
  return run
}
