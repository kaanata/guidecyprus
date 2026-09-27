import type { Ad, DailyStat, EventRecord } from "./types";

export interface QueryOptions {
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: Array<{ id: string; data: T }>;
  cursor?: string;
  hasMore: boolean;
}

/** The subset of EmDash's StorageCollection this plugin uses. */
export interface Collection<T> {
  get(id: string): Promise<T | null>;
  put(id: string, data: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  getMany(ids: string[]): Promise<Map<string, T>>;
  putMany(items: Array<{ id: string; data: T }>): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  query(options?: QueryOptions): Promise<Page<T>>;
}

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

export interface Stores {
  ads: Collection<Ad>;
  events: Collection<EventRecord>;
  stats: Collection<DailyStat>;
  kv: KV;
}

/** EmDash types plugin storage loosely; narrow it once here. */
export function storesOf(ctx: { storage: unknown; kv: unknown }): Stores {
  const storage = ctx.storage as Record<string, unknown>;
  return {
    ads: storage.ads as Collection<Ad>,
    events: storage.events as Collection<EventRecord>,
    stats: storage.stats as Collection<DailyStat>,
    kv: ctx.kv as KV,
  };
}
