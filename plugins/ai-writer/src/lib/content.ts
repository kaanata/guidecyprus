import type { FeaturedImage, PortableTextBlock, TermRef } from "./types";

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error?: { code?: string; message?: string } };

export type CreateBody = {
  data: Record<string, unknown>;
  slug: string;
  // Posts are always created as drafts; publishing is a second call so
  // content:afterPublish hooks fire exactly as for an admin publish.
  status: "draft";
  taxonomies?: Record<string, string[]>;
  bylines?: Array<{ bylineId: string; roleLabel?: string }>;
  /** Backdated publish date; EmDash keeps it when the draft is published. */
  publishedAt?: string;
  /** Content locale ("en" or "tr"); EmDash uses its default locale when absent. */
  locale?: string;
  /** Id of the entry this one translates (links both into one translation group). */
  translationOf?: string;
  /** Built-in SEO; only for collections with SEO enabled (EmDash rejects it otherwise). */
  seo?: { title?: string; description?: string };
};

// The subset of a saved EmDash content item the plugin reads.
export type ContentEntry = {
  id: string;
  slug?: string | null;
  status?: string;
  data?: Record<string, unknown>;
  seo?: { title?: string | null; description?: string | null } | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  locale?: string | null;
  translationGroup?: string | null;
};

// Partial update: EmDash merges `data`, replaces the terms of each taxonomy
// named in `taxonomies`, and upserts only the given SEO fields.
export type UpdateBody = {
  data?: Record<string, unknown>;
  taxonomies?: Record<string, string[]>;
  seo?: { title?: string; description?: string };
};

// Thin seam over EmDash's runtime content methods so the logic here is
// testable without a database (wired in sandbox-entry.ts).
export type ContentHandlers = {
  /** A slug is looked up within `locale` when given (slugs repeat across locales). */
  get(collection: string, idOrSlug: string, locale?: string): Promise<ApiResult<{ item: ContentEntry }>>;
  create(collection: string, body: CreateBody): Promise<ApiResult<{ item: { id: string } }>>;
  publish(collection: string, id: string): Promise<ApiResult<unknown>>;
  update(collection: string, id: string, body: UpdateBody): Promise<ApiResult<{ item: ContentEntry }>>;
};

// Error code EmDash's handleContentCreate returns on a unique-slug violation.
const SLUG_CONFLICT = "SLUG_CONFLICT";

export class DuplicateTopicError extends Error {
  constructor(public readonly slug: string) {
    super(`A post with the slug "${slug}" already exists`);
    this.name = "DuplicateTopicError";
  }
}

// Deterministic fallback for titles that slugify() reduces to nothing (e.g.
// non-Latin scripts): a 32-bit FNV-1a hash of the normalized title, so the
// same title always maps to the same slug instead of a Date.now() value that
// changes on every call.
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Letters NFKD does not decompose into a base letter plus marks. Turkish
// dotless ı would otherwise vanish ("Kıbrıs" → "k-br-s"); ç ğ ö ş ü and İ
// decompose and lose their marks below.
const TRANSLITERATE: Record<string, string> = { ı: "i", ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ł: "l" };

export function slugify(title: string): string {
  return title
    .replace(/[ıßæœøđłİÆŒØĐŁ]/g, (ch) => {
      const lower = ch === "İ" ? "i" : ch.toLowerCase();
      return TRANSLITERATE[lower] ?? lower;
    })
    // Apostrophes join a word to its suffix ("Kıbrıs'ın", "don't").
    .replace(/['’]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function slugForTitle(title: string): string {
  return slugify(title) || `post-${fnv1aHex(title.trim().toLowerCase())}`;
}

/** Returns the title's slug, or throws DuplicateTopicError when a post in the same locale already uses it. */
export async function assertSlugAvailable(
  h: ContentHandlers,
  collection: string,
  title: string,
  locale?: string,
): Promise<string> {
  const slug = slugForTitle(title);
  const existing = await h.get(collection, slug, locale);
  if (existing.success) throw new DuplicateTopicError(slug);
  return slug;
}

// EmDash rejects unknown term slugs (and plugins cannot create terms), so
// anything not already in the taxonomy is dropped before create.
export function keepExistingTerms(
  requested: string[],
  existing: TermRef[],
): { kept: string[]; dropped: string[] } {
  const known = new Set(existing.map((t) => t.slug));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const slug of requested) {
    if (!known.has(slug)) dropped.push(slug);
    else if (!kept.includes(slug)) kept.push(slug);
  }
  return { kept, dropped };
}

export type CreatePostInput = {
  collection: string;
  title: string;
  content: PortableTextBlock[];
  excerpt?: string;
  featuredImage?: FeaturedImage;
  status: "draft" | "published";
  categories: string[];
  tags: string[];
  terms: { category: TermRef[]; tag: TermRef[] };
  bylineId?: string;
  publishedAt?: string;
  locale?: string;
  translationOf?: string;
  seo?: { title: string; description: string };
  /** The collection's field slugs; excerpt and featured image are left out when missing. Unknown = keep both. */
  fields?: ReadonlySet<string>;
};

// Writes go through EmDash's runtime (see the ContentHandlers wiring in
// sandbox-entry.ts), so beforeSave/afterSave hooks, media normalization,
// validation and media-usage tracking run exactly as for an admin save.
export async function createPost(
  h: ContentHandlers,
  input: CreatePostInput,
): Promise<{ id: string; slug: string; status: "draft" | "published"; warnings: string[] }> {
  const slug = await assertSlugAvailable(h, input.collection, input.title, input.locale);

  const warnings: string[] = [];
  const categories = keepExistingTerms(input.categories, input.terms.category);
  const tags = keepExistingTerms(input.tags, input.terms.tag);
  for (const d of categories.dropped) warnings.push(`Unknown category "${d}" skipped`);
  for (const d of tags.dropped) warnings.push(`Unknown tag "${d}" skipped`);

  const data: Record<string, unknown> = { title: input.title, content: input.content };
  const has = (field: string) => !input.fields || input.fields.has(field);
  if (input.excerpt && has("excerpt")) data.excerpt = input.excerpt;
  if (input.featuredImage && has("featured_image")) data.featured_image = input.featuredImage;

  const taxonomies: Record<string, string[]> = {};
  if (categories.kept.length > 0) taxonomies.category = categories.kept;
  if (tags.kept.length > 0) taxonomies.tag = tags.kept;

  const result = await h.create(input.collection, {
    data,
    slug,
    status: "draft",
    ...(Object.keys(taxonomies).length > 0 ? { taxonomies } : {}),
    ...(input.bylineId ? { bylines: [{ bylineId: input.bylineId }] } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.translationOf ? { translationOf: input.translationOf } : {}),
    ...(input.seo ? { seo: input.seo } : {}),
  });
  if (result.success === false) {
    // The pre-check above can race another writer (e.g. a cron tick and a
    // manual run); EmDash's unique-slug violation means the same thing.
    if (result.error?.code === SLUG_CONFLICT) throw new DuplicateTopicError(slug);
    throw new Error(result.error?.message ?? "Content create failed");
  }
  const id = result.data.item.id;

  let status: "draft" | "published" = "draft";
  if (input.status === "published") {
    // The draft already exists; a publish failure must not read as "nothing was created".
    let failure: string | undefined;
    try {
      const published = await h.publish(input.collection, id);
      if (published.success === false) failure = published.error?.message ?? "unknown error";
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure === undefined) status = "published";
    else warnings.push(`Created as a draft — publishing failed: ${failure}`);
  }
  return { id, slug, status, warnings };
}
