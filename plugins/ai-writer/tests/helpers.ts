import type { GenerateTextInput, GenerateTextOutput } from "../src/lib/openrouter";
import { defaultSettings, type Settings } from "../src/lib/settings";
import type { StoreQuery } from "../src/lib/store";

/** Valid Settings with MiniMax as the text provider; images stay on OpenRouter. */
export const minimaxTextSettings: Settings = {
  ...defaultSettings,
  providers: { text: "minimax", image: "openrouter" },
  models: { ...defaultSettings.models, defaultText: "MiniMax-M3", fallbackText: "", steps: {} },
};

export function memoryKv(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    map,
    async get<T>(key: string): Promise<T | null> {
      return map.has(key) ? (map.get(key) as T) : null;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
  };
}

/** Text client returning `responses` in order (last one repeats). Objects are sent as JSON. */
export function fakeTextClient(responses: Array<string | object>) {
  const calls: GenerateTextInput[] = [];
  let i = 0;
  return {
    calls,
    client: {
      async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
        calls.push(input);
        const r = responses[Math.min(i++, responses.length - 1)];
        const raw = typeof r === "string" ? r : JSON.stringify(r);
        let json: unknown = raw;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        return { json, raw };
      },
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function chatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { role: "assistant", content } }] });
}

/** In-memory stand-in for an EmDash plugin storage collection (equality `where`, one `orderBy` field, `limit`). */
export function memoryStore<T>(initial: Record<string, T> = {}) {
  const map = new Map<string, T>(Object.entries(initial).map(([id, data]) => [id, structuredClone(data)]));
  const field = (data: T, key: string) => (data as unknown as Record<string, unknown>)[key];
  return {
    map,
    async get(id: string): Promise<T | null> {
      return map.has(id) ? structuredClone(map.get(id) as T) : null;
    },
    async put(id: string, data: T): Promise<void> {
      map.set(id, structuredClone(data));
    },
    async delete(id: string): Promise<boolean> {
      return map.delete(id);
    },
    async query(opts: StoreQuery = {}) {
      let items = [...map.entries()].map(([id, data]) => ({ id, data: structuredClone(data) }));
      const where = opts.where ?? {};
      items = items.filter((item) => Object.entries(where).every(([k, v]) => field(item.data, k) === v));
      const [orderField, direction] = Object.entries(opts.orderBy ?? {})[0] ?? [];
      if (orderField) {
        items.sort((a, b) => {
          const cmp = String(field(a.data, orderField) ?? "").localeCompare(String(field(b.data, orderField) ?? ""));
          return direction === "desc" ? -cmp : cmp;
        });
      }
      return { items: items.slice(0, opts.limit ?? 50), hasMore: false };
    },
  };
}
