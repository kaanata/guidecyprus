import { describe, expect, it } from "vitest";
import { featuresOf } from "../src/lib/collections";

describe("featuresOf", () => {
  it("reads a posts-like collection: image, excerpt, SEO and both taxonomies", () => {
    expect(
      featuresOf({ fields: ["title", "featured_image", "content", "excerpt"], hasSeo: true, taxonomies: ["category", "tag"] }),
    ).toEqual({ featuredImage: true, excerpt: true, seo: true, categories: true, tags: true });
  });

  it("reads a pages-like collection: no image, no SEO, no taxonomies", () => {
    expect(featuresOf({ fields: ["title", "content", "excerpt"], hasSeo: false, taxonomies: [] })).toEqual({
      featuredImage: false,
      excerpt: true,
      seo: false,
      categories: false,
      tags: false,
    });
  });

  it("stays permissive but never sends SEO when the collection is unknown", () => {
    expect(featuresOf(null)).toEqual({ featuredImage: true, excerpt: true, seo: false, categories: true, tags: true });
    expect(featuresOf(undefined)).toEqual(featuresOf(null));
  });
});
