
/**
 * Strictly controls the global number of active heavy tasks (Crop + API)
 */
export class AsyncSemaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) resolve();
    } else {
      this.permits++;
    }
  }
}

/**
 * Improved concurrency runner.
 *
 * NEVER rejects: a task that throws is logged and skipped. Callers treat a
 * batch as best-effort and inspect the returned results — previously a single
 * throwing task escaped through `Promise.race` (or `Promise.all`) and aborted
 * the entire run, so one bad image killed a whole batch instead of being
 * retried by the per-item loop.
 *
 * `limit` may be any number >= 1 (values below 1 are clamped).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  signal: AbortSignal,
  staggerMs: number = 0 
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  const maxParallel = Math.max(1, Math.floor(limit) || 1);
  
  for (const item of items) {
    if (signal.aborted) break;
    
    if (staggerMs > 0) {
      await new Promise(resolve => setTimeout(resolve, staggerMs));
    }
    
    if (signal.aborted) break;

    // The promise handed to `executing` settles in every case: `finally`
    // removes it from the set, so `Promise.race` never sees a rejection and
    // the in-flight count stays accurate.
    const p: Promise<void> = task(item)
      .then(
        (res) => { if (!signal.aborted) results.push(res); },
        (err) => { console.error('[runWithConcurrency] task failed:', err); }
      )
      .finally(() => { executing.delete(p); });
    
    executing.add(p);
    
    if (executing.size >= maxParallel) {
      await Promise.race(executing);
    }
  }
  
  // Drain the tail (skipped while aborting so a task that ignores the signal
  // cannot delay the cancel path). Safe either way: every promise has a
  // rejection handler attached, so nothing surfaces as an unhandled rejection.
  if (!signal.aborted) {
    await Promise.all(Array.from(executing));
  }
  return results;
}
