import { describe, expect, it, vi } from "vitest";
import {
  assertSlugAvailable,
  createPost,
  DuplicateTopicError,
  keepExistingTerms,
  slugify,
  type ContentHandlers,
  type CreateBody,
  type CreatePostInput,
} from "../src/lib/content";

function handlers(opts: { existing?: boolean; createOk?: boolean; publishOk?: boolean } = {}) {
  const created: Array<{ collection: string; body: CreateBody }> = [];
  const h: ContentHandlers = {
    get: vi.fn(async (_collection: string, _idOrSlug: string) =>
      opts.existing
        ? { success: true as const, data: { item: { id: "old" } } }
        : { success: false as const, error: { code: "NOT_FOUND" } },
    ),
    create: vi.fn(async (collection: string, body: CreateBody) => {
      created.push({ collection, body });
      return opts.createOk === false
        ? { success: false as const, error: { message: "Validation failed" } }
        : { success: true as const, data: { item: { id: "new-id" } } };
    }),
    publish: vi.fn(async (_collection: string, _id: string) =>
      opts.publishOk === false
        ? { success: false as const, error: { message: "Publish denied" } }
        : { success: true as const, data: {} },
    ),
    update: vi.fn(async (_c: string, id: string) => ({ success: true as const, data: { item: { id } } })),
  };
  return { h, created };
}

const terms = {
  category: [{ slug: "news", label: "News" }],
  tag: [{ slug: "tea", label: "Tea" }],
};

const base: CreatePostInput = {
  collection: "posts",
  title: "Green Tea: A Guide!",
  content: [],
  status: "draft",
  categories: [],
  tags: [],
  terms,
};

describe("slugify", () => {
  it("lowercases, strips accents and punctuation, and joins with dashes", () => {
    expect(slugify("Green Tea: A Guide!")).toBe("green-tea-a-guide");
    expect(slugify("Çay ve Kahve")).toBe("cay-ve-kahve");
  });

  it("transliterates Turkish letters, including dotless ı and dotted İ", () => {
    expect(slugify("Kıbrıs Plajları")).toBe("kibris-plajlari");
    expect(slugify("İskele'de Gün Batımı")).toBe("iskelede-gun-batimi");
    expect(slugify("Çeşme, Göl ve Şelale Üzerine")).toBe("cesme-gol-ve-selale-uzerine");
    expect(slugify("ĞÜŞİÖÇ ğüşıöç")).toBe("gusioc-gusioc");
  });

  it("caps length at 80 without a trailing dash", () => {
    const slug = slugify("word ".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("keepExistingTerms", () => {
  it("keeps known slugs once and reports unknown ones", () => {
    expect(keepExistingTerms(["news", "ghost", "news"], terms.category)).toEqual({
      kept: ["news"],
      dropped: ["ghost"],
    });
  });
});

describe("createPost", () => {
  it("throws DuplicateTopicError when the slug already exists, without creating", async () => {
    const { h } = handlers({ existing: true });
    await expect(createPost(h, base)).rejects.toBeInstanceOf(DuplicateTopicError);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("creates with data, slug, status, and only known terms", async () => {
    const { h, created } = handlers();
    const image = { provider: "local" as const, id: "m1", src: "/m1.jpg", alt: "Green tea" };
    const result = await createPost(h, {
      ...base,
      excerpt: "Short.",
      featuredImage: image,
      categories: ["news", "ghost"],
      tags: ["tea"],
    });
    expect(result).toEqual({
      id: "new-id",
      slug: "green-tea-a-guide",
      status: "draft",
      warnings: ['Unknown category "ghost" skipped'],
    });
    expect(created[0]).toEqual({
      collection: "posts",
      body: {
        data: { title: "Green Tea: A Guide!", content: [], excerpt: "Short.", featured_image: image },
        slug: "green-tea-a-guide",
        status: "draft",
        taxonomies: { category: ["news"], tag: ["tea"] },
      },
    });
  });

  it("creates in the given locale, as a translation, with SEO", async () => {
    const { h, created } = handlers();
    await createPost(h, {
      ...base,
      title: "Kıbrıs Plajları",
      locale: "tr",
      translationOf: "SRC1",
      seo: { title: "Kıbrıs'ın en iyi plajları", description: "Rehber." },
    });
    expect(h.get).toHaveBeenCalledWith("posts", "kibris-plajlari", "tr");
    expect(created[0].body).toMatchObject({
      slug: "kibris-plajlari",
      locale: "tr",
      translationOf: "SRC1",
      seo: { title: "Kıbrıs'ın en iyi plajları", description: "Rehber." },
    });
  });

  it("leaves out excerpt and featured image when the collection has no such field", async () => {
    const { h, created } = handlers();
    const image = { provider: "local" as const, id: "m1", src: "/m1.jpg", alt: "Beach" };
    await createPost(h, {
      ...base,
      collection: "pages",
      excerpt: "Short.",
      featuredImage: image,
      fields: new Set(["title", "content"]),
    });
    expect(created[0].body.data).toEqual({ title: "Green Tea: A Guide!", content: [] });
  });

  it("omits taxonomies, excerpt, and featured image when empty", async () => {
    const { h, created } = handlers();
    await createPost(h, base);
    expect(created[0].body).toEqual({
      data: { title: "Green Tea: A Guide!", content: [] },
      slug: "green-tea-a-guide",
      status: "draft",
    });
  });

  it("throws the handler's message when create fails", async () => {
    const { h } = handlers({ createOk: false });
    await expect(createPost(h, base)).rejects.toThrow("Validation failed");
  });

  it("treats EmDash's slug conflict on create as a duplicate topic", async () => {
    const { h } = handlers();
    (h.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: { code: "SLUG_CONFLICT", message: "Slug 'green-tea-a-guide' already exists in collection 'posts'" },
    });
    const err = await createPost(h, base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateTopicError);
    expect((err as DuplicateTopicError).slug).toBe("green-tea-a-guide");
  });

  it("falls back to a stable content-hash slug for titles with no latin characters", async () => {
    const { h: h1 } = handlers();
    const { h: h2 } = handlers();
    const title = "Привет мир";
    const result1 = await createPost(h1, { ...base, title });
    const result2 = await createPost(h2, { ...base, title });
    expect(result1.slug).toMatch(/^post-[0-9a-f]{8}$/);
    expect(result2.slug).toBe(result1.slug);
  });

  it("creates a draft and does not publish when status is draft", async () => {
    const { h, created } = handlers();
    const result = await createPost(h, base);
    expect(created[0].body.status).toBe("draft");
    expect(h.publish).not.toHaveBeenCalled();
    expect(result.status).toBe("draft");
  });

  it("creates a draft then publishes it when status is published", async () => {
    const { h, created } = handlers();
    const result = await createPost(h, { ...base, status: "published" });
    expect(created[0].body.status).toBe("draft");
    expect(h.publish).toHaveBeenCalledWith("posts", "new-id");
    expect(result.status).toBe("published");
    expect(result.warnings).toEqual([]);
  });

  it("keeps the draft and warns when publishing fails", async () => {
    const { h } = handlers({ publishOk: false });
    const result = await createPost(h, { ...base, status: "published" });
    expect(result.status).toBe("draft");
    expect(result.warnings).toContain("Created as a draft — publishing failed: Publish denied");
  });

  it("keeps the draft and warns when publish throws", async () => {
    const { h } = handlers();
    (h.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket closed"));
    const result = await createPost(h, { ...base, status: "published" });
    expect(result.status).toBe("draft");
    expect(result.warnings).toContain("Created as a draft — publishing failed: socket closed");
  });
});

describe("assertSlugAvailable", () => {
  it("returns the slug when no post uses it", async () => {
    const { h } = handlers();
    await expect(assertSlugAvailable(h, "posts", "Green Tea: A Guide!")).resolves.toBe("green-tea-a-guide");
    expect(h.get).toHaveBeenCalledWith("posts", "green-tea-a-guide", undefined);
  });

  it("checks the slug within the given locale only", async () => {
    const { h } = handlers();
    await expect(assertSlugAvailable(h, "posts", "Kıbrıs Plajları", "tr")).resolves.toBe("kibris-plajlari");
    expect(h.get).toHaveBeenCalledWith("posts", "kibris-plajlari", "tr");
  });

  it("throws DuplicateTopicError when the slug is taken", async () => {
    const { h } = handlers({ existing: true });
    await expect(assertSlugAvailable(h, "posts", "Green Tea: A Guide!")).rejects.toBeInstanceOf(DuplicateTopicError);
  });
});
