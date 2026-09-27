export type BatchError = { index: number; error: unknown };

// Run up to `limit` async worker loops in parallel, each pulling the
// next item from a shared cursor until the queue is drained. Errors
// from individual items are captured (not rethrown) so a single bad
// item does not abort the rest of the batch — they land in `errors`
// indexed by their position in `items`. Returns results in input
// order; failed items are `undefined`.
export async function runBatchWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: Array<R | undefined>; errors: BatchError[] }> {
  if (items.length === 0) return { results: [], errors: [] };
  const cap = Math.max(1, Math.min(limit, items.length));
  const results: Array<R | undefined> = new Array(items.length);
  const errors: BatchError[] = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        errors.push({ index: idx, error: err });
      }
    }
  };

  const workers = Array.from({ length: cap }, () => worker());
  await Promise.all(workers);
  return { results, errors };
}
