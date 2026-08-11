/** Runs `worker` over `items` with a bounded number of concurrent tasks. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export function fulfilled<R>(results: Array<PromiseSettledResult<R>>): R[] {
  return results.filter((r): r is PromiseFulfilledResult<R> => r.status === 'fulfilled').map((r) => r.value);
}

export function rejections<R>(results: Array<PromiseSettledResult<R>>): Error[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
}

/** Rejects with a TimeoutError if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
