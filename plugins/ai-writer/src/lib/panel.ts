import { z } from "zod";
import { assemble, structureFor } from "./assemble";
import { featuresOf, type CollectionFeatures } from "./collections";
import { runBatchWithConcurrency } from "./concurrency";
import type { ContentEntry, UpdateBody } from "./content";
import { generateFeaturedImage, imagePromptFor, type MediaUploader } from "./image";
import { DEFAULT_LOCALE, localeSchema, type Locale } from "./locale";
import type { OpenRouterClient } from "./openrouter";
import { countingClient } from "./pipeline";
import { roundCost } from "./usage";
import { rewriteOutline } from "./portable-text";
import type { Settings } from "./settings";
import {
  generateExcerpt,
  generateImagePrompt,
  generateIntro,
  generateOutline,
  generateOutro,
  generateRewrite,
  generateSeo,
  generateTags,
  generateTitle,
  type SeoMeta,
  type StepContext,
} from "./steps";
import type { FeaturedImage, PortableTextBlock, Section, TermRef } from "./types";

export const PANEL_FIELDS = ["title", "excerpt", "tags", "seo", "image", "rewrite"] as const;
export type PanelField = (typeof PANEL_FIELDS)[number];

const collectionSchema = z.string().trim().regex(/^[a-z][a-z0-9_]*$/);
const entryIdSchema = z.string().trim().min(1).max(100);

export const panelGenerateSchema = z.object({
  collection: collectionSchema,
  id: entryIdSchema,
  fields: z.array(z.enum(PANEL_FIELDS)).min(1).max(PANEL_FIELDS.length),
  // Blank = use Settings.
  models: z.partialRecord(z.enum(PANEL_FIELDS), z.string().trim().max(200)).default({}),
  instructions: z.string().max(500).default(""),
  // The editor's locale; the saved entry's own locale wins when it has one.
  locale: localeSchema.optional(),
});
export type PanelGenerateRequest = z.output<typeof panelGenerateSchema>;

const spanSchema = z.object({
  _type: z.literal("span"),
  _key: z.string().max(40),
  text: z.string().max(10_000),
  marks: z.array(z.string().max(40)).max(10),
});

// Only the block shapes the assembler produces (and the site renders).
const blockSchema = z.object({
  _type: z.literal("block"),
  _key: z.string().max(40),
  style: z.enum(["normal", "h2", "h3"]),
  listItem: z.literal("bullet").optional(),
  level: z.number().int().min(1).max(3).optional(),
  markDefs: z.array(z.never()).max(0),
  children: z.array(spanSchema).min(1).max(50),
});

const featuredImageSchema = z.object({
  provider: z.literal("local"),
  id: z.string().trim().min(1).max(100),
  src: z.string().trim().min(1).max(2000),
  alt: z.string().max(300),
});

export const panelValuesSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  excerpt: z.string().trim().min(1).max(400).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  seo: z
    .object({
      metaTitle: z.string().trim().min(1).max(70),
      metaDescription: z.string().trim().min(1).max(200),
    })
    .optional(),
  content: z.array(blockSchema).min(1).max(300).optional(),
  featuredImage: featuredImageSchema.optional(),
});
export type PanelValues = z.output<typeof panelValuesSchema>;

export const panelApplySchema = z.object({
  collection: collectionSchema,
  id: entryIdSchema,
  values: panelValuesSchema,
  locale: localeSchema.optional(),
});

// What the panel previews; tags come back as terms so the UI can show labels.
export type PanelPreview = {
  title?: string;
  excerpt?: string;
  tags?: TermRef[];
  seo?: SeoMeta;
  content?: PortableTextBlock[];
  featuredImage?: FeaturedImage;
};

export type PanelGenerateResult = {
  values: PanelPreview;
  errors: Partial<Record<PanelField, string>>;
  warnings: string[];
  calls: number;
  cost: number;
  tokens: number;
  imageCosts: Record<string, number>;
};

export type PanelDeps = {
  client: Pick<OpenRouterClient, "generateText" | "generateImage">;
  settings: Settings;
  /** Every existing tag term in the entry's locale (the model may only pick from these). */
  tagTerms: TermRef[];
  /** Slugs of the tags already on the entry. */
  entryTags: string[];
  media?: MediaUploader;
  /** The entry's locale; sets the writing language and the rewrite's structural headers. */
  locale?: Locale;
  /** What the entry's collection can hold; unknown = everything but SEO. */
  features?: CollectionFeatures;
};

const REWRITE_PARAGRAPHS = 2;
const REWRITE_FALLBACK_SECTIONS = 4;
const REWRITE_CONCURRENCY = 3;
const REWRITE_MAX_SECTIONS = 12;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function entryTitle(entry: ContentEntry): string {
  const title = entry.data?.title;
  return typeof title === "string" ? title.trim() : "";
}

// Regenerates the whole body; all-or-nothing (Ruling 4).
async function rewriteContent(
  ctx: StepContext,
  title: string,
  content: unknown,
  model: string | undefined,
  locale: Locale,
): Promise<PortableTextBlock[]> {
  let headings = rewriteOutline(content);
  if (headings.length < 2) {
    headings = await generateOutline(ctx, { title, count: REWRITE_FALLBACK_SECTIONS }, model);
  }
  headings = headings.slice(0, REWRITE_MAX_SECTIONS);
  const [intro, outro] = await Promise.all([
    generateIntro(ctx, { title, headings }, model),
    generateOutro(ctx, { title, headings }, model),
  ]);
  const { results, errors } = await runBatchWithConcurrency(headings, REWRITE_CONCURRENCY, (heading) =>
    generateRewrite(ctx, { title, heading, paragraphs: REWRITE_PARAGRAPHS }, model),
  );
  if (errors.length > 0) throw errors[0].error;
  const sections: Section[] = headings.map((heading, i) => ({ heading, paragraphs: results[i] as string[] }));
  return assemble({ title, intro, sections, outro, faq: [] }, structureFor(locale));
}

export async function generatePanelValues(
  deps: PanelDeps,
  entry: ContentEntry,
  req: PanelGenerateRequest,
): Promise<PanelGenerateResult> {
  const counter = countingClient(deps.client);
  const locale = deps.locale ?? DEFAULT_LOCALE;
  const features = deps.features ?? featuresOf(null);
  const ctx: StepContext = {
    client: counter.client,
    settings: deps.settings,
    mode: "article",
    locale,
    instructions: req.instructions,
  };
  const title = entryTitle(entry);
  const content = entry.data?.content;
  const savedExcerpt = typeof entry.data?.excerpt === "string" ? entry.data.excerpt : "";
  const outline = rewriteOutline(content);
  const excerptHeadings = outline.length > 0 ? outline : [title];

  const values: PanelPreview = {};
  const errors: Partial<Record<PanelField, string>> = {};
  const warnings: string[] = [];
  const wanted = new Set(req.fields);
  const model = (field: PanelField) => req.models[field] || undefined;
  // Fields the collection cannot store are refused before any model call.
  const unsupported: Partial<Record<PanelField, string>> = {
    ...(features.excerpt ? {} : { excerpt: "This collection has no excerpt field" }),
    ...(features.tags ? {} : { tags: "This collection has no tags" }),
    ...(features.seo ? {} : { seo: "This collection has no SEO settings" }),
    ...(features.featuredImage ? {} : { image: "This collection has no featured image field" }),
  };
  const attempt = async (field: PanelField, run: () => Promise<void>) => {
    if (!wanted.has(field)) return;
    const refusal = unsupported[field];
    if (refusal) {
      errors[field] = refusal;
      return;
    }
    try {
      await run();
    } catch (err) {
      errors[field] = messageOf(err);
    }
  };

  await attempt("title", async () => {
    values.title = await generateTitle(ctx, { topic: title }, model("title"));
  });
  await attempt("excerpt", async () => {
    values.excerpt = await generateExcerpt(ctx, { title, headings: excerptHeadings }, model("excerpt"));
  });
  await attempt("tags", async () => {
    const slugs = await generateTags(ctx, { title, existing: deps.tagTerms }, model("tags"));
    const onEntry = new Set(deps.entryTags);
    const bySlug = new Map(deps.tagTerms.map((t) => [t.slug, t]));
    values.tags = slugs
      .filter((slug) => !onEntry.has(slug))
      .map((slug) => bySlug.get(slug))
      .filter((term): term is TermRef => term !== undefined);
    if (values.tags.length === 0) warnings.push("No new matching tags were suggested");
  });
  await attempt("seo", async () => {
    values.seo = await generateSeo(ctx, { title, excerpt: values.excerpt ?? savedExcerpt }, model("seo"));
  });
  await attempt("image", async () => {
    values.featuredImage = await generateFeaturedImage(
      { client: counter.client, media: deps.media, settings: deps.settings },
      {
        prompt: imagePromptFor((await generateImagePrompt(ctx, { title }).catch(() => "")) || title),
        alt: title,
        model: model("image"),
      },
    );
  });
  await attempt("rewrite", async () => {
    values.content = await rewriteContent(ctx, title, content, model("rewrite"), locale);
  });

  return {
    values,
    errors,
    warnings,
    calls: counter.state.calls,
    cost: roundCost(counter.state.cost),
    tokens: counter.state.tokens,
    imageCosts: counter.imageCosts,
  };
}

// Tags merge with the entry's current tags: EmDash replaces every term of a
// taxonomy named in `taxonomies`, so the union is written (Ruling 3). Values
// the collection cannot store (image, excerpt, tags, SEO) are left out.
export function buildUpdateBody(
  values: PanelValues,
  currentTags: string[],
  features: CollectionFeatures = featuresOf(null),
): UpdateBody {
  const body: UpdateBody = {};
  const data: Record<string, unknown> = {};
  if (values.title) data.title = values.title;
  if (values.excerpt && features.excerpt) data.excerpt = values.excerpt;
  if (values.content) data.content = values.content;
  if (values.featuredImage && features.featuredImage) data.featured_image = values.featuredImage;
  if (Object.keys(data).length > 0) body.data = data;
  if (values.tags && values.tags.length > 0 && features.tags) {
    body.taxonomies = { tag: [...new Set([...currentTags, ...values.tags])] };
  }
  if (values.seo && features.seo) body.seo = { title: values.seo.metaTitle, description: values.seo.metaDescription };
  return body;
}
