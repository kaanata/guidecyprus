import type { Collection, KV, QueryOptions } from "../../src/lib/store";
import type { Ad, DailyStat, EventRecord } from "../../src/lib/types";

type Row = Record<string, unknown>;

function matches(data: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = data[key] as string | number | undefined;
    if (condition !== null && typeof condition === "object") {
      const c = condition as Record<string, unknown>;
      if (Array.isArray(c.in)) return c.in.includes(value);
      if ("gte" in c && !(value !== undefined && value >= (c.gte as string | number))) return false;
      if ("gt" in c && !(value !== undefined && value > (c.gt as string | number))) return false;
      if ("lte" in c && !(value !== undefined && value <= (c.lte as string | number))) return false;
      if ("lt" in c && !(value !== undefined && value < (c.lt as string | number))) return false;
      return true;
    }
    return value === condition;
  });
}

export type MemoryCollection<T> = Collection<T> & { rows: Map<string, T> };

export function memoryCollection<T>(): MemoryCollection<T> {
  const rows = new Map<string, T>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async put(id, data) {
      rows.set(id, structuredClone(data));
    },
    async delete(id) {
      return rows.delete(id);
    },
    async getMany(ids) {
      const found = new Map<string, T>();
      for (const id of ids) {
        const row = rows.get(id);
        if (row !== undefined) found.set(id, row);
      }
      return found;
    },
    async putMany(items) {
      for (const { id, data } of items) rows.set(id, structuredClone(data));
    },
    async deleteMany(ids) {
      let removed = 0;
      for (const id of ids) if (rows.delete(id)) removed++;
      return removed;
    },
    async query(options: QueryOptions = {}) {
      const list = Array.from(rows, ([id, data]) => ({ id, data })).filter((row) =>
        matches(row.data as Row, options.where),
      );
      const [key, direction] = Object.entries(options.orderBy ?? {})[0] ?? [];
      if (key) {
        list.sort((a, b) => {
          const x = (a.data as Row)[key] as string | number;
          const y = (b.data as Row)[key] as string | number;
          return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1);
        });
      }
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 50;
      const hasMore = start + limit < list.length;
      return { items: list.slice(start, start + limit), hasMore, cursor: hasMore ? String(start + limit) : undefined };
    },
  };
}

export type MemoryKV = KV & { data: Map<string, unknown> };

export function memoryKV(): MemoryKV {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return (data.has(key) ? data.get(key) : null) as T | null;
    },
    async set(key: string, value: unknown) {
      data.set(key, value);
    },
  };
}

export function memoryStores() {
  return {
    ads: memoryCollection<Ad>(),
    events: memoryCollection<EventRecord>(),
    stats: memoryCollection<DailyStat>(),
    kv: memoryKV(),
  };
}
