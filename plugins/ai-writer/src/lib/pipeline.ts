import { assemble, structureFor } from "./assemble";
import { collectionFeatures, type GetCollectionInfo } from "./collections";
import { runBatchWithConcurrency } from "./concurrency";
import { assertSlugAvailable, createPost, DuplicateTopicError, type ContentHandlers } from "./content";
import { generateFeaturedImage, imagePromptFor, type MediaUploader } from "./image";
import type { Locale } from "./locale";
import { parseTopicLine } from "./topic-line";
import { deslopArticle, slopAskFor } from "./slop";
import { meter, roundCost } from "./usage";
import type { OpenRouterClient } from "./openrouter";
import type { Settings } from "./settings";
import {
  generateExcerpt,
  generateFaq,
  generateImagePrompt,
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
import type { ContentParams, FaqItem, Mode, ModelOverrides, Section, TermRef } from "./types";

export type PipelineOptions = {
  mode: Mode;
  topicMode: "topic" | "title";
  sections: number;
  headingLevel: "h2" | "h3";
  paragraphsPerSection: number;
  intro: boolean;
  outro: boolean;
  outroHeader: string;
  toc: boolean;
  faq: boolean;
  featuredImage: boolean;
  collection: string;
  status: "draft" | "published";
  categories: string[];
  tags: string[];
  autoTags: boolean;
  /** Content locale of the post; also sets the writing language. */
  locale: Locale;
  params: ContentParams;
  models: ModelOverrides;
  /** Extra guidance for every step; blank = none. */
  instructions?: string;
  /** Byline slug credited on the post; blank = none. */
  byline?: string;
};

export type PipelineDeps = {
  client: Pick<OpenRouterClient, "generateText" | "generateImage">;
  settings: Settings;
  media?: MediaUploader;
  content: ContentHandlers;
  /** Terms of a taxonomy in one locale (terms exist per locale with the same slugs). */
  getTerms(taxonomy: "category" | "tag", locale?: string): Promise<TermRef[]>;
  /** The collection's fields, SEO support and taxonomies; unknown = attempt everything but SEO. */
  getCollectionInfo?: GetCollectionInfo;
  /** Resolves a byline slug to its id (null when missing). */
  getBylineId?(slug: string): Promise<string | null>;
  now?: () => Date;
};

export type PipelineResult = {
  postId: string;
  slug: string;
  title: string;
  status: "draft" | "published";
  warnings: string[];
  calls: number;
  cost: number;
  tokens: number;
  /** Last cost per image model seen in this run. */
  imageCosts: Record<string, number>;
};

export class PipelineError extends Error {
  constructor(
    public readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = "PipelineError";
  }
}

const PART_CONCURRENCY = 3;
const MAX_TOPIC_TITLE = 200;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toPipelineError(step: string, err: unknown): PipelineError {
  return err instanceof StepError ? new PipelineError(err.step, err.message) : new PipelineError(step, messageOf(err));
}

async function fatal<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toPipelineError(step, err);
  }
}

async function optional<T>(step: string, warnings: string[], run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    warnings.push(`${step} skipped: ${messageOf(err)}`);
    return undefined;
  }
}

// Counts every provider call (a fallback retry inside one call counts once) and sums reported cost.
export function countingClient(client: PipelineDeps["client"]) {
  return meter(client);
}

type Job = { kind: "section"; heading: string } | { kind: "intro" } | { kind: "outro" } | { kind: "faq" };

export async function runPipeline(deps: PipelineDeps, topicLine: string, opts: PipelineOptions): Promise<PipelineResult> {
  // "2026-08-03 | topic" publishes the post with that (past) date.
  const { topic, publishedAt } = parseTopicLine(topicLine, (deps.now ?? (() => new Date()))());
  const counter = countingClient(deps.client);
  const ctx: StepContext = {
    client: counter.client,
    settings: deps.settings,
    mode: opts.mode,
    ruleModels: opts.models,
    params: opts.params,
    locale: opts.locale,
    instructions: opts.instructions,
  };
  const warnings: string[] = [];
  const locale = opts.locale;
  const features = await collectionFeatures(deps.getCollectionInfo, opts.collection);

  const title =
    opts.topicMode === "title"
      ? topic.trim().slice(0, MAX_TOPIC_TITLE).trim()
      : await fatal("title", () => generateTitle(ctx, { topic }));
  if (!title) throw new PipelineError("title", "The topic is empty");

  // Fail fast on an existing slug before spending calls on the body.
  await assertSlugAvailable(deps.content, opts.collection, title, locale);

  const headings = await fatal("outline", () => generateOutline(ctx, { title, count: opts.sections }));

  const jobs: Job[] = [
    ...headings.map((heading): Job => ({ kind: "section", heading })),
    ...(opts.intro ? [{ kind: "intro" } as Job] : []),
    ...(opts.outro ? [{ kind: "outro" } as Job] : []),
    ...(opts.faq ? [{ kind: "faq" } as Job] : []),
  ];
  const { results, errors } = await runBatchWithConcurrency(
    jobs,
    PART_CONCURRENCY,
    async (job): Promise<string[] | FaqItem[]> => {
      switch (job.kind) {
        case "section":
          return generateSection(ctx, { title, heading: job.heading, paragraphs: opts.paragraphsPerSection });
        case "intro":
          return generateIntro(ctx, { title, headings });
        case "outro":
          return generateOutro(ctx, { title, headings });
        case "faq":
          return generateFaq(ctx, { title });
      }
    },
  );
  const failures = new Map(errors.map((e) => [e.index, e.error]));

  const sections: Section[] = [];
  let intro: string[] = [];
  let outro: string[] = [];
  let faq: FaqItem[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (failures.has(i)) {
      if (job.kind === "section") throw toPipelineError("section", failures.get(i));
      warnings.push(`${job.kind} skipped: ${messageOf(failures.get(i))}`);
      continue;
    }
    const value = results[i];
    if (job.kind === "section") sections.push({ heading: job.heading, paragraphs: value as string[] });
    else if (job.kind === "intro") intro = value as string[];
    else if (job.kind === "outro") outro = value as string[];
    else faq = value as FaqItem[];
  }

  // The excerpt also feeds the SEO description.
  const excerpt =
    features.excerpt || features.seo
      ? ((await optional("excerpt", warnings, () => generateExcerpt(ctx, { title, headings }))) ?? "")
      : "";

  let categories = opts.categories;
  if (!features.categories && categories.length > 0) {
    warnings.push(`Collection "${opts.collection}" has no categories; skipped ${categories.join(", ")}`);
    categories = [];
  }
  let tags = opts.tags;
  if (!features.tags) {
    if (tags.length > 0) warnings.push(`Collection "${opts.collection}" has no tags; skipped ${tags.join(", ")}`);
    tags = [];
  } else if (opts.autoTags) {
    const auto = await optional("tags", warnings, async () =>
      generateTags(ctx, { title, existing: await deps.getTerms("tag", locale) }),
    );
    if (auto) tags = [...new Set([...tags, ...auto])];
  }

  let featuredImage: Awaited<ReturnType<typeof generateFeaturedImage>> | undefined;
  if (opts.featuredImage && features.featuredImage) {
    // The text model describes the scene; the image model draws it.
    const scene = (await optional("image prompt", warnings, () => generateImagePrompt(ctx, { title }))) ?? title;
    featuredImage = await optional("image", warnings, () =>
      generateFeaturedImage(
        { client: counter.client, media: deps.media, settings: deps.settings, ruleModels: opts.models },
        { prompt: imagePromptFor(scene), alt: title },
      ),
    );
  }

  const structure = structureFor(locale);
  let content = assemble(
    { title, intro, sections, outro, faq },
    {
      ...structure,
      headingLevel: opts.headingLevel,
      toc: opts.toc,
      outroHeader: opts.outroHeader.trim() || structure.outroHeader,
    },
  );
  let finalExcerpt = excerpt;
  if (deps.settings.noAiSlop.enabled) {
    const edited = await optional("no-AI-slop edit", warnings, () =>
      deslopArticle(slopAskFor(counter.client, deps.settings), { title, excerpt, content, locale }),
    );
    if (edited) {
      content = edited.content as typeof content;
      finalExcerpt = edited.excerpt;
      if (edited.after.length > 0) warnings.push(`AI-slop patterns still present: ${edited.after.join(", ")}`);
    }
  }

  let seo: { title: string; description: string } | undefined;
  if (features.seo) {
    const meta = await optional("SEO", warnings, () => generateSeo(ctx, { title, excerpt: finalExcerpt }));
    if (meta) seo = { title: meta.metaTitle, description: meta.metaDescription };
  }

  const [category, tag] = await Promise.all([
    categories.length > 0 ? deps.getTerms("category", locale) : Promise.resolve([]),
    tags.length > 0 ? deps.getTerms("tag", locale) : Promise.resolve([]),
  ]);
  let bylineId: string | undefined;
  const bylineSlug = opts.byline?.trim();
  if (bylineSlug) {
    const id = await optional("byline", warnings, async () => (deps.getBylineId ? deps.getBylineId(bylineSlug) : null));
    if (id) bylineId = id;
    else if (id === null) warnings.push(`Byline "${bylineSlug}" not found; post has no byline`);
  }
  let created: { id: string; slug: string; status: "draft" | "published"; warnings: string[] };
  try {
    created = await createPost(deps.content, {
      collection: opts.collection,
      title,
      content,
      excerpt: features.excerpt ? finalExcerpt || undefined : undefined,
      featuredImage,
      status: opts.status,
      categories,
      tags,
      terms: { category, tag },
      bylineId,
      publishedAt,
      locale,
      seo,
    });
  } catch (err) {
    if (err instanceof DuplicateTopicError) throw err;
    throw new PipelineError("create", messageOf(err));
  }

  return {
    postId: created.id,
    slug: created.slug,
    title,
    status: created.status,
    warnings: [...warnings, ...created.warnings],
    calls: counter.state.calls,
    cost: roundCost(counter.state.cost),
    tokens: counter.state.tokens,
    imageCosts: counter.imageCosts,
  };
}

export { runBatchWithConcurrency };
