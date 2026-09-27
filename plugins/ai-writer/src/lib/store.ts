// Structural seam over EmDash's plugin StorageCollection so lib code is
// testable with an in-memory fake (tests/helpers.ts memoryStore).
export type StoreQuery = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  cursor?: string;
};

export type StoreLike<T> = {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  query(opts?: StoreQuery): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
};

// EmDash clamps a query page to 100 items.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export async function listAll<T>(store: StoreLike<T>): Promise<Array<{ id: string; data: T }>> {
  const out: Array<{ id: string; data: T }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await store.query({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    out.push(...res.items);
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}
