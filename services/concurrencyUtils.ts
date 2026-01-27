
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
 * Improved concurrency runner
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
  
  for (const item of items) {
    if (signal.aborted) break;
    
    await new Promise(resolve => setTimeout(resolve, staggerMs > 0 ? staggerMs : 0));
    
    if (signal.aborted) break;

    const p = task(item).then((res) => {
      if (!signal.aborted) results.push(res);
    });
    
    executing.add(p);
    
    const cleanP = p.catch(() => {}).then(() => {
        executing.delete(p);
    });
    
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  
  if (!signal.aborted) {
      await Promise.all(executing);
  }
  return results;
}
