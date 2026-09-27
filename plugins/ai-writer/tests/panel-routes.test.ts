import { describe, expect, it, vi } from "vitest";
import type { ContentEntry, ContentHandlers, UpdateBody } from "../src/lib/content";
import { createPanelHandlers, PANEL_ROUTE_PERMISSION, type PanelRouteDeps } from "../src/lib/panel-routes";
import type { Provider } from "../src/lib/providers";
import { RouteError } from "../src/lib/routes";
import { SETTINGS_KEY } from "../src/lib/settings";
import { chatResponse, jsonResponse, memoryKv, minimaxTextSettings } from "./helpers";

const ENTRY: ContentEntry = {
  id: "e1",
  status: "published",
  data: { title: "Green Tea Guide", excerpt: "Old.", content: [] },
};

const TAGS = [
  { slug: "tea", label: "Tea" },
  { slug: "health", label: "Health" },
];

const POSTS_INFO = { fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] };

function setup(opts: { entry?: ContentEntry | null; replies?: string[]; updateOk?: boolean } = {}) {
  const entry = opts.entry === undefined ? ENTRY : opts.entry;
  const replies = [...(opts.replies ?? ["Brewing Green Tea Right"])];
  const nextReply = () => (replies.length > 1 ? (replies.shift() as string) : (replies[0] ?? ""));
  const fetchImpl = vi.fn(async (url: string) =>
    url.endsWith("/chat/completions") ? chatResponse(nextReply()) : jsonResponse({ data: [] }),
  );
  const updates: Array<{ collection: string; id: string; body: UpdateBody }> = [];
  const content: Pick<ContentHandlers, "get" | "update"> = {
    get: vi.fn(async () =>
      entry
        ? { success: true as const, data: { item: entry } }
        : { success: false as const, error: { code: "NOT_FOUND", message: "Content not found" } },
    ),
    update: vi.fn(async (collection: string, id: string, body: UpdateBody) => {
      updates.push({ collection, id, body });
      return opts.updateOk === false
        ? { success: false as const, error: { message: "Validation failed" } }
        : { success: true as const, data: { item: { ...ENTRY } } };
    }),
  };
  const runs = { put: vi.fn(async (_id: string, _data: Record<string, unknown>) => {}) };
  const deps: PanelRouteDeps = {
    kv: memoryKv(),
    getApiKey: async () => "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    content,
    getTerms: vi.fn(async (_taxonomy: "category" | "tag", _locale?: string) => TAGS),
    getEntryTerms: vi.fn(async (_c: string, _id: string, _taxonomy: string, _locale?: string) => [TAGS[0]]),
    getCollectionInfo: async () => POSTS_INFO,
    runs,
    now: () => new Date("2026-09-11T12:00:00Z"),
  };
  return { h: createPanelHandlers(deps), deps, updates, runs };
}

describe("panel route permission", () => {
  it("lets Editors call the panel routes", () => {
    expect(PANEL_ROUTE_PERMISSION).toBe("content:edit_any");
  });
});

describe("panel/generate", () => {
  it("returns generated values and records a panel run", async () => {
    const { h, runs } = setup();
    const result = await h.generate({ collection: "posts", id: "e1", fields: ["title"] });
    expect(result.values).toEqual({ title: "Brewing Green Tea Right" });
    expect(result.errors).toEqual({});
    expect(runs.put).toHaveBeenCalledOnce();
    expect(runs.put.mock.calls[0][0]).toMatch(/^panel-/);
    expect(runs.put.mock.calls[0][1]).toMatchObject({
      source: "panel",
      postId: "e1",
      topic: "Green Tea Guide",
      status: "ok",
      calls: 1,
      editUrl: "/_emdash/admin/content/posts/e1",
      startedAt: "2026-09-11T12:00:00.000Z",
    });
  });

  it("writes in the entry's locale and reads only that locale's tags", async () => {
    const { h, deps } = setup({ entry: { ...ENTRY, locale: "tr" }, replies: ['{"tags":["Health"]}'] });
    await h.generate({ collection: "posts", id: "e1", fields: ["tags"], locale: "en" });
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
    expect(deps.getEntryTerms).toHaveBeenCalledWith("posts", "e1", "tag", "tr");

    const title = setup({ entry: { ...ENTRY, locale: "tr" } });
    await title.h.generate({ collection: "posts", id: "e1", fields: ["title"] });
    const fetchImpl = title.deps.fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).content).toContain("in Turkish");
  });

  it("uses the editor's locale when the entry carries none", async () => {
    const { h, deps } = setup({ replies: ['{"tags":["Health"]}'] });
    await h.generate({ collection: "posts", id: "e1", fields: ["tags"], locale: "tr" });
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
  });

  it("marks the run as an error when every requested field failed", async () => {
    const { h, runs } = setup({ replies: [""] });
    const result = await h.generate({ collection: "posts", id: "e1", fields: ["title"] });
    expect(result.errors.title).toBeDefined();
    expect(runs.put.mock.calls[0][1]).toMatchObject({ status: "error" });
    expect(String(runs.put.mock.calls[0][1].error)).toMatch(/^title: /);
  });

  it("keeps the result and warns when run history cannot be written", async () => {
    const { h, deps } = setup();
    deps.runs = { put: async () => { throw new Error("KV down"); } };
    const result = await createPanelHandlers(deps).generate({ collection: "posts", id: "e1", fields: ["title"] });
    expect(result.values.title).toBe("Brewing Green Tea Right");
    expect(result.warnings).toContain("Run history could not be recorded: KV down");
    void h;
  });

  it("rejects bad input, missing entries and untitled posts", async () => {
    await expect(setup().h.generate({ collection: "posts", id: "e1", fields: [] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(setup({ entry: null }).h.generate({ collection: "posts", id: "e1", fields: ["title"] })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      setup({ entry: { id: "e1", data: { title: "" } } }).h.generate({ collection: "posts", id: "e1", fields: ["title"] }),
    ).rejects.toMatchObject({ code: "invalid_input", message: "Save the post with a title before generating" });
  });
});

describe("panel/apply", () => {
  it("updates only the kept fields, merging known tags with the post's tags", async () => {
    const { h, updates } = setup();
    const res = await h.apply({
      collection: "posts",
      id: "e1",
      values: { title: "New Title", tags: ["health", "ghost"], seo: { metaTitle: "MT", metaDescription: "MD" } },
    });
    expect(res).toEqual({ ok: true, status: "published" });
    expect(updates).toEqual([
      {
        collection: "posts",
        id: "e1",
        body: {
          data: { title: "New Title" },
          taxonomies: { tag: ["tea", "health"] },
          seo: { title: "MT", description: "MD" },
        },
      },
    ]);
  });

  it("checks and merges tags within the entry's locale", async () => {
    const { h, deps } = setup({ entry: { ...ENTRY, locale: "tr" } });
    await h.apply({ collection: "posts", id: "e1", values: { tags: ["health"] } });
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
    expect(deps.getEntryTerms).toHaveBeenCalledWith("posts", "e1", "tag", "tr");
  });

  it("writes only what a page can hold: no image, tags or SEO", async () => {
    const { deps, updates } = setup();
    const h = createPanelHandlers({
      ...deps,
      getCollectionInfo: async () => ({ fields: ["title", "content"], hasSeo: false, taxonomies: [] }),
    });
    const featuredImage = { provider: "local", id: "m1", src: "/m1.png", alt: "Tea" };
    await h.apply({
      collection: "pages",
      id: "e1",
      values: { title: "About Cyprus", featuredImage, seo: { metaTitle: "MT", metaDescription: "MD" } },
    });
    expect(updates[0].body).toEqual({ data: { title: "About Cyprus" } });
  });

  it("refuses an update with nothing left to apply", async () => {
    const { h, updates } = setup();
    await expect(h.apply({ collection: "posts", id: "e1", values: {} })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.apply({ collection: "posts", id: "e1", values: { tags: ["ghost"] } })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(updates).toEqual([]);
  });

  it("maps a failed update and a missing entry", async () => {
    await expect(
      setup({ updateOk: false }).h.apply({ collection: "posts", id: "e1", values: { title: "T" } }),
    ).rejects.toMatchObject({ code: "update_failed", message: "Validation failed" });
    await expect(setup({ entry: null }).h.apply({ collection: "posts", id: "e1", values: { title: "T" } })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects malformed values", async () => {
    await expect(
      setup().h.apply({ collection: "posts", id: "e1", values: { content: [{ _type: "image" }] } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("panel provider wiring", () => {
  it("generates with the text provider's client and key", async () => {
    const { deps } = setup();
    await deps.kv.set(SETTINGS_KEY, minimaxTextSettings);
    const getApiKey = vi.fn(async (_p: Provider) => "k");
    deps.getApiKey = getApiKey;
    const fetchImpl = deps.fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const result = await createPanelHandlers(deps).generate({ collection: "posts", id: "e1", fields: ["title"] });
    expect(result.values).toEqual({ title: "Brewing Green Tea Right" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.minimax.io/v1/chat/completions");
    expect(getApiKey).toHaveBeenCalledWith("minimax");
  });

  it("fails with missing_api_key when the text key is not bound", async () => {
    const { deps } = setup();
    deps.getApiKey = async () => {
      throw new RouteError("missing_api_key", "no key");
    };
    await expect(
      createPanelHandlers(deps).generate({ collection: "posts", id: "e1", fields: ["title"] }),
    ).rejects.toMatchObject({ code: "missing_api_key" });
  });
});

describe("panel collection features", () => {
  it("reports what the collection can hold so the panel can hide the rest", async () => {
    const { deps } = setup();
    const h = createPanelHandlers({
      ...deps,
      getCollectionInfo: async (c) => (c === "pages" ? { fields: ["title", "content"], hasSeo: false, taxonomies: [] } : POSTS_INFO),
    });
    expect(await h.features({ collection: "pages" })).toEqual({
      featuredImage: false,
      excerpt: false,
      seo: false,
      categories: false,
      tags: false,
    });
    expect((await h.features({ collection: "posts" })).seo).toBe(true);
  });

  it("treats a failed schema lookup as unknown: no SEO write, everything else allowed", async () => {
    const { deps, updates } = setup();
    const h = createPanelHandlers({
      ...deps,
      getCollectionInfo: async () => {
        throw new Error("schema unavailable");
      },
    });
    await h.apply({ collection: "posts", id: "e1", values: { title: "T", seo: { metaTitle: "MT", metaDescription: "MD" } } });
    expect(updates[0].body).toEqual({ data: { title: "T" } });
  });
});
