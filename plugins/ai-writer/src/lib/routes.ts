import { z } from "zod";
import { assemble, structureFor } from "./assemble";
import { collectionFeatures, type CollectionFeatures, type GetCollectionInfo } from "./collections";
import { createPost, DuplicateTopicError, type ContentHandlers } from "./content";
import { createGenerationClient } from "./generation";
import { generateFeaturedImage, ImageError, imagePromptFor, type MediaUploader } from "./image";
import { localeSchema } from "./locale";
import { getModelsResponse, type ModelsResponse } from "./models";
import { deslopArticle, slopAskFor } from "./slop";
import { meter, recordImagePrices, roundCost } from "./usage";
import type { Provider } from "./providers";
import { defaultSettings, readSettings, writeSettings, type KvLike, type Settings } from "./settings";
import {
  generateExcerpt,
  generateFaq,
  generateIntro,
  generateOutline,
  generateOutro,
  generateSection,
  generateSeo,
  generateTags,
  generateTitle,
  StepError,
  type StepContext,
} from "./steps";
import type { FaqItem, FeaturedImage, TermRef } from "./types";

export class RouteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

export type RouteDeps = {
  kv: KvLike;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  media?: MediaUploader;
  /** Terms of a taxonomy in one locale (terms exist per locale with the same slugs). */
  getTerms(taxonomy: "category" | "tag", locale?: string): Promise<TermRef[]>;
  /** Fields, SEO support and taxonomies of a collection; unknown = attempt everything but SEO. */
  getCollectionInfo?: GetCollectionInfo;
  content: ContentHandlers;
  runs?: { put(id: string, data: Record<string, unknown>): Promise<void> };
  now?: () => Date;
};

export function issuesMessage(issues: z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new RouteError("invalid_input", issuesMessage(r.error.issues));
  return r.data;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const collectionSlug = z.string().trim().regex(/^[a-z][a-z0-9_]*$/);
const common = {
  model: z.string().trim().max(200).optional(),
  // Content locale; sets the writing language (Settings' language when absent).
  locale: localeSchema.optional(),
  style: z.string().trim().max(60).optional(),
  tone: z.string().trim().max(60).optional(),
  instructions: z.string().max(500).optional(),
};
const headingList = z.array(text(200)).min(1).max(12);

export const stepRequestSchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("title"), topic: text(300), ...common }),
  z.object({ step: z.literal("outline"), title: text(200), count: z.number().int().min(2).max(12), ...common }),
  z.object({
    step: z.literal("section"),
    title: text(200),
    heading: text(200),
    paragraphs: z.number().int().min(1).max(6),
    ...common,
  }),
  z.object({ step: z.literal("intro"), title: text(200), headings: headingList, ...common }),
  z.object({ step: z.literal("outro"), title: text(200), headings: headingList, ...common }),
  z.object({ step: z.literal("faq"), title: text(200), ...common }),
  z.object({ step: z.literal("excerpt"), title: text(200), headings: headingList, ...common }),
  z.object({ step: z.literal("tags"), title: text(200), ...common }),
]);
export type StepRequest = z.infer<typeof stepRequestSchema>;

type StepValue =
  | { step: "title"; title: string }
  | { step: "outline"; headings: string[] }
  | { step: "section" | "intro" | "outro"; paragraphs: string[] }
  | { step: "faq"; items: FaqItem[] }
  | { step: "excerpt"; excerpt: string }
  | { step: "tags"; tags: string[] };
/** A step's value plus what it cost (USD, as reported by the provider). */
export type StepResult = StepValue & { cost: number };

const imageRequestSchema = z.object({
  prompt: text(1000),
  alt: z.string().trim().max(300).optional(),
  model: common.model,
});

const featuredImageSchema = z.object({
  provider: z.literal("local"),
  id: text(100),
  src: text(2000),
  alt: z.string().max(300),
});

export const expressCreateSchema = z.object({
  title: text(200),
  intro: z.array(z.string()).max(6).default([]),
  sections: z
    .array(z.object({ heading: text(200), paragraphs: z.array(z.string()).min(1).max(12) }))
    .min(1)
    .max(12),
  outro: z.array(z.string()).max(6).default([]),
  faq: z.array(z.object({ q: text(300), a: text(2000) })).max(8).default([]),
  excerpt: z.string().max(400).default(""),
  featuredImage: featuredImageSchema.optional(),
  structure: z
    .object({
      headingLevel: z.enum(["h2", "h3"]).default("h2"),
      toc: z.boolean().default(false),
      outroHeader: z.string().trim().max(80).default(""),
    })
    .default({ headingLevel: "h2", toc: false, outroHeader: "" }),
  post: z
    .object({
      collection: collectionSlug.default("posts"),
      status: z.enum(["draft", "published"]).default("draft"),
      locale: localeSchema.default("en"),
      categories: z.array(z.string()).max(20).default([]),
      tags: z.array(z.string()).max(30).default([]),
    })
    .default({ collection: "posts", status: "draft", locale: "en", categories: [], tags: [] }),
});
export type ExpressCreateInput = z.input<typeof expressCreateSchema>;
const termsQuerySchema = z.object({
  collection: collectionSlug.default("posts"),
  locale: localeSchema.default("en"),
});

export type TermsResponse = { category: TermRef[]; tag: TermRef[]; features: CollectionFeatures };

export type ExpressCreateResult = {
  postId: string;
  slug: string;
  status: "draft" | "published";
  warnings: string[];
  editUrl: string;
  /** Cost of the no-AI-slop edit and SEO meta (USD). */
  cost: number;
};

export function createRouteHandlers(deps: RouteDeps) {
  const now = deps.now ?? (() => new Date());

  function clientFor(settings: Settings) {
    return createGenerationClient({
      providers: settings.providers,
      getApiKey: deps.getApiKey,
      fetchImpl: deps.fetchImpl,
    });
  }

  async function stepContext(req: StepRequest, client: StepContext["client"]): Promise<StepContext> {
    const settings = await readSettings(deps.kv);
    return {
      client,
      settings,
      mode: "article",
      params: { style: req.style, tone: req.tone },
      locale: req.locale,
      instructions: req.instructions,
    };
  }

  async function runStep(req: StepRequest, ctx: StepContext): Promise<StepValue> {
    switch (req.step) {
      case "title":
        return { step: "title", title: await generateTitle(ctx, { topic: req.topic }, req.model) };
      case "outline":
        return {
          step: "outline",
          headings: await generateOutline(ctx, { title: req.title, count: req.count }, req.model),
        };
      case "section":
        return {
          step: "section",
          paragraphs: await generateSection(
            ctx,
            { title: req.title, heading: req.heading, paragraphs: req.paragraphs },
            req.model,
          ),
        };
      case "intro":
        return {
          step: "intro",
          paragraphs: await generateIntro(ctx, { title: req.title, headings: req.headings }, req.model),
        };
      case "outro":
        return {
          step: "outro",
          paragraphs: await generateOutro(ctx, { title: req.title, headings: req.headings }, req.model),
        };
      case "faq":
        return { step: "faq", items: await generateFaq(ctx, { title: req.title }, req.model) };
      case "excerpt":
        return {
          step: "excerpt",
          excerpt: await generateExcerpt(ctx, { title: req.title, headings: req.headings }, req.model),
        };
      case "tags":
        return {
          step: "tags",
          tags: await generateTags(
            ctx,
            { title: req.title, existing: await deps.getTerms("tag", req.locale ?? "en") },
            req.model,
          ),
        };
      default:
        throw new RouteError("invalid_input", "Unknown step");
    }
  }

  return {
    async getSettings(): Promise<{ settings: Settings; defaults: Settings }> {
      return { settings: await readSettings(deps.kv), defaults: defaultSettings };
    },

    async saveSettings(input: unknown): Promise<{ settings: Settings }> {
      try {
        return { settings: await writeSettings(deps.kv, input) };
      } catch (err) {
        if (err instanceof z.ZodError) throw new RouteError("invalid_input", issuesMessage(err.issues));
        throw err;
      }
    },

    async models(): Promise<ModelsResponse> {
      const settings = await readSettings(deps.kv);
      return getModelsResponse({
        kv: deps.kv,
        providers: settings.providers,
        getApiKey: deps.getApiKey,
        fetchImpl: deps.fetchImpl,
        now: now().getTime(),
      });
    },

    /** Term pickers for one collection and locale: only that locale's terms, only taxonomies the collection uses. */
    async terms(query: unknown = {}): Promise<TermsResponse> {
      const q = parse(termsQuerySchema, query);
      const features = await collectionFeatures(deps.getCollectionInfo, q.collection);
      const [category, tag] = await Promise.all([
        features.categories ? deps.getTerms("category", q.locale) : Promise.resolve([]),
        features.tags ? deps.getTerms("tag", q.locale) : Promise.resolve([]),
      ]);
      return { category, tag, features };
    },

    async step(input: unknown): Promise<StepResult> {
      const req = parse(stepRequestSchema, input);
      const metered = meter(clientFor(await readSettings(deps.kv)));
      const ctx = await stepContext(req, metered.client);
      try {
        return { ...(await runStep(req, ctx)), cost: roundCost(metered.state.cost) };
      } catch (err) {
        if (err instanceof RouteError) throw err;
        if (err instanceof StepError) throw new RouteError("step_failed", err.message);
        throw new RouteError("openrouter_error", (err as Error).message);
      }
    },

    async image(input: unknown): Promise<{ featuredImage: FeaturedImage; cost: number }> {
      const req = parse(imageRequestSchema, input);
      const settings = await readSettings(deps.kv);
      const metered = meter(clientFor(settings));
      try {
        const featuredImage = await generateFeaturedImage(
          { client: metered.client, media: deps.media, settings },
          { prompt: imagePromptFor(req.prompt), alt: req.alt || req.prompt, model: req.model },
        );
        await recordImagePrices(deps.kv, metered.imageCosts);
        return { featuredImage, cost: roundCost(metered.state.cost) };
      } catch (err) {
        // Keys load lazily, so missing_api_key surfaces here; keep its code.
        if (err instanceof RouteError) throw err;
        throw new RouteError(err instanceof ImageError ? "image_failed" : "openrouter_error", (err as Error).message);
      }
    },

    async expressCreate(input: unknown): Promise<ExpressCreateResult> {
      const req = parse(expressCreateSchema, input);
      const startedAt = now().toISOString();
      const { collection, locale } = req.post;
      const features = await collectionFeatures(deps.getCollectionInfo, collection);
      const structure = structureFor(locale);
      let content = assemble(
        { title: req.title, intro: req.intro, sections: req.sections, outro: req.outro, faq: req.faq },
        {
          ...structure,
          headingLevel: req.structure.headingLevel,
          toc: req.structure.toc,
          outroHeader: req.structure.outroHeader || structure.outroHeader,
        },
      );
      // No-AI-slop edit before the post exists; a failure keeps the article as written.
      let excerpt = req.excerpt;
      const slopWarnings: string[] = [];
      const settings = await readSettings(deps.kv);
      // One metered client for the edit and SEO, so the run records their cost.
      const metered = meter(clientFor(settings));
      if (settings.noAiSlop.enabled) {
        try {
          const ask = slopAskFor(metered.client, settings);
          const edited = await deslopArticle(ask, { title: req.title, excerpt, content, locale });
          content = edited.content as typeof content;
          excerpt = edited.excerpt;
          if (edited.after.length > 0) slopWarnings.push(`AI-slop patterns still present: ${edited.after.join(", ")}`);
        } catch (err) {
          slopWarnings.push(`no-AI-slop edit skipped: ${(err as Error).message}`);
        }
      }
      let seo: { title: string; description: string } | undefined;
      if (features.seo) {
        try {
          const meta = await generateSeo(
            { client: metered.client, settings, mode: "article", locale },
            { title: req.title, excerpt },
          );
          seo = { title: meta.metaTitle, description: meta.metaDescription };
        } catch (err) {
          slopWarnings.push(`SEO skipped: ${(err as Error).message}`);
        }
      }
      const categories = features.categories ? req.post.categories : [];
      const tags = features.tags ? req.post.tags : [];
      const [category, tag] = await Promise.all([
        categories.length > 0 ? deps.getTerms("category", locale) : Promise.resolve([]),
        tags.length > 0 ? deps.getTerms("tag", locale) : Promise.resolve([]),
      ]);
      let created: { id: string; slug: string; status: "draft" | "published"; warnings: string[] };
      try {
        created = await createPost(deps.content, {
          collection,
          title: req.title,
          content,
          excerpt: features.excerpt ? excerpt || undefined : undefined,
          featuredImage: features.featuredImage ? req.featuredImage : undefined,
          status: req.post.status,
          categories,
          tags,
          terms: { category, tag },
          locale,
          seo,
        });
      } catch (err) {
        if (err instanceof DuplicateTopicError) throw new RouteError("duplicate", err.message);
        throw new RouteError("create_failed", (err as Error).message);
      }
      created.warnings.unshift(...slopWarnings);
      // The post already exists at this point — a run-history recording
      // failure must never surface as a route failure (that would read as
      // "nothing was created" when a draft was, in fact, created).
      try {
        await deps.runs?.put(`express-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`, {
          source: "express",
          topic: req.title,
          postId: created.id,
          editUrl: `/_emdash/admin/content/${collection}/${created.id}`,
          status: "ok",
          warnings: created.warnings,
          calls: metered.state.calls,
          cost: roundCost(metered.state.cost),
          tokens: metered.state.tokens,
          startedAt,
          finishedAt: now().toISOString(),
        });
      } catch (err) {
        created.warnings.push(`Run history could not be recorded: ${(err as Error).message}`);
      }
      return {
        postId: created.id,
        slug: created.slug,
        status: created.status,
        warnings: created.warnings,
        editUrl: `/_emdash/admin/content/${collection}/${created.id}`,
        cost: roundCost(metered.state.cost),
      };
    },
  };
}

export type RouteHandlers = ReturnType<typeof createRouteHandlers>;
