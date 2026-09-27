import { describe, expect, it } from "vitest";
import type { ContentEntry } from "../src/lib/content";
import type { GenerateTextInput, GenerateTextOutput } from "../src/lib/openrouter";
import { featuresOf } from "../src/lib/collections";
import {
  buildUpdateBody,
  entryTitle,
  generatePanelValues,
  panelApplySchema,
  panelGenerateSchema,
  type PanelField,
} from "../src/lib/panel";
import { defaultSettings } from "../src/lib/settings";

type Reply = string | object | Error;

// Answers by model; an outline prompt (JSON headings) can be answered
// separately under "<model>#outline".
function routedClient(replies: Record<string, Reply>) {
  const calls: GenerateTextInput[] = [];
  return {
    calls,
    client: {
      async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
        calls.push(input);
        const key = input.prompt.includes('{"headings"') ? `${input.model}#outline` : input.model;
        const r = replies[key] ?? replies[input.model];
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error(`no reply for ${key}`);
        const raw = typeof r === "string" ? r : JSON.stringify(r);
        let json: unknown = raw;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        return { json, raw };
      },
      async generateImage(): Promise<never> {
        throw new Error("the panel never generates images");
      },
    },
  };
}

const block = (style: "normal" | "h2" | "h3", text: string) => ({
  _type: "block",
  _key: `k-${text}`,
  style,
  markDefs: [],
  children: [{ _type: "span", _key: "s", text, marks: [] }],
});

const ENTRY: ContentEntry = {
  id: "e1",
  status: "published",
  data: {
    title: "Green Tea Guide",
    excerpt: "Old excerpt.",
    content: [
      block("normal", "Intro"),
      block("h2", "Choosing Leaves"),
      block("normal", "Body"),
      block("h2", "Water Temperature"),
      block("h2", "FAQ"),
      block("h3", "Hot or cold?"),
      block("h2", "Conclusion"),
    ],
  },
};

const TAGS = [
  { slug: "tea", label: "Tea" },
  { slug: "guides", label: "Guides" },
  { slug: "health", label: "Health" },
];

const MODELS = { title: "m/title", excerpt: "m/excerpt", tags: "m/tags", seo: "m/seo", rewrite: "m/rewrite" };

const REPLIES: Record<string, Reply> = {
  "m/title": "Brewing Green Tea Right",
  "m/excerpt": "A short new excerpt.",
  "m/tags": { tags: ["Tea", "Health", "Unknown"] },
  "m/seo": { metaTitle: "Green Tea Guide", metaDescription: "How to brew green tea." },
  "m/rewrite": "New paragraph one.\n\nNew paragraph two.",
  "m/rewrite#outline": { headings: ["Alpha", "Beta", "Gamma", "Delta"] },
};

const POSTS = featuresOf({ fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] });

function setup(replies: Record<string, Reply> = REPLIES, entryTags: string[] = ["tea"]) {
  const fake = routedClient(replies);
  const deps = {
    client: fake.client,
    settings: { ...defaultSettings, models: { ...defaultSettings.models, fallbackText: "" } },
    tagTerms: TAGS,
    entryTags,
    features: POSTS,
  };
  return { fake, deps };
}

const request = (fields: PanelField[], extra: Record<string, unknown> = {}) =>
  panelGenerateSchema.parse({ collection: "posts", id: "e1", fields, models: MODELS, ...extra });

const texts = (blocks: Array<{ style: string; children: Array<{ text: string }> }>) =>
  blocks.map((b) => `${b.style}:${b.children[0].text}`);

describe("entryTitle", () => {
  it("returns the trimmed saved title or an empty string", () => {
    expect(entryTitle({ id: "a", data: { title: "  Tea  " } })).toBe("Tea");
    expect(entryTitle({ id: "a", data: { title: 5 } })).toBe("");
    expect(entryTitle({ id: "a" })).toBe("");
  });
});

describe("generatePanelValues", () => {
  it("generates title, excerpt, tags and SEO with per-field models", async () => {
    const { fake, deps } = setup();
    const result = await generatePanelValues(deps, ENTRY, request(["title", "excerpt", "tags", "seo"]));
    expect(result.values).toEqual({
      title: "Brewing Green Tea Right",
      excerpt: "A short new excerpt.",
      tags: [{ slug: "health", label: "Health" }],
      seo: { metaTitle: "Green Tea Guide", metaDescription: "How to brew green tea." },
    });
    expect(result.errors).toEqual({});
    expect(result.calls).toBe(4);
    expect(fake.calls.map((c) => c.model)).toEqual(["m/title", "m/excerpt", "m/tags", "m/seo"]);
    expect(fake.calls[0].prompt).toContain("Green Tea Guide");
    expect(fake.calls[3].prompt).toContain("A short new excerpt.");
  });

  it("uses the saved excerpt for SEO when no excerpt is generated", async () => {
    const { fake, deps } = setup();
    await generatePanelValues(deps, ENTRY, request(["seo"]));
    expect(fake.calls[0].prompt).toContain("Old excerpt.");
  });

  it("warns when every suggested tag is already on the post", async () => {
    const { deps } = setup(REPLIES, ["tea", "health"]);
    const result = await generatePanelValues(deps, ENTRY, request(["tags"]));
    expect(result.values.tags).toEqual([]);
    expect(result.warnings).toContain("No new matching tags were suggested");
  });

  it("rewrites the body from the post's own section headings", async () => {
    const { fake, deps } = setup();
    const result = await generatePanelValues(deps, ENTRY, request(["rewrite"]));
    expect(texts(result.values.content ?? [])).toEqual([
      "normal:New paragraph one.",
      "normal:New paragraph two.",
      "h2:Choosing Leaves",
      "normal:New paragraph one.",
      "normal:New paragraph two.",
      "h2:Water Temperature",
      "normal:New paragraph one.",
      "normal:New paragraph two.",
      "h2:Conclusion",
      "normal:New paragraph one.",
      "normal:New paragraph two.",
    ]);
    expect(new Set(fake.calls.map((c) => c.model))).toEqual(new Set(["m/rewrite"]));
    expect(result.calls).toBe(4);
  });

  it("caps the rewrite at 12 sections when the post has more", async () => {
    const { deps } = setup();
    const manyHeadings = Array.from({ length: 15 }, (_, i) => `Section ${i + 1}`);
    const entry: ContentEntry = {
      id: "e3",
      data: { title: "Green Tea Guide", content: manyHeadings.map((h) => block("h2", h)) },
    };
    const result = await generatePanelValues(deps, entry, request(["rewrite"]));
    const sectionHeadings = texts(result.values.content ?? []).filter((t) => t.startsWith("h2:"));
    expect(sectionHeadings).toEqual([
      ...manyHeadings.slice(0, 12).map((h) => `h2:${h}`),
      "h2:Conclusion",
    ]);
    expect(result.calls).toBe(14);
  });

  it("plans an outline first when the post has fewer than two headings", async () => {
    const { deps } = setup();
    const entry: ContentEntry = { id: "e2", data: { title: "Green Tea Guide", content: [block("normal", "Only text")] } };
    const result = await generatePanelValues(deps, entry, request(["rewrite"]));
    expect(texts(result.values.content ?? []).filter((t) => t.startsWith("h2:"))).toEqual([
      "h2:Alpha",
      "h2:Beta",
      "h2:Gamma",
      "h2:Delta",
      "h2:Conclusion",
    ]);
  });

  it("reports a failing field without failing the others", async () => {
    const { deps } = setup({ ...REPLIES, "m/excerpt": new Error("excerpt model down") });
    const result = await generatePanelValues(deps, ENTRY, request(["title", "excerpt"]));
    expect(result.values.title).toBe("Brewing Green Tea Right");
    expect(result.values.excerpt).toBeUndefined();
    expect(result.errors.excerpt).toContain("excerpt model down");
  });

  it("fails the whole rewrite when one section fails", async () => {
    const { deps } = setup({ ...REPLIES, "m/rewrite": new Error("rewrite model down") });
    const result = await generatePanelValues(deps, ENTRY, request(["rewrite"]));
    expect(result.values.content).toBeUndefined();
    expect(result.errors.rewrite).toContain("rewrite model down");
  });

  it("writes in the entry's locale and rewrites with that locale's headers", async () => {
    const { fake, deps } = setup();
    const entry: ContentEntry = {
      id: "tr1",
      data: {
        title: "Girne Rehberi",
        content: [block("h2", "Liman"), block("h2", "Kale"), block("h2", "Sıkça Sorulan Sorular"), block("h2", "Sonuç")],
      },
    };
    const result = await generatePanelValues({ ...deps, locale: "tr" }, entry, request(["title", "rewrite"]));
    expect(fake.calls.every((c) => c.prompt.includes("in Turkish"))).toBe(true);
    expect(texts(result.values.content ?? []).filter((t) => t.startsWith("h2:"))).toEqual(["h2:Liman", "h2:Kale", "h2:Sonuç"]);
  });

  it("refuses fields the collection cannot hold, without calling a model", async () => {
    const { fake, deps } = setup();
    const pages = featuresOf({ fields: ["title", "content"], hasSeo: false, taxonomies: [] });
    const result = await generatePanelValues({ ...deps, features: pages }, ENTRY, request(["excerpt", "tags", "seo", "image"]));
    expect(result.values).toEqual({});
    expect(Object.keys(result.errors).sort()).toEqual(["excerpt", "image", "seo", "tags"]);
    expect(result.errors.seo).toMatch(/SEO/);
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the instructions into every prompt", async () => {
    const { fake, deps } = setup();
    await generatePanelValues(deps, ENTRY, request(["title"], { instructions: "Mention Japan" }));
    expect(fake.calls[0].prompt).toContain("Mention Japan");
  });
});

describe("buildUpdateBody", () => {
  const content = [block("h2", "New"), block("normal", "Text")] as unknown as NonNullable<
    Parameters<typeof buildUpdateBody>[0]["content"]
  >;

  const posts = POSTS;

  it("writes only the given fields, merges tags and maps SEO", () => {
    expect(
      buildUpdateBody(
        {
          title: "T",
          excerpt: "E",
          content,
          tags: ["health", "tea"],
          seo: { metaTitle: "MT", metaDescription: "MD" },
        },
        ["tea", "guides"],
        posts,
      ),
    ).toEqual({
      data: { title: "T", excerpt: "E", content },
      taxonomies: { tag: ["tea", "guides", "health"] },
      seo: { title: "MT", description: "MD" },
    });
  });

  it("returns an empty body when nothing is kept", () => {
    expect(buildUpdateBody({}, ["tea"], posts)).toEqual({});
    expect(buildUpdateBody({ tags: [] }, ["tea"], posts)).toEqual({});
  });

  it("writes image, excerpt, tags and SEO only where the collection supports them", () => {
    const featuredImage = { provider: "local" as const, id: "m9", src: "/m.png", alt: "A" };
    const values = { title: "T", excerpt: "E", featuredImage, tags: ["tea"], seo: { metaTitle: "MT", metaDescription: "MD" } };
    expect(buildUpdateBody(values, [], posts)).toEqual({
      data: { title: "T", excerpt: "E", featured_image: featuredImage },
      taxonomies: { tag: ["tea"] },
      seo: { title: "MT", description: "MD" },
    });
    const pages = featuresOf({ fields: ["title", "content"], hasSeo: false, taxonomies: [] });
    expect(buildUpdateBody(values, [], pages)).toEqual({ data: { title: "T" } });
  });
});

describe("panelApplySchema", () => {
  const base = { collection: "posts", id: "e1" };

  it("accepts valid values", () => {
    expect(
      panelApplySchema.safeParse({
        ...base,
        values: { title: "T", content: [block("h2", "H"), block("normal", "P")] },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed content blocks and overlong SEO", () => {
    expect(panelApplySchema.safeParse({ ...base, values: { content: [{ _type: "image" }] } }).success).toBe(false);
    expect(
      panelApplySchema.safeParse({ ...base, values: { content: [{ ...block("h2", "H"), style: "h1" }] } }).success,
    ).toBe(false);
    expect(
      panelApplySchema.safeParse({ ...base, values: { seo: { metaTitle: "x".repeat(71), metaDescription: "d" } } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown collection shape or missing id", () => {
    expect(panelApplySchema.safeParse({ collection: "Posts", id: "e1", values: {} }).success).toBe(false);
    expect(panelApplySchema.safeParse({ collection: "posts", id: "", values: {} }).success).toBe(false);
  });
});

describe("panel image", () => {
  const imageClient = () => {
    const fake = routedClient(REPLIES);
    const images: string[] = [];
    return {
      fake,
      images,
      client: {
        ...fake.client,
        async generateImage(input: { model: string; prompt: string }) {
          images.push(input.model);
          return { bytes: new Uint8Array([1, 2]), contentType: "image/png" };
        },
      },
    };
  };

  it("generates and uploads a featured image with the requested image model", async () => {
    const { client, images } = imageClient();
    const { deps } = setup();
    const media = { upload: async () => ({ mediaId: "m9", url: "/media/new.png" }) };
    const result = await generatePanelValues(
      { ...deps, client, media },
      ENTRY,
      request(["image"], { models: { image: "vendor/img" } }),
    );
    expect(result.errors).toEqual({});
    expect(result.values.featuredImage).toEqual({ provider: "local", id: "m9", src: "/media/new.png", alt: "Green Tea Guide" });
    expect(images).toEqual(["vendor/img"]);
  });

  it("reports the image as an error when media upload is unavailable", async () => {
    const { client } = imageClient();
    const { deps } = setup();
    const result = await generatePanelValues({ ...deps, client }, ENTRY, request(["image"]));
    expect(result.errors.image).toMatch(/media:write/);
  });
});

describe("panel fields", () => {
  it("has no structured-data (JSON-LD) field", () => {
    expect(panelGenerateSchema.safeParse({ collection: "posts", id: "e1", fields: ["schema"] }).success).toBe(false);
    expect(panelApplySchema.parse({ collection: "posts", id: "e1", values: { jsonLd: "{}" } }).values).toEqual({});
  });
});
