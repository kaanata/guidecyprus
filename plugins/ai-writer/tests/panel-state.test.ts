import { describe, expect, it } from "vitest";
import { featuresOf } from "../src/lib/collections";
import {
  availableFields,
  FIELD_LABELS,
  hasKeptValues,
  initialPanelState,
  keptValues,
  previewFields,
  selectedFields,
} from "../src/admin/panel-state";
import type { PanelPreview } from "../src/lib/panel";

const block = (style: "normal" | "h2", text: string) => ({
  _type: "block" as const,
  _key: text,
  style,
  markDefs: [] as never[],
  children: [{ _type: "span" as const, _key: "s", text, marks: [] }],
});

const PREVIEW: PanelPreview = {
  title: "New Title",
  excerpt: "New excerpt.",
  tags: [
    { slug: "health", label: "Health" },
    { slug: "guides", label: "Guides" },
  ],
  seo: { metaTitle: "MT", metaDescription: "MD" },
  content: [block("h2", "One"), block("normal", "Text")],
};

const keepAll = initialPanelState().keep;

describe("initialPanelState", () => {
  it("selects every field except the destructive rewrite and keeps everything", () => {
    const s = initialPanelState();
    expect(s.selected).toEqual({
      title: true,
      excerpt: true,
      tags: true,
      seo: true,
      image: false,
      rewrite: false,
    });
    expect(Object.values(s.keep).every(Boolean)).toBe(true);
    expect(s.preview).toBeNull();
    expect(selectedFields(s)).toEqual(["title", "excerpt", "tags", "seo"]);
  });

  it("labels the rewrite as destructive", () => {
    expect(FIELD_LABELS.rewrite).toBe("Rewrite content (replaces the body)");
  });
});

describe("previewFields", () => {
  it("lists only fields with a generated value (content counts as rewrite)", () => {
    expect(previewFields(PREVIEW)).toEqual(["title", "excerpt", "tags", "seo", "rewrite"]);
    expect(previewFields({ title: "T", tags: [] })).toEqual(["title"]);
    expect(previewFields(null)).toEqual([]);
  });
});

describe("image preview", () => {
  const extra: PanelPreview = { featuredImage: { provider: "local", id: "m1", src: "/m1.png", alt: "A" } };

  it("lists and keeps the featured image", () => {
    expect(previewFields(extra)).toEqual(["image"]);
    expect(keptValues(extra, keepAll)).toEqual({ featuredImage: extra.featuredImage });
    expect(keptValues(extra, { ...keepAll, image: false })).toEqual({});
  });
});

describe("availableFields", () => {
  it("offers every field on posts and only title and rewrite on a bare page", () => {
    const posts = featuresOf({ fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] });
    expect(availableFields(posts)).toEqual(["title", "excerpt", "tags", "seo", "image", "rewrite"]);
    const pages = featuresOf({ fields: ["title", "content"], hasSeo: false, taxonomies: [] });
    expect(availableFields(pages)).toEqual(["title", "rewrite"]);
    expect(selectedFields(initialPanelState(), pages)).toEqual(["title"]);
  });

  it("offers every field while the collection is still loading", () => {
    expect(availableFields(null)).toEqual(["title", "excerpt", "tags", "seo", "image", "rewrite"]);
  });
});

describe("keptValues", () => {
  it("maps kept preview fields to apply values (tags as slugs)", () => {
    expect(keptValues(PREVIEW, keepAll)).toEqual({
      title: "New Title",
      excerpt: "New excerpt.",
      tags: ["health", "guides"],
      seo: { metaTitle: "MT", metaDescription: "MD" },
      content: PREVIEW.content,
    });
  });

  it("drops fields the user unticked", () => {
    const keep = { ...keepAll, title: false, rewrite: false };
    const values = keptValues(PREVIEW, keep);
    expect(values.title).toBeUndefined();
    expect(values.content).toBeUndefined();
    expect(values.excerpt).toBe("New excerpt.");
  });

  it("reports whether anything is left to apply", () => {
    expect(hasKeptValues(PREVIEW, keepAll)).toBe(true);
    expect(
      hasKeptValues(PREVIEW, {
        title: false,
        excerpt: false,
        tags: false,
        seo: false,
        image: false,
        rewrite: false,
      }),
    ).toBe(false);
    expect(hasKeptValues(null, keepAll)).toBe(false);
  });
});
