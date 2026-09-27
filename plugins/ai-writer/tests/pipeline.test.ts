import { describe, expect, it, vi } from "vitest";
import { DuplicateTopicError, type ContentHandlers, type CreateBody } from "../src/lib/content";
import type { GenerateImageInput, GenerateTextInput, GenerateTextOutput } from "../src/lib/openrouter";
import { PipelineError, runPipeline, type PipelineOptions } from "../src/lib/pipeline";
import { defaultSettings } from "../src/lib/settings";

// Every slot gets its own model id, so the fake answers by model and the
// test also proves per-rule model overrides reach each step.
const MODELS = {
  title: "m/title",
  outline: "m/outline",
  section: "m/section",
  intro: "m/intro",
  outro: "m/outro",
  faq: "m/faq",
  excerpt: "m/excerpt",
  tags: "m/tags",
  imagePrompt: "m/imagePrompt",
  seo: "m/seo",
  image: "m/image",
};

type Reply = string | object | Error;

function routedClient(replies: Record<string, Reply>) {
  const calls: GenerateTextInput[] = [];
  const images: GenerateImageInput[] = [];
  return {
    calls,
    images,
    models: () => calls.map((c) => c.model),
    client: {
      async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
        calls.push(input);
        const r = replies[input.model];
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error(`no reply for ${input.model}`);
        const raw = typeof r === "string" ? r : JSON.stringify(r);
        let json: unknown = raw;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        return { json, raw };
      },
      async generateImage(input: GenerateImageInput) {
        images.push(input);
        const r = replies[input.model];
        if (r instanceof Error) throw r;
        return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
      },
    },
  };
}

const REPLIES: Record<string, Reply> = {
  "m/title": "Brewing Better Tea",
  "m/outline": { headings: ["Choosing Leaves", "Water Temperature"] },
  "m/section": "First paragraph.\n\nSecond paragraph.",
  "m/intro": "An intro.",
  "m/outro": "A wrap-up.",
  "m/faq": { items: [{ q: "Hot or cold?", a: "Both work." }] },
  "m/excerpt": "A short excerpt.",
  "m/tags": { tags: ["Tea"] },
  "m/imagePrompt": "A steaming glass teapot on a wooden table in morning light.",
  "m/seo": { metaTitle: "Brewing Better Tea", metaDescription: "How to brew tea well." },
  "m/image": "unused",
};

const TERMS = {
  category: [{ slug: "news", label: "News" }],
  tag: [
    { slug: "tea", label: "Tea" },
    { slug: "guides", label: "Guides" },
  ],
};

function contentHandlers(opts: { existing?: boolean } = {}) {
  const created: CreateBody[] = [];
  const content: ContentHandlers = {
    get: vi.fn(async () =>
      opts.existing
        ? { success: true as const, data: { item: { id: "old" } } }
        : { success: false as const, error: { code: "NOT_FOUND" } },
    ),
    create: vi.fn(async (_collection: string, body: CreateBody) => {
      created.push(body);
      return { success: true as const, data: { item: { id: "p1" } } };
    }),
    publish: vi.fn(async () => ({ success: true as const, data: {} })),
    update: vi.fn(async () => ({ success: true as const, data: { item: { id: "p1" } } })),
  };
  return { content, created };
}

const OPTIONS: PipelineOptions = {
  mode: "article",
  topicMode: "topic",
  sections: 2,
  headingLevel: "h2",
  paragraphsPerSection: 2,
  intro: true,
  outro: true,
  outroHeader: "",
  toc: false,
  faq: true,
  featuredImage: true,
  collection: "posts",
  status: "draft",
  categories: ["news"],
  tags: ["guides"],
  autoTags: true,
  locale: "en",
  params: {},
  models: MODELS,
};

function setup(replies: Record<string, Reply> = REPLIES, opts: { existing?: boolean } = {}) {
  const fake = routedClient(replies);
  const { content, created } = contentHandlers(opts);
  const media = { upload: vi.fn(async () => ({ mediaId: "m1", url: "/m1.png" })) };
  const deps = {
    client: fake.client,
    // No-AI-slop is covered by its own tests below; the step tests stay exact.
    settings: {
      ...defaultSettings,
      models: { ...defaultSettings.models, fallbackText: "" },
      noAiSlop: { enabled: false, model: "" },
    },
    media,
    content,
    getTerms: vi.fn(async (taxonomy: "category" | "tag", _locale?: string) => TERMS[taxonomy]),
  };
  return { deps, fake, content, created, media };
}

const texts = (body: CreateBody) =>
  (body.data.content as Array<{ style: string; children: Array<{ text: string }> }>).map(
    (b) => `${b.style}:${b.children[0].text}`,
  );

describe("runPipeline", () => {
  it("runs every enabled step and creates the assembled post", async () => {
    const { deps, fake, created } = setup();
    const result = await runPipeline(deps, "green tea", OPTIONS);

    expect(result).toEqual({
      postId: "p1",
      slug: "brewing-better-tea",
      title: "Brewing Better Tea",
      status: "draft",
      warnings: [],
      calls: 11,
      cost: 0,
      tokens: 0,
      imageCosts: {},
    });
    expect(fake.models().sort()).toEqual(
      [
        "m/excerpt",
        "m/faq",
        "m/imagePrompt",
        "m/intro",
        "m/outline",
        "m/outro",
        "m/section",
        "m/section",
        "m/tags",
        "m/title",
      ].sort(),
    );
    expect(fake.images).toHaveLength(1);
    expect(fake.images[0].model).toBe("m/image");
    // The text model writes the scene; the image model draws it.
    expect(fake.images[0].prompt).toContain("A steaming glass teapot on a wooden table in morning light.");

    const body = created[0];
    expect(body.data.title).toBe("Brewing Better Tea");
    expect(body.data.excerpt).toBe("A short excerpt.");
    expect(body.data.featured_image).toEqual({ provider: "local", id: "m1", src: "/m1.png", alt: "Brewing Better Tea" });
    expect(body.taxonomies).toEqual({ category: ["news"], tag: ["guides", "tea"] });
    expect(texts(body)).toEqual([
      "normal:An intro.",
      "h2:Choosing Leaves",
      "normal:First paragraph.",
      "normal:Second paragraph.",
      "h2:Water Temperature",
      "normal:First paragraph.",
      "normal:Second paragraph.",
      "h2:FAQ",
      "h3:Hot or cold?",
      "normal:Both work.",
      "h2:Conclusion",
      "normal:A wrap-up.",
    ]);
  });

  it("uses the topic verbatim in title mode and makes no title call", async () => {
    const { deps, fake, created } = setup();
    const result = await runPipeline(deps, "  How to Store Tea  ", { ...OPTIONS, topicMode: "title" });
    expect(result.title).toBe("How to Store Tea");
    expect(fake.models()).not.toContain("m/title");
    expect(created[0].data.title).toBe("How to Store Tea");
  });

  it("makes no call for disabled parts", async () => {
    const { deps, fake, created } = setup();
    const result = await runPipeline(deps, "green tea", {
      ...OPTIONS,
      intro: false,
      outro: false,
      faq: false,
      featuredImage: false,
      autoTags: false,
    });
    expect(fake.models().sort()).toEqual(["m/excerpt", "m/outline", "m/section", "m/section", "m/title"]);
    expect(fake.images).toHaveLength(0);
    expect(created[0].data.featured_image).toBeUndefined();
    expect(created[0].taxonomies).toEqual({ category: ["news"], tag: ["guides"] });
    expect(result.calls).toBe(5);
  });

  it("fails the run when a section fails, without creating a post", async () => {
    const { deps, content } = setup({ ...REPLIES, "m/section": new Error("upstream 500") });
    const err = await runPipeline(deps, "green tea", OPTIONS).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.step).toBe("section");
    expect(err.message).toContain("upstream 500");
    expect(content.create).not.toHaveBeenCalled();
  });

  it("fails on an outline with fewer than 2 headings", async () => {
    const { deps } = setup({ ...REPLIES, "m/outline": { headings: ["Only one"] } });
    const err = await runPipeline(deps, "green tea", OPTIONS).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.step).toBe("outline");
  });

  it("wraps a title failure as a PipelineError for the title step", async () => {
    const { deps } = setup({ ...REPLIES, "m/title": new Error("model gone") });
    const err = await runPipeline(deps, "green tea", OPTIONS).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.step).toBe("title");
  });

  it("turns non-fatal failures into warnings and still creates the post", async () => {
    const { deps, created } = setup({ ...REPLIES, "m/faq": new Error("faq down"), "m/image": new Error("image down") });
    const result = await runPipeline(deps, "green tea", OPTIONS);
    expect(result.postId).toBe("p1");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("faq skipped: faq down"), expect.stringContaining("image skipped")]),
    );
    expect(texts(created[0])).not.toContain("h2:FAQ");
    expect(created[0].data.featured_image).toBeUndefined();
  });

  it("stops before the outline when the title's slug already exists", async () => {
    const { deps, fake, content } = setup(REPLIES, { existing: true });
    await expect(runPipeline(deps, "green tea", OPTIONS)).rejects.toBeInstanceOf(DuplicateTopicError);
    expect(fake.models()).toEqual(["m/title"]);
    expect(content.create).not.toHaveBeenCalled();
  });

  it("publishes when the status is published", async () => {
    const { deps, content } = setup();
    const result = await runPipeline(deps, "green tea", { ...OPTIONS, status: "published" });
    expect(content.publish).toHaveBeenCalledWith("posts", "p1");
    expect(result.status).toBe("published");
  });

  it("uses the configured heading level, TOC and outro header", async () => {
    const { deps, created } = setup();
    await runPipeline(deps, "green tea", { ...OPTIONS, headingLevel: "h3", toc: true, outroHeader: "Final Thoughts", faq: false });
    const lines = texts(created[0]);
    expect(lines).toContain("h2:Table of Contents");
    expect(lines).toContain("h3:Choosing Leaves");
    expect(lines).toContain("h2:Final Thoughts");
  });
});

describe("runPipeline locales and collections", () => {
  const POSTS = { fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] };
  const PAGES = { fields: ["title", "content", "excerpt"], hasSeo: false, taxonomies: [] };

  it("writes a Turkish post: Turkish prompts, tr slug check, tr terms and tr headers", async () => {
    const { deps, fake, content, created } = setup({ ...REPLIES, "m/title": "Kıbrıs Plajları" });
    await runPipeline(deps, "Kıbrıs plajları", { ...OPTIONS, locale: "tr" });
    // Tags pick from a list and the image scene is always described in English.
    for (const call of fake.calls.filter((c) => !["m/tags", "m/imagePrompt"].includes(c.model))) {
      expect(call.prompt).toContain("in Turkish");
    }
    expect(content.get).toHaveBeenCalledWith("posts", "kibris-plajlari", "tr");
    expect(deps.getTerms).toHaveBeenCalledWith("tag", "tr");
    expect(deps.getTerms).toHaveBeenCalledWith("category", "tr");
    expect(deps.getTerms).not.toHaveBeenCalledWith("tag", "en");
    expect(created[0]).toMatchObject({ slug: "kibris-plajlari", locale: "tr" });
    expect(texts(created[0])).toEqual(expect.arrayContaining(["h2:Sıkça Sorulan Sorular", "h2:Sonuç"]));
  });

  it("writes English posts in English with the en locale", async () => {
    const { deps, fake, created } = setup();
    await runPipeline(deps, "green tea", OPTIONS);
    expect(fake.calls.find((c) => c.model === "m/title")?.prompt).toContain("in English");
    expect(created[0].locale).toBe("en");
  });

  it("generates SEO meta for collections with SEO and sends it with the post", async () => {
    const { deps, fake, created } = setup();
    const result = await runPipeline({ ...deps, getCollectionInfo: async () => POSTS }, "green tea", OPTIONS);
    expect(fake.models()).toContain("m/seo");
    expect(created[0].seo).toEqual({ title: "Brewing Better Tea", description: "How to brew tea well." });
    expect(result.calls).toBe(12);
  });

  it("keeps the post and warns when SEO generation fails", async () => {
    const { deps, created } = setup({ ...REPLIES, "m/seo": new Error("seo down") });
    const result = await runPipeline({ ...deps, getCollectionInfo: async () => POSTS }, "green tea", OPTIONS);
    expect(created[0].seo).toBeUndefined();
    expect(result.warnings).toContain("SEO skipped: seo down");
  });

  it("skips image, SEO and taxonomies for a collection without them", async () => {
    const { deps, fake, created } = setup();
    const result = await runPipeline(
      { ...deps, getCollectionInfo: async () => PAGES },
      "green tea",
      { ...OPTIONS, collection: "pages" },
    );
    expect(fake.images).toHaveLength(0);
    expect(fake.models()).not.toContain("m/imagePrompt");
    expect(fake.models()).not.toContain("m/tags");
    expect(fake.models()).not.toContain("m/seo");
    expect(created[0].data.featured_image).toBeUndefined();
    expect(created[0].seo).toBeUndefined();
    expect(created[0].taxonomies).toBeUndefined();
    expect(created[0].data.excerpt).toBe("A short excerpt.");
    expect(result.warnings).toEqual(['Collection "pages" has no categories; skipped news', 'Collection "pages" has no tags; skipped guides']);
  });
});

describe("runPipeline instructions and byline", () => {
  it("sends rule instructions with every text step", async () => {
    const { deps, fake } = setup();
    await runPipeline(deps, "green tea", { ...OPTIONS, instructions: "No real hotel names." });
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) expect(call.prompt).toContain("No real hotel names.");
  });

  it("credits the resolved byline on the created post", async () => {
    const { deps, created } = setup();
    const getBylineId = vi.fn(async () => "byline-1");
    const result = await runPipeline({ ...deps, getBylineId }, "green tea", { ...OPTIONS, byline: "editorial" });
    expect(getBylineId).toHaveBeenCalledWith("editorial");
    expect(created[0].bylines).toEqual([{ bylineId: "byline-1" }]);
    expect(result.warnings).toEqual([]);
  });

  it("creates the post without a byline and warns when the slug is unknown", async () => {
    const { deps, created } = setup();
    const result = await runPipeline({ ...deps, getBylineId: async () => null }, "green tea", {
      ...OPTIONS,
      byline: "ghost",
    });
    expect(created[0].bylines).toBeUndefined();
    expect(result.warnings).toContain('Byline "ghost" not found; post has no byline');
  });
});

describe("runPipeline backdating and image prompts", () => {
  const now = () => new Date("2026-09-14T12:00:00.000Z");

  it("publishes a date-prefixed topic with that date and writes about the topic only", async () => {
    const { deps, fake, created } = setup();
    await runPipeline({ ...deps, now }, "2026-08-03 09:30 | green tea", { ...OPTIONS, status: "published" });
    expect(created[0].publishedAt).toBe("2026-08-03T09:30:00.000Z");
    const titleCall = fake.calls.find((c) => c.model === "m/title");
    expect(titleCall?.prompt).toContain('"green tea"');
    expect(titleCall?.prompt).not.toContain("2026-08-03");
  });

  it("does not backdate plain topics", async () => {
    const { deps, created } = setup();
    await runPipeline({ ...deps, now }, "green tea", OPTIONS);
    expect(created[0].publishedAt).toBeUndefined();
  });

  it("falls back to the title for the image when the image description fails", async () => {
    const { deps, fake } = setup({ ...REPLIES, "m/imagePrompt": new Error("rate limited") });
    const result = await runPipeline(deps, "green tea", OPTIONS);
    expect(fake.images[0].prompt).toContain("Brewing Better Tea");
    expect(result.warnings).toContain("image prompt skipped: rate limited");
  });
});

describe("runPipeline no-AI-slop edit", () => {
  const withSlop = (replies: Record<string, Reply>) => {
    const ctx = setup(replies);
    ctx.deps.settings = { ...ctx.deps.settings, noAiSlop: { enabled: true, model: "m/editor" } };
    return ctx;
  };

  it("edits the assembled article before creating the post", async () => {
    const { deps, created, fake } = withSlop({
      ...REPLIES,
      "m/editor": {
        excerpt: "A cleaner excerpt.",
        blocks: [{ i: 0, text: "A sharper intro." }, { i: 2, text: "First paragraph, tightened." }],
      },
    });
    const result = await runPipeline(deps, "green tea", OPTIONS);
    const editCall = fake.calls.find((c) => c.model === "m/editor");
    expect(editCall?.system).toContain("removing AI-writing patterns");
    expect(created[0].data.excerpt).toBe("A cleaner excerpt.");
    expect(texts(created[0]).slice(0, 3)).toEqual(["normal:A sharper intro.", "h2:Choosing Leaves", "normal:First paragraph, tightened."]);
    // 12 editable blocks in two parts (6 + 6); the reply only covers part 1,
    // so part 2 is retried once and then left as written.
    expect(fake.calls.filter((c) => c.model === "m/editor")).toHaveLength(3);
    expect(result.calls).toBe(14);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the article as written and warns when the edit fails", async () => {
    const { deps, created } = withSlop({ ...REPLIES, "m/editor": new Error("timeout") });
    const result = await runPipeline(deps, "green tea", OPTIONS);
    expect(texts(created[0])[0]).toBe("normal:An intro.");
    expect(result.warnings).toContain("no-AI-slop edit skipped: timeout");
  });

  it("adds the slop guide to writing prompts only when it is on", async () => {
    const on = withSlop({ ...REPLIES, "m/editor": { blocks: [] } });
    await runPipeline(on.deps, "green tea", OPTIONS);
    expect(on.fake.calls.find((c) => c.model === "m/section")?.system).toContain("Never use these words");
    const off = setup();
    await runPipeline(off.deps, "green tea", OPTIONS);
    expect(off.fake.calls.find((c) => c.model === "m/section")?.system).not.toContain("Never use these words");
  });
});

describe("runPipeline cost", () => {
  it("sums the cost and tokens every call reports", async () => {
    const { deps } = setup();
    const priced = {
      generateText: async (input: GenerateTextInput) => ({
        ...(await deps.client.generateText(input)),
        usage: { cost: 0.001, promptTokens: 100, completionTokens: 50 },
      }),
      generateImage: async (input: GenerateImageInput) => ({
        ...(await deps.client.generateImage(input)),
        usage: { cost: 0.01 },
      }),
    };
    const result = await runPipeline({ ...deps, client: priced }, "green tea", OPTIONS);
    expect(result.calls).toBe(11);
    expect(result.cost).toBe(0.02);
    expect(result.tokens).toBe(1500);
  });
});

