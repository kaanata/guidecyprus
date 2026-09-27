import { z } from "zod";
import { collectionFeatures, type CollectionFeatures, type GetCollectionInfo } from "./collections";
import { keepExistingTerms, type ContentEntry, type ContentHandlers } from "./content";
import type { MediaUploader } from "./image";
import { createGenerationClient } from "./generation";
import { localeOf, type Locale } from "./locale";
import {
  buildUpdateBody,
  entryTitle,
  generatePanelValues,
  panelApplySchema,
  panelGenerateSchema,
  type PanelGenerateResult,
} from "./panel";
import type { Provider } from "./providers";
import { parse, RouteError } from "./routes";
import { readSettings, type KvLike } from "./settings";
import type { TermRef } from "./types";
import { recordImagePrices } from "./usage";

// Plugin routes default to plugins:manage (Admin). The editor panel is shown
// to Editors (minRole 40), so its routes require what an Editor has.
export const PANEL_ROUTE_PERMISSION = "content:edit_any" as const;

export type PanelRouteDeps = {
  kv: KvLike;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  content: Pick<ContentHandlers, "get" | "update">;
  /** Terms of a taxonomy in one locale. */
  getTerms(taxonomy: "category" | "tag", locale?: string): Promise<TermRef[]>;
  /** Terms on an entry, in the entry's locale. */
  getEntryTerms(collection: string, id: string, taxonomy: string, locale?: string): Promise<TermRef[]>;
  runs?: { put(id: string, data: Record<string, unknown>): Promise<void> };
  media?: MediaUploader;
  /** Fields, SEO support and taxonomies of a collection; unknown = everything but SEO. */
  getCollectionInfo?: GetCollectionInfo;
  log?: (message: string) => void;
  now?: () => Date;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const featuresQuerySchema = z.object({ collection: z.string().trim().regex(/^[a-z][a-z0-9_]*$/) });

// The saved entry's locale is authoritative; the editor's locale covers entries saved without one.
const entryLocale = (entry: ContentEntry, requested: string | undefined): Locale =>
  localeOf(entry.locale ?? requested);

export function createPanelHandlers(deps: PanelRouteDeps) {
  const now = deps.now ?? (() => new Date());

  async function loadEntry(collection: string, id: string): Promise<ContentEntry> {
    const res = await deps.content.get(collection, id);
    if (res.success === false) throw new RouteError("not_found", res.error?.message ?? `Entry ${id} was not found`);
    return res.data.item;
  }

  const featuresOf = (collection: string) => collectionFeatures(deps.getCollectionInfo, collection, deps.log);

  return {
    /** What the collection can hold, so the panel shows only fields it can apply. */
    async features(input: unknown): Promise<CollectionFeatures> {
      return featuresOf(parse(featuresQuerySchema, input).collection);
    },

    async generate(input: unknown): Promise<PanelGenerateResult> {
      const req = parse(panelGenerateSchema, input);
      const entry = await loadEntry(req.collection, req.id);
      const title = entryTitle(entry);
      if (!title) throw new RouteError("invalid_input", "Save the post with a title before generating");
      const startedAt = now().toISOString();
      const locale = entryLocale(entry, req.locale);
      const features = await featuresOf(req.collection);
      const wantsTags = req.fields.includes("tags") && features.tags;
      const [settings, tagTerms, entryTags] = await Promise.all([
        readSettings(deps.kv),
        wantsTags ? deps.getTerms("tag", locale) : Promise.resolve([]),
        wantsTags ? deps.getEntryTerms(req.collection, entry.id, "tag", locale) : Promise.resolve([]),
      ]);
      // Every panel field needs text, so a missing text key fails up front.
      await deps.getApiKey(settings.providers.text);
      const result = await generatePanelValues(
        {
          client: createGenerationClient({
            providers: settings.providers,
            getApiKey: deps.getApiKey,
            fetchImpl: deps.fetchImpl,
          }),
          settings,
          tagTerms,
          entryTags: entryTags.map((t) => t.slug),
          media: deps.media,
          locale,
          features,
        },
        entry,
        req,
      );
      await recordImagePrices(deps.kv, result.imageCosts);
      const failed = Object.entries(result.errors);
      try {
        await deps.runs?.put(`panel-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, {
          source: "panel",
          postId: entry.id,
          editUrl: `/_emdash/admin/content/${req.collection}/${entry.id}`,
          topic: title,
          status: failed.length === req.fields.length ? "error" : "ok",
          ...(failed.length > 0 ? { error: failed.map(([field, message]) => `${field}: ${message}`).join("; ") } : {}),
          warnings: result.warnings,
          calls: result.calls,
          cost: result.cost,
          tokens: result.tokens,
          startedAt,
          finishedAt: now().toISOString(),
        });
      } catch (err) {
        result.warnings.push(`Run history could not be recorded: ${messageOf(err)}`);
      }
      return result;
    },

    async apply(input: unknown): Promise<{ ok: true; status: string }> {
      const req = parse(panelApplySchema, input);
      const entry = await loadEntry(req.collection, req.id);
      const locale = entryLocale(entry, req.locale);
      const features = await featuresOf(req.collection);
      const values = { ...req.values };
      let currentTags: string[] = [];
      if (values.tags && values.tags.length > 0 && features.tags) {
        // EmDash rejects unknown term slugs; plugins cannot create terms.
        values.tags = keepExistingTerms(values.tags, await deps.getTerms("tag", locale)).kept;
        if (values.tags.length > 0) {
          currentTags = (await deps.getEntryTerms(req.collection, entry.id, "tag", locale)).map((t) => t.slug);
        }
      }
      const body = buildUpdateBody(values, currentTags, features);
      if (Object.keys(body).length === 0) throw new RouteError("invalid_input", "Nothing to apply");
      const res = await deps.content.update(req.collection, entry.id, body);
      if (res.success === false) {
        throw new RouteError("update_failed", res.error?.message ?? "The post could not be updated");
      }
      return { ok: true, status: res.data.item.status ?? entry.status ?? "draft" };
    },
  };
}

export type PanelHandlers = ReturnType<typeof createPanelHandlers>;
