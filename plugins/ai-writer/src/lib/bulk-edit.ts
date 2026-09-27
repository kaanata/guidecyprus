import { z } from "zod";
import { collectionFeatures, type GetCollectionInfo } from "./collections";
import { runBatchWithConcurrency } from "./concurrency";
import { createPost, DuplicateTopicError, type ContentEntry, type ContentHandlers, type UpdateBody } from "./content";
import { createGenerationClient, type GenerationClient } from "./generation";
import { languageFor, localeOf, localeSchema, type Locale } from "./locale";
import { resolveModel } from "./models";
import type { GenerateTextOutput } from "./openrouter";
import type { Provider } from "./providers";
import { parse, RouteError } from "./routes";
import { readSettings, type KvLike, type Settings } from "./settings";
import type { FeaturedImage, PortableTextBlock, TermRef } from "./types";
import { meter, roundCost } from "./usage";

// Bulk edit: rewrite, summarize or paraphrase the text of several existing
// posts at once, or translate them into new sibling entries in the other
// locale (linked to the source's translation group).

export const BULK_ACTIONS = ["rewrite", "summarize", "paraphrase", "translate"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const MAX_BULK_IDS = 20;
const CONCURRENCY = 3;
const MAX_TITLE = 200;
const MAX_EXCERPT = 400;
const MAX_BLOCKS = 300;
const MAX_SEO_TITLE = 70;
const MAX_SEO_DESCRIPTION = 200;

export const bulkEditSchema = z.object({
  collection: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).default("posts"),
  ids: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(MAX_BULK_IDS)
    .transform((ids) => [...new Set(ids)]),
  action: z.enum(BULK_ACTIONS),
  // Translate only: the locale of the new sibling entries.
  targetLocale: localeSchema.optional(),
  // Blank = the Settings rewrite/default text model.
  model: z.string().trim().max(200).default(""),
  instructions: z.string().max(500).default(""),
});
export type BulkEditRequest = z.output<typeof bulkEditSchema>;

export type SimpleBlock = { style: "normal" | "h2" | "h3" | "bullet"; text: string };

export class BulkEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkEditError";
  }
}

function spanText(children: unknown): string {
  if (!Array.isArray(children)) return "";
  return children
    .map((c) =>
      c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "",
    )
    .join("")
    .trim();
}

/**
 * The post body as plain text blocks, or null when it holds anything besides
 * text blocks (images, embeds, code) that a text rewrite would destroy.
 */
export function toSimpleBlocks(content: unknown): SimpleBlock[] | null {
  if (!Array.isArray(content)) return [];
  const out: SimpleBlock[] = [];
  for (const raw of content) {
    const block = (raw ?? {}) as { _type?: unknown; style?: unknown; listItem?: unknown; children?: unknown };
    if (block._type !== "block") return null;
    const text = spanText(block.children);
    if (!text) continue;
    const style: SimpleBlock["style"] = block.listItem
      ? "bullet"
      : block.style === "h2" || block.style === "h3"
        ? block.style
        : "normal";
    out.push({ style, text });
  }
  return out;
}

export function fromSimpleBlocks(blocks: SimpleBlock[]): PortableTextBlock[] {
  return blocks.map((b, i): PortableTextBlock => {
    const key = `b${i}`;
    const block: PortableTextBlock = {
      _type: "block",
      _key: key,
      style: b.style === "bullet" ? "normal" : b.style,
      markDefs: [],
      children: [{ _type: "span", _key: `${key}s0`, text: b.text, marks: [] }],
    };
    return b.style === "bullet" ? { ...block, listItem: "bullet", level: 1 } : block;
  });
}

const KEEP_LANGUAGE = "Keep the post in its original language.";

const ACTION_BRIEFS: Record<BulkAction, (targetLocale: Locale | undefined) => string> = {
  rewrite: () =>
    `Rewrite the post to improve clarity and engagement without changing its facts or structure. ${KEEP_LANGUAGE}`,
  summarize: () =>
    `Shorten the post to about 40% of its length while keeping its main argument and the headings that still apply. ${KEEP_LANGUAGE}`,
  paraphrase: () =>
    `Paraphrase the post sentence by sentence so the wording changes but the length and meaning stay the same. ${KEEP_LANGUAGE}`,
  translate: (targetLocale) =>
    `Translate the post into ${languageFor(targetLocale ?? "en")}, preserving its structure, tone and meaning. Translate the title and excerpt too, and the SEO title and description when given; keep place names in their usual spelling for that language.`,
};

export type BulkPost = {
  title: string;
  excerpt: string;
  blocks: SimpleBlock[];
  seo?: { title: string; description: string };
};

export function bulkPrompt(
  req: Pick<BulkEditRequest, "action" | "instructions"> & { targetLocale?: Locale },
  post: BulkPost,
  settings: Settings,
): { system: string; prompt: string } {
  const system = [
    settings.promptPrefix.trim(),
    'You edit blog posts. Reply with strict JSON only, shaped {"title": string, "excerpt": string, "blocks": [{"style": "normal" | "h2" | "h3" | "bullet", "text": string}], "seo"?: {"title": string, "description": string}}. Include "seo" only when the post has it. Plain text only: no markdown, no HTML.',
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = [ACTION_BRIEFS[req.action](req.targetLocale), req.instructions.trim(), `POST JSON:\n${JSON.stringify(post)}`]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

const STYLES = new Set(["normal", "h2", "h3", "bullet"]);

export type EditedPost = {
  title: string;
  excerpt: string;
  blocks: SimpleBlock[];
  seo?: { title: string; description: string };
};

function parseSeoPair(value: unknown): EditedPost["seo"] {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { title?: unknown; description?: unknown };
  const title = typeof v.title === "string" ? v.title.trim().slice(0, MAX_SEO_TITLE) : "";
  const description = typeof v.description === "string" ? v.description.trim().slice(0, MAX_SEO_DESCRIPTION) : "";
  return title && description ? { title, description } : undefined;
}

export function parseEdited(out: GenerateTextOutput): EditedPost {
  const obj = (out.json && typeof out.json === "object" && !Array.isArray(out.json) ? out.json : {}) as Record<
    string,
    unknown
  >;
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : Array.isArray(obj.content) ? obj.content : [];
  const blocks: SimpleBlock[] = [];
  for (const raw of rawBlocks.slice(0, MAX_BLOCKS)) {
    const b = (raw ?? {}) as { style?: unknown; text?: unknown; children?: unknown };
    const text = typeof b.text === "string" ? b.text.trim() : spanText(b.children);
    if (!text) continue;
    const style = typeof b.style === "string" && STYLES.has(b.style) ? (b.style as SimpleBlock["style"]) : "normal";
    blocks.push({ style, text });
  }
  if (blocks.length === 0) throw new BulkEditError("The model returned no body text");
  const seo = parseSeoPair(obj.seo);
  return {
    title: typeof obj.title === "string" ? obj.title.trim().slice(0, MAX_TITLE) : "",
    excerpt: typeof obj.excerpt === "string" ? obj.excerpt.trim().slice(0, MAX_EXCERPT) : "",
    blocks,
    ...(seo ? { seo } : {}),
  };
}

/**
 * The edited post as an update body. A translation also carries the new
 * title and, when the source has SEO meta, the translated SEO meta.
 */
export async function editEntry(
  deps: { client: Pick<GenerationClient, "generateText">; settings: Settings },
  entry: ContentEntry,
  req: Pick<BulkEditRequest, "action" | "instructions" | "model"> & { targetLocale?: Locale },
): Promise<UpdateBody> {
  const blocks = toSimpleBlocks(entry.data?.content);
  if (blocks === null) {
    throw new BulkEditError("The body has images or embeds; bulk edit only changes text-only posts");
  }
  if (blocks.length === 0) throw new BulkEditError("The post has no body text");
  const title = typeof entry.data?.title === "string" ? entry.data.title : "";
  const excerpt = typeof entry.data?.excerpt === "string" ? entry.data.excerpt : "";
  const sourceSeo =
    req.action === "translate" && entry.seo?.title && entry.seo.description
      ? { title: entry.seo.title, description: entry.seo.description }
      : undefined;
  const { system, prompt } = bulkPrompt(
    req,
    { title, excerpt, blocks, ...(sourceSeo ? { seo: sourceSeo } : {}) },
    deps.settings,
  );
  const { model, fallbacks } = resolveModel("rewrite", {
    request: req.model,
    settings: deps.settings.models,
    provider: deps.settings.providers.text,
  });
  const edited = parseEdited(
    await deps.client.generateText({
      model,
      fallbackModels: fallbacks,
      system,
      prompt,
      temperature: deps.settings.temperature,
      responseFormat: { type: "json_object" },
    }),
  );
  const data: Record<string, unknown> = { content: fromSimpleBlocks(edited.blocks) };
  if (edited.excerpt) data.excerpt = edited.excerpt;
  // Only a translation changes the title; the other actions keep the headline.
  if (req.action === "translate" && edited.title) data.title = edited.title;
  return { data, ...(sourceSeo && edited.seo ? { seo: edited.seo } : {}) };
}

export type BulkEditRow = {
  id: string;
  title: string;
  status: "ok" | "error";
  error?: string;
  cost?: number;
  /** Translate only: the new sibling entry. */
  createdId?: string;
  warnings?: string[];
};
export type BulkEditResult = { results: BulkEditRow[]; succeeded: number; failed: number; cost: number };

export type ApiListResult =
  | { success: true; data: { items: ContentEntry[] } }
  | { success: false; error?: { message?: string } };

export type BulkEntry = { id: string; title: string; status: string };

const entriesQuerySchema = z.object({
  collection: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).default("posts"),
  // Entries of one locale only, so a batch never mixes languages.
  locale: localeSchema.default("en"),
  q: z.string().trim().max(200).default(""),
});
const ENTRY_LIST_LIMIT = 100;

export type BulkRouteDeps = {
  /** EmDash's content list (newest first). */
  list?(collection: string, params: { limit: number; locale: string; q?: string }): Promise<ApiListResult>;
  kv: KvLike;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  content: Pick<ContentHandlers, "get" | "update" | "create" | "publish">;
  /** Terms of a taxonomy in one locale (translate maps the source's terms onto these). */
  getTerms?(taxonomy: "category" | "tag", locale?: string): Promise<TermRef[]>;
  getEntryTerms?(collection: string, id: string, taxonomy: string, locale?: string): Promise<TermRef[]>;
  getCollectionInfo?: GetCollectionInfo;
  runs?: { put(id: string, data: Record<string, unknown>): Promise<void> };
  now?: () => Date;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function featuredImageOf(value: unknown): FeaturedImage | undefined {
  const v = value as Partial<FeaturedImage> | null | undefined;
  return v && typeof v === "object" && typeof v.id === "string" && typeof v.src === "string"
    ? (v as FeaturedImage)
    : undefined;
}

export function createBulkHandlers(deps: BulkRouteDeps) {
  const now = deps.now ?? (() => new Date());

  // A translation is a new draft in the target locale, linked to the source's
  // translation group; the source post is left untouched. Category and tag
  // slugs are shared across locales, so the source's terms map by slug.
  async function createTranslation(
    collection: string,
    entry: ContentEntry,
    edited: UpdateBody,
    targetLocale: Locale,
  ): Promise<{ id: string; warnings: string[] }> {
    const features = await collectionFeatures(deps.getCollectionInfo, collection);
    const sourceLocale = localeOf(entry.locale);
    const sourceTitle = typeof entry.data?.title === "string" ? entry.data.title : "";
    const title = (typeof edited.data?.title === "string" && edited.data.title) || sourceTitle;
    const sourceSlugs = async (taxonomy: "category" | "tag", supported: boolean) =>
      supported && deps.getEntryTerms
        ? (await deps.getEntryTerms(collection, entry.id, taxonomy, sourceLocale)).map((t) => t.slug)
        : [];
    const targetTerms = async (taxonomy: "category" | "tag", wanted: string[]) =>
      wanted.length > 0 && deps.getTerms ? deps.getTerms(taxonomy, targetLocale) : [];
    const [categories, tags] = await Promise.all([
      sourceSlugs("category", features.categories),
      sourceSlugs("tag", features.tags),
    ]);
    const [category, tag] = await Promise.all([targetTerms("category", categories), targetTerms("tag", tags)]);
    const created = await createPost(deps.content, {
      collection,
      title,
      content: (edited.data?.content ?? []) as PortableTextBlock[],
      excerpt: features.excerpt && typeof edited.data?.excerpt === "string" ? edited.data.excerpt : undefined,
      featuredImage: features.featuredImage ? featuredImageOf(entry.data?.featured_image) : undefined,
      status: "draft",
      categories,
      tags,
      terms: { category, tag },
      locale: targetLocale,
      translationOf: entry.id,
      ...(features.seo && edited.seo?.title && edited.seo.description
        ? { seo: { title: edited.seo.title, description: edited.seo.description } }
        : {}),
    });
    return { id: created.id, warnings: created.warnings };
  }

  return {
    async entries(query: unknown): Promise<{ entries: BulkEntry[] }> {
      const q = parse(entriesQuerySchema, query);
      if (!deps.list) throw new RouteError("unavailable", "Content listing is unavailable");
      const res = await deps.list(q.collection, { limit: ENTRY_LIST_LIMIT, locale: q.locale, ...(q.q ? { q: q.q } : {}) });
      if (res.success === false) throw new RouteError("list_failed", res.error?.message ?? "Posts could not be listed");
      return {
        entries: res.data.items.map((item) => ({
          id: item.id,
          title: typeof item.data?.title === "string" && item.data.title.trim() ? item.data.title : "(untitled)",
          status: item.status ?? "draft",
        })),
      };
    },

    async edit(input: unknown): Promise<BulkEditResult> {
      const req = parse(bulkEditSchema, input);
      const targetLocale = req.targetLocale;
      if (req.action === "translate" && !targetLocale) {
        throw new RouteError("invalid_input", "targetLocale: Choose a language to translate into");
      }
      const settings = await readSettings(deps.kv);
      // Every post needs text, so a missing key fails the whole request up front.
      await deps.getApiKey(settings.providers.text);
      const client = createGenerationClient({
        providers: settings.providers,
        getApiKey: deps.getApiKey,
        fetchImpl: deps.fetchImpl,
      });

      // Each post's failure is caught into its row, so the batch never rejects.
      const { results } = await runBatchWithConcurrency(req.ids, CONCURRENCY, async (id): Promise<BulkEditRow> => {
        const startedAt = now().toISOString();
        let title = "";
        let row: BulkEditRow;
        const metered = meter(client);
        try {
          const got = await deps.content.get(req.collection, id);
          if (got.success === false) throw new BulkEditError(got.error?.message ?? "Post not found");
          const entry = got.data.item;
          title = typeof entry.data?.title === "string" ? entry.data.title : "";
          if (targetLocale && req.action === "translate") {
            if (localeOf(entry.locale) === targetLocale) {
              throw new BulkEditError(`The post is already in ${languageFor(targetLocale)}`);
            }
            const edited = await editEntry({ client: metered.client, settings }, entry, { ...req, targetLocale });
            const created = await createTranslation(req.collection, entry, edited, targetLocale);
            row = {
              id,
              title,
              status: "ok",
              createdId: created.id,
              ...(created.warnings.length > 0 ? { warnings: created.warnings } : {}),
            };
          } else {
            const updated = await deps.content.update(
              req.collection,
              entry.id,
              await editEntry({ client: metered.client, settings }, entry, req),
            );
            if (updated.success === false) {
              throw new BulkEditError(updated.error?.message ?? "The post could not be updated");
            }
            row = { id, title, status: "ok" };
          }
        } catch (err) {
          const message =
            err instanceof DuplicateTopicError
              ? `A ${languageFor(targetLocale ?? "en")} post with the slug "${err.slug}" already exists`
              : messageOf(err);
          row = { id, title, status: "error", error: message };
        }
        row.cost = roundCost(metered.state.cost);
        const postId = row.createdId ?? id;
        try {
          await deps.runs?.put(`bulk-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, {
            source: "bulk",
            postId,
            editUrl: `/_emdash/admin/content/${req.collection}/${postId}`,
            topic: `${req.action}: ${title || id}${req.action === "translate" && targetLocale ? ` → ${targetLocale}` : ""}`,
            status: row.status,
            ...(row.error ? { error: row.error } : {}),
            warnings: row.warnings ?? [],
            calls: metered.state.calls,
            cost: roundCost(metered.state.cost),
            tokens: metered.state.tokens,
            startedAt,
            finishedAt: now().toISOString(),
          });
        } catch {
          // Run history is best-effort; the edit itself already happened.
        }
        return row;
      });
      const rows = results.filter((r): r is BulkEditRow => r !== undefined);
      return {
        results: rows,
        succeeded: rows.filter((r) => r.status === "ok").length,
        failed: rows.filter((r) => r.status === "error").length,
        cost: roundCost(rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)),
      };
    },
  };
}

export type BulkHandlers = ReturnType<typeof createBulkHandlers>;
