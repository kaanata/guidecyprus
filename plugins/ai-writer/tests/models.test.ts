import { describe, expect, it, vi } from "vitest";
import { CATALOG_KEY, CATALOG_TTL_MS, getCatalog, getModelsResponse, resolveModel } from "../src/lib/models";
import { MINIMAX_CATALOG, type Provider } from "../src/lib/providers";
import { defaultSettings } from "../src/lib/settings";
import { jsonResponse, memoryKv } from "./helpers";

const models = { ...defaultSettings.models, steps: { outline: "step/outline" } };

describe("resolveModel", () => {
  const provider = "openrouter" as const;

  it("uses the Settings default text model when nothing else is set", () => {
    expect(resolveModel("title", { settings: models, provider })).toEqual({
      model: "meta/muse-spark-1.3-contributor",
      fallbacks: ["qwen/qwen3.8-flash"],
    });
  });

  it("prefers the Settings per-step model over the default", () => {
    expect(resolveModel("outline", { settings: models, provider }).model).toBe("step/outline");
  });

  it("prefers a rule override over the per-step model", () => {
    expect(resolveModel("outline", { settings: models, provider, rule: { outline: "rule/outline" } }).model).toBe(
      "rule/outline",
    );
  });

  it("prefers the per-request model over everything", () => {
    expect(
      resolveModel("outline", { settings: models, provider, rule: { outline: "rule/outline" }, request: "req/x" })
        .model,
    ).toBe("req/x");
  });

  it("ignores blank strings at every level", () => {
    expect(resolveModel("outline", { settings: models, provider, rule: { outline: " " }, request: "" }).model).toBe(
      "step/outline",
    );
  });

  it("drops the fallback when it equals the chosen model or is empty", () => {
    expect(resolveModel("title", { settings: models, provider, request: "qwen/qwen3.8-flash" }).fallbacks).toEqual(
      [],
    );
    expect(resolveModel("title", { settings: { ...models, fallbackText: "" }, provider }).fallbacks).toEqual([]);
  });

  it("resolves the image slot from image sources only, with no fallback", () => {
    expect(resolveModel("image", { settings: models, provider })).toEqual({
      model: "bytedance-seed/seedream-5-0-lite",
      fallbacks: [],
    });
    expect(resolveModel("image", { settings: models, provider, rule: { image: "rule/img" } }).model).toBe("rule/img");
    expect(
      resolveModel("image", { settings: models, provider, rule: { image: "rule/img" }, request: "req/img" }).model,
    ).toBe("req/img");
  });

  it("skips ids that belong to the other provider at every override level", () => {
    expect(resolveModel("outline", { settings: models, provider, request: "MiniMax-M3" }).model).toBe("step/outline");
    expect(resolveModel("outline", { settings: models, provider, rule: { outline: "MiniMax-M3" } }).model).toBe(
      "step/outline",
    );
    expect(
      resolveModel("title", { settings: { ...models, steps: { title: "MiniMax-M3" } }, provider }).model,
    ).toBe("meta/muse-spark-1.3-contributor");
  });

  it("resolves MiniMax ids when MiniMax is the provider", () => {
    const mm = {
      defaultText: "MiniMax-M3",
      fallbackText: "MiniMax-M2.7",
      defaultImage: "image-01",
      steps: { outline: "MiniMax-M2.5" },
    };
    expect(resolveModel("outline", { settings: mm, provider: "minimax" })).toEqual({
      model: "MiniMax-M2.5",
      fallbacks: ["MiniMax-M2.7"],
    });
    expect(resolveModel("outline", { settings: mm, provider: "minimax", rule: { outline: "google/x" } }).model).toBe(
      "MiniMax-M2.5",
    );
    expect(resolveModel("image", { settings: mm, provider: "minimax", rule: { image: "bytedance/x" } }).model).toBe(
      "image-01",
    );
  });

  it("drops a fallback model that belongs to the other provider", () => {
    const mm = { defaultText: "MiniMax-M3", fallbackText: "qwen/qwen3.8-flash", defaultImage: "image-01", steps: {} };
    expect(resolveModel("title", { settings: mm, provider: "minimax" }).fallbacks).toEqual([]);
  });
});

describe("getCatalog", () => {
  const fetchImpl = vi.fn(async (url: string) =>
    url.endsWith("/images/models")
      ? jsonResponse({ data: [{ id: "img/a", name: "Img A" }] })
      : jsonResponse({ data: [{ id: "txt/a", name: "Txt A" }] }),
  );

  it("fetches both catalogs and caches them with a timestamp", async () => {
    fetchImpl.mockClear();
    const kv = memoryKv();
    const c = await getCatalog(kv, "k", { fetchImpl: fetchImpl as unknown as typeof fetch, now: 1000 });
    expect(c).toEqual({
      text: [{ id: "txt/a", name: "Txt A" }],
      image: [{ id: "img/a", name: "Img A" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(kv.map.get(CATALOG_KEY)).toMatchObject({ fetchedAt: 1000 });
  });

  it("serves from cache within the TTL", async () => {
    fetchImpl.mockClear();
    const kv = memoryKv({ [CATALOG_KEY]: { text: [], image: [], fetchedAt: 1000 } });
    await getCatalog(kv, "k", { fetchImpl: fetchImpl as unknown as typeof fetch, now: 1000 + CATALOG_TTL_MS - 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refetches once the TTL has passed", async () => {
    fetchImpl.mockClear();
    const kv = memoryKv({ [CATALOG_KEY]: { text: [], image: [], fetchedAt: 1000 } });
    await getCatalog(kv, "k", { fetchImpl: fetchImpl as unknown as typeof fetch, now: 1000 + CATALOG_TTL_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("getModelsResponse", () => {
  const providers = { text: "minimax" as const, image: "openrouter" as const };
  const catalogFetch = () =>
    vi.fn(async (url: string) =>
      url.endsWith("/images/models")
        ? jsonResponse({ data: [{ id: "img/a", name: "Img A" }] })
        : jsonResponse({ data: [{ id: "txt/a", name: "Txt A" }] }),
    );

  it("returns every provider's catalog and which keys are bound", async () => {
    const fetchImpl = catalogFetch();
    const r = await getModelsResponse({
      kv: memoryKv(),
      providers,
      getApiKey: async () => "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1000,
    });
    expect(r).toEqual({
      providers,
      catalogs: {
        openrouter: { text: [{ id: "txt/a", name: "Txt A" }], image: [{ id: "img/a", name: "Img A" }] },
        minimax: MINIMAX_CATALOG,
      },
      keys: { openrouter: true, minimax: true },
      errors: {},
      imagePrices: {},
    });
  });

  it("skips the OpenRouter fetch when its key is missing", async () => {
    const fetchImpl = catalogFetch();
    const r = await getModelsResponse({
      kv: memoryKv(),
      providers,
      getApiKey: async (p: Provider) => {
        if (p === "openrouter") throw new Error("OPENROUTER_API_KEY is not bound");
        return "k";
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1000,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.keys).toEqual({ openrouter: false, minimax: true });
    expect(r.catalogs.openrouter).toEqual({ text: [], image: [] });
    expect(r.errors).toEqual({});
  });

  it("reports a missing MiniMax key without failing", async () => {
    const fetchImpl = catalogFetch();
    const r = await getModelsResponse({
      kv: memoryKv(),
      providers,
      getApiKey: async (p: Provider) => {
        if (p === "minimax") throw new Error("MINIMAX_API_KEY is not bound");
        return "k";
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1000,
    });
    expect(r.keys).toEqual({ openrouter: true, minimax: false });
    expect(r.catalogs.minimax).toEqual(MINIMAX_CATALOG);
    expect(r.errors).toEqual({});
  });

  it("reports an OpenRouter catalog failure instead of failing", async () => {
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    const r = await getModelsResponse({
      kv: memoryKv(),
      providers,
      getApiKey: async () => "k",
      fetchImpl: failing as unknown as typeof fetch,
      now: 1000,
    });
    expect(r.catalogs.openrouter).toEqual({ text: [], image: [] });
    expect(r.errors.openrouter).toMatch(/503/);
    expect(r.catalogs.minimax).toEqual(MINIMAX_CATALOG);
  });
});
