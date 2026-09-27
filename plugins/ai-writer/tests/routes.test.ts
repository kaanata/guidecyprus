import { describe, expect, it, vi } from "vitest";
import type { ContentHandlers, CreateBody } from "../src/lib/content";
import { MINIMAX_CATALOG, type Provider } from "../src/lib/providers";
import { createRouteHandlers, RouteError, type RouteDeps } from "../src/lib/routes";
import { defaultSettings, SETTINGS_KEY } from "../src/lib/settings";
import { chatResponse, jsonResponse, memoryKv, minimaxTextSettings } from "./helpers";

const TERMS = {
  category: [{ slug: "news", label: "News" }],
  tag: [{ slug: "tea", label: "Tea" }],
};

function makeDeps(opts: { replies?: string[]; existing?: boolean } & Partial<RouteDeps> = {}) {
  return makeDepsBase(opts);
}

function makeDepsBase(opts: { replies?: string[]; existing?: boolean } & Partial<RouteDeps> = {}) {
  const { replies: initial = [], existing = false, ...overrides } = opts;
  const replies = [...initial];
  const nextReply = () => (replies.length > 1 ? (replies.shift() as string) : (replies[0] ?? ""));
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("/chat/completions")) return chatResponse(nextReply());
    if (url.endsWith("/images/models")) return jsonResponse({ data: [{ id: "img/a" }] });
    if (url.endsWith("/images")) return jsonResponse({ data: [{ b64_json: btoa("img"), media_type: "image/png" }] });
    return jsonResponse({ data: [{ id: "txt/a" }] });
  });
  const created: CreateBody[] = [];
  const content: ContentHandlers = {
    get: vi.fn(async (_collection: string, _slug: string, _locale?: string) =>
      existing
        ? { success: true as const, data: { item: { id: "old" } } }
        : { success: false as const, error: { code: "NOT_FOUND" } }),
    create: async (_collection: string, body: CreateBody) => {
      created.push(body);
      return { success: true as const, data: { item: { id: "p1" } } };
    },
    publish: vi.fn(async (_collection: string, _id: string) => ({ success: true as const, data: {} })),
    update: vi.fn(async (_c: string, id: string) => ({ success: true as const, data: { item: { id } } })),
  };
  const runs = { put: vi.fn(async (_id: string, _data: Record<string, unknown>) => {}) };
  const media = { upload: vi.fn(async (_f: string, _t: string, _b: ArrayBuffer) => ({ mediaId: "m1", url: "/m1.png" })) };
  const deps: RouteDeps = {
    kv: memoryKv(),
    getApiKey: async () => "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    media,
    getTerms: vi.fn(async (taxonomy: "category" | "tag", _locale?: string) => TERMS[taxonomy]),
    content,
    runs,
    now: () => new Date("2026-09-10T12:00:00Z"),
    ...overrides,
  };
  return { deps, fetchImpl, created, runs, media };
}

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, i = 0) =>
  JSON.parse((fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);

describe("step route", () => {
  it("rejects invalid input with invalid_input", async () => {
    const { deps } = makeDeps();
    await expect(createRouteHandlers(deps).step({ step: "title" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("generates a title with the per-request model", async () => {
    const { deps, fetchImpl } = makeDeps({ replies: ["Brewing Better Tea"] });
    const res = await createRouteHandlers(deps).step({ step: "title", topic: "tea", model: "req/model" });
    expect(res).toEqual({ step: "title", title: "Brewing Better Tea", cost: 0 });
    expect(bodyOf(fetchImpl).model).toBe("req/model");
  });

  it("propagates missing_api_key", async () => {
    const { deps } = makeDeps({
      getApiKey: async () => {
        throw new RouteError("missing_api_key", "no key");
      },
    });
    await expect(createRouteHandlers(deps).step({ step: "title", topic: "tea" })).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });

  it("maps step failures to step_failed", async () => {
    const { deps } = makeDeps({ replies: ['{"headings":["Only one"]}'] });
    await expect(createRouteHandlers(deps).step({ step: "outline", title: "T", count: 4 })).rejects.toMatchObject({
      code: "step_failed",
    });
  });

  it("tags step returns only existing tag slugs", async () => {
    const { deps } = makeDeps({ replies: ['{"tags":["Tea","Ghost"]}'] });
    expect(await createRouteHandlers(deps).step({ step: "tags", title: "T" })).toEqual({ step: "tags", tags: ["tea"], cost: 0 });
  });

  it("writes in the request's locale and picks tags from that locale", async () => {
    const { deps, fetchImpl } = makeDeps({ replies: ["Kıbrıs Plajları", '{"tags":["Tea"]}'] });
    const h = createRouteHandlers(deps);
    await h.step({ step: "title", topic: "Kıbrıs plajları", locale: "tr" });
    expect(bodyOf(fetchImpl).messages.at(-1).content).toContain("in Turkish");
    await h.step({ step: "tags", title: "Kıbrıs Plajları", locale: "tr" });
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
  });

  it("rejects an unknown locale", async () => {
    const { deps } = makeDeps();
    await expect(createRouteHandlers(deps).step({ step: "title", topic: "x", locale: "de" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("settings, models, terms routes", () => {
  it("saveSettings rejects invalid input and persists valid input", async () => {
    const { deps } = makeDeps();
    const h = createRouteHandlers(deps);
    await expect(h.saveSettings({ ...defaultSettings, temperature: 9 })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await h.saveSettings({ ...defaultSettings, tone: "Warm" });
    const got = await h.getSettings();
    expect(got.settings.tone).toBe("Warm");
    expect(got.defaults).toEqual(defaultSettings);
  });

  it("models returns every provider's catalog with the saved providers", async () => {
    const { deps } = makeDeps();
    const r = await createRouteHandlers(deps).models();
    expect(r.providers).toEqual({ text: "openrouter", image: "openrouter" });
    expect(r.catalogs.openrouter).toEqual({
      text: [{ id: "txt/a", name: "txt/a" }],
      image: [{ id: "img/a", name: "img/a" }],
    });
    expect(r.catalogs.minimax).toEqual(MINIMAX_CATALOG);
    expect(r.keys).toEqual({ openrouter: true, minimax: true });
  });

  it("terms returns categories and tags of one locale with the collection's features", async () => {
    const { deps } = makeDeps();
    expect(await createRouteHandlers(deps).terms({})).toEqual({
      ...TERMS,
      features: { featuredImage: true, excerpt: true, seo: false, categories: true, tags: true },
    });
    expect(deps.getTerms).toHaveBeenCalledWith("category", "en");
    await createRouteHandlers(deps).terms({ locale: "tr" });
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
  });

  it("terms leaves out taxonomies the collection does not use", async () => {
    const { deps } = makeDeps({
      getCollectionInfo: async () => ({ fields: ["title", "content"], hasSeo: false, taxonomies: [] }),
    });
    expect(await createRouteHandlers(deps).terms({ collection: "pages" })).toEqual({
      category: [],
      tag: [],
      features: { featuredImage: false, excerpt: false, seo: false, categories: false, tags: false },
    });
  });
});

describe("image route", () => {
  it("generates, uploads, and returns a featured image object", async () => {
    const { deps, media, fetchImpl } = makeDeps();
    const res = await createRouteHandlers(deps).image({ prompt: "Green tea", alt: "Green tea" });
    expect(res.featuredImage).toEqual({ provider: "local", id: "m1", src: "/m1.png", alt: "Green tea" });
    expect(media.upload).toHaveBeenCalledOnce();
    expect(bodyOf(fetchImpl).prompt).toContain("Green tea. Editorial photograph");
  });
});

describe("route costs", () => {
  it("returns what a step and an image cost, and remembers the image model's price", async () => {
    const pricedFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/chat/completions")) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "Brewing Better Tea" } }], usage: { cost: 0.0004 } });
      }
      return jsonResponse({ data: [{ b64_json: btoa("img"), media_type: "image/png" }], usage: { cost: 0.01 } });
    });
    const { deps } = makeDeps({ fetchImpl: pricedFetch as unknown as typeof fetch });
    const h = createRouteHandlers(deps);
    expect((await h.step({ step: "title", topic: "tea" })).cost).toBe(0.0004);
    const img = await h.image({ prompt: "Green tea", model: "meta/muse-image" });
    expect(img.cost).toBe(0.01);
    expect(await deps.kv.get("observed-image-prices")).toEqual({ "meta/muse-image": 0.01 });
  });
});

describe("expressCreate route", () => {
  // Most cases run with no-AI-slop off; its edit has a dedicated case below.
  const slopOff = () => memoryKv({ [SETTINGS_KEY]: { noAiSlop: { enabled: false } } });
  const makeDeps = (opts: Parameters<typeof makeDepsBase>[0] = {}) => makeDepsBase({ kv: slopOff(), ...opts });
  const input = {
    title: "Brewing Better Tea",
    intro: ["Intro."],
    sections: [{ heading: "Water", paragraphs: ["Use fresh water."] }],
    excerpt: "Short.",
    post: { status: "draft", categories: ["news", "ghost"], tags: ["tea"] },
  };

  it("assembles, creates the post with known terms, records a run, and returns the edit URL", async () => {
    const { deps, created, runs } = makeDeps();
    const res = await createRouteHandlers(deps).expressCreate(input);
    expect(res).toEqual({
      postId: "p1",
      slug: "brewing-better-tea",
      status: "draft",
      warnings: ['Unknown category "ghost" skipped'],
      editUrl: "/_emdash/admin/content/posts/p1",
      cost: 0,
    });
    expect(created[0].taxonomies).toEqual({ category: ["news"], tag: ["tea"] });
    expect((created[0].data.content as Array<{ style: string }>).map((b) => b.style)).toEqual(["normal", "h2", "normal"]);
    expect(runs.put).toHaveBeenCalledOnce();
    expect(runs.put.mock.calls[0][1]).toMatchObject({ source: "express", postId: "p1", status: "ok" });
  });

  it("creates a Turkish post in the tr locale with tr terms and Turkish structural headers", async () => {
    const { deps, created } = makeDeps();
    await createRouteHandlers(deps).expressCreate({
      ...input,
      title: "Kıbrıs Plajları",
      outro: ["Hoşça kalın."],
      post: { ...input.post, locale: "tr" },
    });
    expect(deps.content.get).toHaveBeenCalledWith("posts", "kibris-plajlari", "tr");
    expect(deps.getTerms).toHaveBeenCalledWith("category", "tr");
    expect(created[0]).toMatchObject({ slug: "kibris-plajlari", locale: "tr" });
    const texts = (created[0].data.content as Array<{ children: Array<{ text: string }> }>).map((b) => b.children[0].text);
    expect(texts).toContain("Sonuç");
  });

  it("generates SEO meta for a collection with SEO and sends it with the post", async () => {
    const seo = JSON.stringify({ metaTitle: "Better Tea", metaDescription: "How to brew it." });
    const { deps, created, runs } = makeDeps({
      replies: [seo],
      getCollectionInfo: async () => ({ fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] }),
    });
    const res = await createRouteHandlers(deps).expressCreate(input);
    expect(created[0].seo).toEqual({ title: "Better Tea", description: "How to brew it." });
    expect(res.warnings).toEqual(['Unknown category "ghost" skipped']);
    expect(runs.put.mock.calls[0][1]).toMatchObject({ calls: 1, editUrl: "/_emdash/admin/content/posts/p1" });
  });

  it("drops image, excerpt and taxonomies a collection cannot hold", async () => {
    const { deps, created } = makeDeps({
      getCollectionInfo: async () => ({ fields: ["title", "content"], hasSeo: false, taxonomies: [] }),
    });
    const image = { provider: "local" as const, id: "m1", src: "/m1.png", alt: "x" };
    const res = await createRouteHandlers(deps).expressCreate({
      ...input,
      featuredImage: image,
      post: { ...input.post, collection: "pages" },
    });
    expect(created[0].data).toEqual({ title: "Brewing Better Tea", content: expect.any(Array) });
    expect(created[0].taxonomies).toBeUndefined();
    expect(created[0].seo).toBeUndefined();
    expect(res.editUrl).toBe("/_emdash/admin/content/pages/p1");
  });

  it("maps an existing slug to the duplicate code", async () => {
    const { deps } = makeDeps({ existing: true });
    await expect(createRouteHandlers(deps).expressCreate(input)).rejects.toMatchObject({ code: "duplicate" });
  });

  it("rejects a payload without sections", async () => {
    const { deps } = makeDeps();
    await expect(createRouteHandlers(deps).expressCreate({ ...input, sections: [] })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("creates a draft and publishes it when the post status is published", async () => {
    const { deps, created } = makeDeps();
    const res = await createRouteHandlers(deps).expressCreate({ ...input, post: { ...input.post, status: "published" } });
    expect(created[0].status).toBe("draft");
    expect(deps.content.publish).toHaveBeenCalledWith("posts", "p1");
    expect(res.status).toBe("published");
  });

  it("rejects an unknown post status", async () => {
    const { deps } = makeDeps();
    await expect(
      createRouteHandlers(deps).expressCreate({ ...input, post: { ...input.post, status: "scheduled" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("still returns success and includes a warning when run history recording fails", async () => {
    const { deps, created } = makeDeps({
      runs: { put: vi.fn(async () => { throw new Error("KV down"); }) },
    });
    const res = await createRouteHandlers(deps).expressCreate(input);
    expect(res.postId).toBe("p1");
    expect(res.warnings).toContain("Run history could not be recorded: KV down");
    expect(created).toHaveLength(1);
  });

  it("runs the no-AI-slop edit before creating the post when it is on", async () => {
    const edited = JSON.stringify({ excerpt: "Tight.", blocks: [{ i: 0, text: "A sharper intro." }] });
    const { deps, created, runs } = makeDepsBase({ replies: [edited] });
    const res = await createRouteHandlers(deps).expressCreate(input);
    expect((created[0].data.content as Array<{ children: Array<{ text: string }> }>)[0].children[0].text).toBe("A sharper intro.");
    expect(created[0].data.excerpt).toBe("Tight.");
    expect(res.warnings).toEqual(['Unknown category "ghost" skipped']);
    expect(runs.put.mock.calls[0][1]).toMatchObject({ calls: 1 });
  });

  it("creates the post as written with a warning when the edit fails", async () => {
    const { deps, created } = makeDepsBase({ replies: ["not json"] });
    const res = await createRouteHandlers(deps).expressCreate(input);
    expect(created).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^no-AI-slop edit skipped: /);
  });
});

describe("provider wiring", () => {
  it("sends text steps to MiniMax when it is the text provider", async () => {
    const getApiKey = vi.fn(async (_p: Provider) => "k");
    const { deps, fetchImpl } = makeDeps({
      replies: ["Brewing Better Tea"],
      kv: memoryKv({ [SETTINGS_KEY]: minimaxTextSettings }),
      getApiKey,
    });
    expect(await createRouteHandlers(deps).step({ step: "title", topic: "tea" })).toEqual({
      step: "title",
      title: "Brewing Better Tea",
      // MiniMax reports no cost.
      cost: 0,
    });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.minimax.io/v1/chat/completions");
    expect(bodyOf(fetchImpl).model).toBe("MiniMax-M3");
    expect(getApiKey).toHaveBeenCalledWith("minimax");
  });

  it("image route keeps missing_api_key as its error code", async () => {
    const { deps } = makeDeps({
      getApiKey: async () => {
        throw new RouteError("missing_api_key", "no key");
      },
    });
    await expect(createRouteHandlers(deps).image({ prompt: "Green tea" })).rejects.toMatchObject({
      code: "missing_api_key",
    });
  });
});
