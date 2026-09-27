import { describe, expect, it, vi } from "vitest";
import {
  bulkPrompt,
  createBulkHandlers,
  editEntry,
  fromSimpleBlocks,
  parseEdited,
  toSimpleBlocks,
} from "../src/lib/bulk-edit";
import type { ContentEntry, ContentHandlers, CreateBody, UpdateBody } from "../src/lib/content";
import { defaultSettings } from "../src/lib/settings";
import { chatResponse, fakeTextClient, memoryKv, memoryStore } from "./helpers";

const pt = (style: string, text: string, listItem?: string) => ({
  _type: "block",
  _key: text,
  style,
  markDefs: [],
  ...(listItem ? { listItem } : {}),
  children: [{ _type: "span", _key: `${text}s`, text, marks: [] }],
});

const ENTRY: ContentEntry = {
  id: "p1",
  locale: "en",
  data: {
    title: "Cyprus Beaches",
    excerpt: "Old excerpt.",
    content: [pt("normal", "Intro."), pt("h2", "The Beach"), pt("normal", "Point", "bullet")],
  },
};

const EDITED = {
  title: "Kıbrıs Plajları",
  excerpt: "Yeni özet.",
  blocks: [
    { style: "normal", text: "Giriş." },
    { style: "h2", text: "Plaj" },
    { style: "bullet", text: "Nokta" },
  ],
};

describe("simple blocks", () => {
  it("reads text blocks with their heading and list styles", () => {
    expect(toSimpleBlocks(ENTRY.data?.content)).toEqual([
      { style: "normal", text: "Intro." },
      { style: "h2", text: "The Beach" },
      { style: "bullet", text: "Point" },
    ]);
  });

  it("refuses bodies with non-text blocks", () => {
    expect(toSimpleBlocks([pt("normal", "x"), { _type: "image", asset: {} }])).toBeNull();
  });

  it("builds valid Portable Text back", () => {
    const blocks = fromSimpleBlocks(EDITED.blocks as never);
    expect(blocks[2]).toMatchObject({ style: "normal", listItem: "bullet", level: 1, markDefs: [] });
    expect(blocks[1].children[0]).toEqual({ _type: "span", _key: "b1s0", text: "Plaj", marks: [] });
  });
});

describe("parseEdited", () => {
  it("accepts blocks or content arrays and coerces unknown styles to normal", () => {
    const out = parseEdited({ json: { title: " T ", content: [{ style: "h9", text: "x" }] }, raw: "" });
    expect(out).toEqual({ title: "T", excerpt: "", blocks: [{ style: "normal", text: "x" }] });
  });

  it("reads translated SEO meta when present", () => {
    const out = parseEdited({ json: { ...EDITED, seo: { title: " Plajlar ", description: "Rehber." } }, raw: "" });
    expect(out.seo).toEqual({ title: "Plajlar", description: "Rehber." });
    expect(parseEdited({ json: EDITED, raw: "" }).seo).toBeUndefined();
  });

  it("fails when the model returns no body", () => {
    expect(() => parseEdited({ json: { title: "T", blocks: [] }, raw: "{}" })).toThrow(/no body text/);
  });
});

describe("bulkPrompt", () => {
  it("names the target language and carries instructions and the settings prefix", () => {
    const { system, prompt } = bulkPrompt(
      { action: "translate", targetLocale: "tr", instructions: "Keep place names in their local spelling." },
      { title: "T", excerpt: "", blocks: [] },
      { ...defaultSettings, promptPrefix: "House style." },
    );
    expect(system.startsWith("House style.")).toBe(true);
    expect(prompt).toContain("into Turkish");
    expect(prompt).toContain("Keep place names in their local spelling.");
  });

  it("keeps the post's language for the other actions", () => {
    const { prompt } = bulkPrompt({ action: "rewrite", instructions: "" }, { title: "T", excerpt: "", blocks: [] }, defaultSettings);
    expect(prompt).toContain("Keep the post in its original language");
  });
});

describe("editEntry", () => {
  const settings = { ...defaultSettings, models: { ...defaultSettings.models, fallbackText: "" } };

  it("translates title, excerpt and body", async () => {
    const fake = fakeTextClient([EDITED]);
    const body = await editEntry({ client: fake.client, settings }, ENTRY, {
      action: "translate",
      targetLocale: "tr",
      instructions: "",
      model: "",
    });
    expect(body.data?.title).toBe("Kıbrıs Plajları");
    expect(body.data?.excerpt).toBe("Yeni özet.");
    expect((body.data?.content as unknown[]).length).toBe(3);
    expect(fake.calls[0]).toMatchObject({ model: settings.models.defaultText, responseFormat: { type: "json_object" } });
  });

  it("keeps the title for rewrites and honours a per-request model", async () => {
    const fake = fakeTextClient([EDITED]);
    const body = await editEntry({ client: fake.client, settings }, ENTRY, {
      action: "rewrite",
      instructions: "",
      model: "vendor/other",
    });
    expect(body.data?.title).toBeUndefined();
    expect(fake.calls[0].model).toBe("vendor/other");
  });

  it("refuses posts whose body is not text-only, without calling the model", async () => {
    const fake = fakeTextClient([EDITED]);
    const entry = { ...ENTRY, data: { ...ENTRY.data, content: [{ _type: "image" }] } };
    await expect(
      editEntry({ client: fake.client, settings }, entry, { action: "rewrite", instructions: "", model: "" }),
    ).rejects.toThrow(/images or embeds/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("bulk/edit route", () => {
  function setup(entries: Record<string, ContentEntry>, opts: { reply?: object; updateFails?: string } = {}) {
    const updates: Array<{ id: string; body: UpdateBody }> = [];
    const created: Array<{ collection: string; body: CreateBody }> = [];
    const content: Pick<ContentHandlers, "get" | "update" | "create" | "publish"> = {
      get: vi.fn(async (_c: string, id: string, _locale?: string) =>
        entries[id]
          ? { success: true as const, data: { item: entries[id] } }
          : { success: false as const, error: { message: "Content not found" } },
      ),
      create: vi.fn(async (collection: string, body: CreateBody) => {
        created.push({ collection, body });
        return { success: true as const, data: { item: { id: `tr-${created.length}` } } };
      }),
      publish: vi.fn(),
      update: vi.fn(async (_c: string, id: string, body: UpdateBody) => {
        if (id === opts.updateFails) return { success: false as const, error: { message: "Validation failed" } };
        updates.push({ id, body });
        return { success: true as const, data: { item: entries[id] } };
      }),
    };
    const fetchImpl = vi.fn(async () => chatResponse(JSON.stringify(opts.reply ?? EDITED))) as unknown as typeof fetch;
    const runs = memoryStore<Record<string, unknown>>();
    const terms = {
      category: [{ slug: "beaches", label: "Plajlar" }],
      tag: [{ slug: "summer", label: "Yaz" }],
    };
    const getTerms = vi.fn(async (taxonomy: "category" | "tag", _locale?: string) => terms[taxonomy]);
    const getEntryTerms = vi.fn(async (_c: string, _id: string, taxonomy: string, _locale?: string) =>
      taxonomy === "category"
        ? [{ slug: "beaches", label: "Beaches" }, { slug: "english-only", label: "English only" }]
        : [{ slug: "summer", label: "Summer" }],
    );
    const getCollectionInfo = async () => ({
      fields: ["title", "featured_image", "content", "excerpt"],
      hasSeo: true,
      taxonomies: ["category", "tag"],
    });
    const h = createBulkHandlers({
      kv: memoryKv(),
      getApiKey: async () => "k",
      fetchImpl,
      content,
      runs,
      getTerms,
      getEntryTerms,
      getCollectionInfo,
    });
    return { h, updates, created, runs, content, getTerms, getEntryTerms };
  }

  it("edits every post, reports per-post failures and records runs", async () => {
    const { h, updates, runs } = setup({ p1: ENTRY, p2: { ...ENTRY, id: "p2" }, p3: { ...ENTRY, id: "p3" } }, { updateFails: "p3" });
    const out = await h.edit({ ids: ["p1", "p2", "p2", "missing", "p3"], action: "summarize" });
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.results.map((r) => [r.id, r.status])).toEqual([
      ["p1", "ok"],
      ["p2", "ok"],
      ["missing", "error"],
      ["p3", "error"],
    ]);
    expect(out.results[2].error).toBe("Content not found");
    expect(out.results[3].error).toBe("Validation failed");
    expect(updates.map((u) => u.id)).toEqual(["p1", "p2"]);
    expect(runs.map.size).toBe(4);
    const p1Run = [...runs.map.values()].find((r) => r.postId === "p1");
    expect(p1Run).toMatchObject({
      source: "bulk",
      status: "ok",
      topic: "summarize: Cyprus Beaches",
      editUrl: "/_emdash/admin/content/posts/p1",
    });
  });

  it("translates into a new Turkish sibling linked to the source, instead of overwriting it", async () => {
    const image = { provider: "local", id: "m1", src: "/m1.jpg", alt: "Beach" };
    const source: ContentEntry = {
      ...ENTRY,
      seo: { title: "Cyprus Beaches", description: "Guide." },
      data: { ...ENTRY.data, featured_image: image },
    };
    const reply = { ...EDITED, seo: { title: "Kıbrıs Plajları Rehberi", description: "En iyi plajlar." } };
    const { h, updates, created, runs, content, getTerms, getEntryTerms } = setup({ p1: source }, { reply });
    const out = await h.edit({ ids: ["p1"], action: "translate", targetLocale: "tr" });
    expect(updates).toEqual([]);
    expect(out.results).toEqual([
      expect.objectContaining({
        id: "p1",
        status: "ok",
        createdId: "tr-1",
        warnings: ['Unknown category "english-only" skipped'],
      }),
    ]);
    expect(content.get).toHaveBeenCalledWith("posts", "kibris-plajlari", "tr");
    expect(getEntryTerms).toHaveBeenCalledWith("posts", "p1", "category", "en");
    expect(getTerms).toHaveBeenCalledWith("category", "tr");
    expect(created[0]).toEqual({
      collection: "posts",
      body: {
        data: {
          title: "Kıbrıs Plajları",
          content: expect.any(Array),
          excerpt: "Yeni özet.",
          featured_image: image,
        },
        slug: "kibris-plajlari",
        status: "draft",
        locale: "tr",
        translationOf: "p1",
        taxonomies: { category: ["beaches"], tag: ["summer"] },
        seo: { title: "Kıbrıs Plajları Rehberi", description: "En iyi plajlar." },
      },
    });
    expect([...runs.map.values()][0]).toMatchObject({
      postId: "tr-1",
      editUrl: "/_emdash/admin/content/posts/tr-1",
      topic: "translate: Cyprus Beaches → tr",
    });
  });

  it("refuses to translate a post into its own locale or when a translation exists", async () => {
    const { h, created } = setup({ p1: ENTRY });
    const same = await h.edit({ ids: ["p1"], action: "translate", targetLocale: "en" });
    expect(same.results[0]).toMatchObject({ status: "error", error: "The post is already in English" });
    expect(created).toEqual([]);

    const conflict = setup({ p1: ENTRY });
    (conflict.content.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: { code: "CONFLICT", message: 'Translation already exists in locale "tr" for this content item' },
    });
    const out = await conflict.h.edit({ ids: ["p1"], action: "translate", targetLocale: "tr" });
    expect(out.results[0]).toMatchObject({ status: "error", error: expect.stringContaining("already exists") });
  });

  it("reports the AI cost per post and in total", async () => {
    const updates: string[] = [];
    const content = {
      get: vi.fn(async (_c: string, id: string) => ({ success: true as const, data: { item: { ...ENTRY, id } } })),
      update: vi.fn(async (_c: string, id: string) => {
        updates.push(id);
        return { success: true as const, data: { item: ENTRY } };
      }),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(EDITED) } }], usage: { cost: 0.002 } })),
    ) as unknown as typeof fetch;
    const h = createBulkHandlers({ kv: memoryKv(), getApiKey: async () => "k", fetchImpl, content: content as never });
    const out = await h.edit({ ids: ["a", "b"], action: "rewrite" });
    expect(out.results.map((r) => r.cost)).toEqual([0.002, 0.002]);
    expect(out.cost).toBe(0.004);
  });

  it("requires a target locale for translate and caps the batch at 20 posts", async () => {
    const { h } = setup({ p1: ENTRY });
    await expect(h.edit({ ids: ["p1"], action: "translate" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.edit({ ids: ["p1"], action: "translate", targetLocale: "de" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const ids = Array.from({ length: 21 }, (_, i) => `p${i}`);
    await expect(h.edit({ ids, action: "rewrite" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fails the whole request when the text provider key is missing", async () => {
    const h = createBulkHandlers({
      kv: memoryKv(),
      getApiKey: async () => {
        throw new Error("OPENROUTER_API_KEY is not bound");
      },
      content: { get: vi.fn(), update: vi.fn() } as never,
    });
    await expect(h.edit({ ids: ["p1"], action: "rewrite" })).rejects.toThrow(/not bound/);
  });
});

describe("bulk/entries route", () => {
  it("lists one locale's entries with titles and passes the search through", async () => {
    const list = vi.fn(async () => ({
      success: true as const,
      data: { items: [{ id: "p1", status: "published", data: { title: "A" } }, { id: "p2", data: {} }] },
    }));
    const h = createBulkHandlers({ kv: memoryKv(), getApiKey: async () => "k", content: {} as never, list });
    expect(await h.entries({ q: "beach" })).toEqual({
      entries: [
        { id: "p1", title: "A", status: "published" },
        { id: "p2", title: "(untitled)", status: "draft" },
      ],
    });
    expect(list).toHaveBeenCalledWith("posts", { limit: 100, locale: "en", q: "beach" });
    await h.entries({ locale: "tr" });
    expect(list).toHaveBeenLastCalledWith("posts", { limit: 100, locale: "tr" });
  });

  it("surfaces list failures", async () => {
    const list = vi.fn(async () => ({ success: false as const, error: { message: "Unknown collection" } }));
    const h = createBulkHandlers({ kv: memoryKv(), getApiKey: async () => "k", content: {} as never, list });
    await expect(h.entries({ collection: "nope" })).rejects.toMatchObject({ code: "list_failed" });
  });
});
