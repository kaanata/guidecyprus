import { definePlugin, getBylineBySlug } from "emdash";
import type { PluginContext, PluginRoute } from "emdash";
import type { EmDashRuntime } from "emdash/middleware";
import { aiWriter, PLUGIN_ID } from "./index";
import { createBulkHandlers, type ApiListResult } from "./lib/bulk-edit";
import type { CollectionInfo } from "./lib/collections";
import type { ContentHandlers } from "./lib/content";
import type { ListPublished } from "./lib/internal-links";
import { enqueueLinkJob, type LinkJob } from "./lib/link-queue";
import { queueSlopRoute, type SlopJob } from "./lib/slop-queue";
import { usageRoute } from "./lib/usage";
import type { MediaUploader } from "./lib/image";
import { createPanelHandlers, PANEL_ROUTE_PERMISSION, type PanelHandlers, type PanelRouteDeps } from "./lib/panel-routes";
import { PROVIDER_KEY_NAMES, type Provider } from "./lib/providers";
import { createRuleHandlers, type RuleHandlers } from "./lib/rule-routes";
import { createRouteHandlers, RouteError, type RouteDeps, type RouteHandlers } from "./lib/routes";
import type { Rule } from "./lib/rules";
import type { RunRecord } from "./lib/runs";
import { cronTick, runRuleManually, type SchedulerDeps } from "./lib/scheduler";
import { readSettings, type KvLike } from "./lib/settings";
import type { StoreLike } from "./lib/store";

const TICK_TASK = "ai-writer-tick";
const TICK_SCHEDULE = "*/15 * * * *";
// EmDash's default hook timeout is 5 s; one tick can write two full articles.
// Stays below EmDash's 10-minute stale-lock recovery and the 10-minute KV
// tick-lock staleness, so a slow tick is never overlapped by the next one.
const TICK_TIMEOUT_MS = 9 * 60_000;

// Keys come only from the Worker env (.dev.vars locally, secrets in
// production). Never log them.
async function loadApiKey(provider: Provider): Promise<string> {
  const name = PROVIDER_KEY_NAMES[provider];
  let key: string | undefined;
  try {
    const mod = await import("cloudflare:workers");
    key = (mod as unknown as { env: Record<string, string | undefined> }).env[name];
  } catch {
    key = undefined;
  }
  if (!key) {
    throw new RouteError(
      "missing_api_key",
      `${name} is not bound. Add it to .dev.vars locally or as a Worker secret in production.`,
    );
  }
  return key;
}

// Content writes run through EmDash's runtime — the same methods the admin's
// REST routes call — so content:beforeSave/afterSave/afterPublish hooks (e.g.
// the webhook notifier), media-field normalization, validation and
// media-usage tracking all apply. withEmDashRuntime reuses the current
// request context in routes and creates one in cron. Imported lazily because
// emdash/middleware loads the plugin registry, which loads this module.
async function withRuntime<T>(fn: (runtime: EmDashRuntime) => Promise<T>): Promise<T> {
  const { withEmDashRuntime } = await import("emdash/middleware");
  return withEmDashRuntime(fn);
}

type RouteCtx = Parameters<PluginRoute["handler"]>[0];

function storeOf<T>(ctx: PluginContext, name: "rules" | "runs" | "linkJobs" | "slopJobs"): StoreLike<T> {
  return (ctx.storage as unknown as Record<string, StoreLike<T>>)[name];
}

function depsFor(ctx: PluginContext): RouteDeps {
  const content: ContentHandlers = {
    get: (collection, idOrSlug, locale) =>
      withRuntime(
        async (rt) =>
          (await rt.handleContentGet(collection, idOrSlug, locale)) as unknown as Awaited<ReturnType<ContentHandlers["get"]>>,
      ),
    create: (collection, body) =>
      withRuntime(
        async (rt) =>
          (await rt.handleContentCreate(collection, body)) as unknown as Awaited<ReturnType<ContentHandlers["create"]>>,
      ),
    publish: (collection, id) =>
      withRuntime(
        async (rt) =>
          (await rt.handleContentPublish(collection, id)) as unknown as Awaited<ReturnType<ContentHandlers["publish"]>>,
      ),
    update: (collection, id, body) =>
      withRuntime(
        async (rt) =>
          (await rt.handleContentUpdate(collection, id, body)) as unknown as Awaited<ReturnType<ContentHandlers["update"]>>,
      ),
  };
  return {
    kv: ctx.kv as unknown as KvLike,
    getApiKey: loadApiKey,
    // ctx.media is MediaAccess | MediaAccessWithWrite; the media:write
    // capability guarantees upload() at runtime.
    media: ctx.media as unknown as MediaUploader | undefined,
    // Terms exist per locale (same slugs); every picker and check reads one locale's terms.
    getTerms: async (taxonomy, locale) => {
      const terms = (await ctx.taxonomies?.getTerms(taxonomy, locale ? { locale } : undefined)) ?? [];
      return terms.map((t) => ({ slug: t.slug, label: t.label }));
    },
    getCollectionInfo: (collection) => collectionInfo(ctx, collection),
    content,
    runs: storeOf<Record<string, unknown>>(ctx, "runs"),
  };
}

// Fields and SEO support from the schema registry; taxonomies from their
// definitions (a taxonomy lists the collections it is attached to).
async function collectionInfo(ctx: PluginContext, collection: string): Promise<CollectionInfo | null> {
  const info = await withRuntime(async (rt) => rt.schemaRegistry.getCollectionWithFields(collection));
  if (!info) return null;
  const defs = (await ctx.taxonomies?.getAll()) ?? [];
  const taxonomies = [...new Set(defs.filter((d) => d.collections.includes(collection)).map((d) => d.name))];
  return { fields: info.fields.map((f) => f.slug), hasSeo: info.hasSeo, taxonomies };
}

async function entryTerms(ctx: PluginContext, collection: string, id: string, taxonomy: string, locale?: string) {
  if (!ctx.taxonomies) throw new Error("Taxonomy access is unavailable (taxonomies:read capability missing)");
  const terms = await ctx.taxonomies.getEntryTerms(collection, id, { taxonomy, ...(locale ? { locale } : {}) });
  return terms.map((t) => ({ slug: t.slug, label: t.label }));
}

function schedulerDeps(ctx: PluginContext): SchedulerDeps {
  const deps = depsFor(ctx);
  return {
    kv: ctx.kv as unknown as SchedulerDeps["kv"],
    rules: storeOf<Rule>(ctx, "rules"),
    runs: storeOf<RunRecord>(ctx, "runs"),
    getApiKey: deps.getApiKey,
    media: deps.media,
    content: deps.content,
    getTerms: deps.getTerms,
    getCollectionInfo: deps.getCollectionInfo,
    // Cron has no request context; run the lookup inside EmDash's runtime.
    getBylineId: (slug) => withRuntime(async () => (await getBylineBySlug(slug))?.id ?? null),
    log: (message) => ctx.log.warn(`[ai-writer] ${message}`),
    links: {
      jobs: storeOf<LinkJob>(ctx, "linkJobs"),
      // Only the new post's locale, so internal links never cross languages.
      listPublished: (collection, locale) =>
        withRuntime(
          async (rt) =>
            (await rt.handleContentList(collection, {
              status: "published",
              limit: 100,
              orderBy: "publishedAt",
              order: "desc",
              ...(locale ? { locale } : {}),
            })) as unknown as Awaited<ReturnType<ListPublished>>,
        ),
    },
    slop: { jobs: storeOf<SlopJob>(ctx, "slopJobs") },
  };
}

// ctx.cron.schedule is an upsert that also resets the task's next run time,
// so it is skipped when the tick is already registered on this schedule.
async function ensureTick(ctx: PluginContext): Promise<void> {
  if (!ctx.cron) throw new Error("Cron scheduling is unavailable in this context");
  const tasks = await ctx.cron.list();
  if (tasks.some((task) => task.name === TICK_TASK && task.schedule === TICK_SCHEDULE)) return;
  await ctx.cron.schedule(TICK_TASK, { schedule: TICK_SCHEDULE });
}

async function registerTick(ctx: PluginContext): Promise<void> {
  try {
    await ensureTick(ctx);
  } catch (err) {
    ctx.log.warn(`[ai-writer] Could not schedule ${TICK_TASK}: ${(err as Error).message}`);
  }
}

function guarded(run: (ctx: RouteCtx) => Promise<unknown>): PluginRoute {
  return {
    handler: async (ctx) => {
      try {
        return await run(ctx);
      } catch (err) {
        if (err instanceof RouteError) {
          return { success: false, error: { code: err.code, message: err.message } };
        }
        ctx.log.error(`[ai-writer] ${(err as Error).message}`);
        return { success: false, error: { code: "internal_error", message: (err as Error).message } };
      }
    },
  };
}

function route(run: (h: RouteHandlers, ctx: RouteCtx) => Promise<unknown>): PluginRoute {
  return guarded((ctx) => run(createRouteHandlers(depsFor(ctx)), ctx));
}

function ruleRoute(run: (h: RuleHandlers, ctx: RouteCtx) => Promise<unknown>): PluginRoute {
  return guarded((ctx) =>
    run(
      createRuleHandlers({
        rules: storeOf<Rule>(ctx, "rules"),
        runs: storeOf<RunRecord>(ctx, "runs"),
        runRule: (rule) => runRuleManually(schedulerDeps(ctx), rule.id),
        ensureTick: () => ensureTick(ctx),
        tick: () => cronTick(schedulerDeps(ctx)),
      }),
      ctx,
    ),
  );
}

function panelDeps(ctx: PluginContext): PanelRouteDeps {
  const deps = depsFor(ctx);
  return {
    kv: deps.kv,
    getApiKey: deps.getApiKey,
    content: deps.content,
    getTerms: deps.getTerms,
    getEntryTerms: (collection, id, taxonomy, locale) => entryTerms(ctx, collection, id, taxonomy, locale),
    runs: deps.runs,
    media: deps.media,
    getCollectionInfo: deps.getCollectionInfo,
    log: (message) => ctx.log.warn(`[ai-writer] ${message}`),
  };
}

// Editor-panel routes: callable by Editors, not just Admins (Ruling 1).
function panelRoute(run: (h: PanelHandlers, ctx: RouteCtx) => Promise<unknown>): PluginRoute {
  return {
    ...guarded((ctx) =>
      run(createPanelHandlers(panelDeps(ctx)), ctx),
    ),
    permission: PANEL_ROUTE_PERMISSION,
  };
}

function bulkRoute(run: (h: ReturnType<typeof createBulkHandlers>, ctx: RouteCtx) => Promise<unknown>): PluginRoute {
  return guarded((ctx) => {
    const deps = depsFor(ctx);
    return run(
      createBulkHandlers({
        ...deps,
        getEntryTerms: (collection, id, taxonomy, locale) => entryTerms(ctx, collection, id, taxonomy, locale),
        list: (collection, params) =>
          withRuntime(
            async (rt) => (await rt.handleContentList(collection, { ...params, orderBy: "updatedAt", order: "desc" })) as unknown as ApiListResult,
          ),
      }),
      ctx,
    );
  });
}

// GET query parameters, blanks dropped (an empty ?ruleId= means "all rules").
function queryOf(ctx: RouteCtx): Record<string, string> {
  return Object.fromEntries([...new URL(ctx.request.url).searchParams].filter(([, v]) => v !== ""));
}

export function createPlugin(): ReturnType<typeof definePlugin> {
  // Re-derive the descriptor so the runtime plugin carries its admin pages;
  // native plugins only surface what is passed to definePlugin.
  const descriptor = aiWriter();
  return definePlugin({
    id: PLUGIN_ID,
    version: "0.1.0",
    capabilities: ["content:write", "media:write", "taxonomies:read"],
    allowedHosts: ["openrouter.ai", "api.minimax.io", "www.minimax.io"],
    storage: {
      rules: { indexes: ["active", "nextRunAt"] },
      runs: { indexes: ["ruleId", "startedAt"] },
      linkJobs: { indexes: ["status", "queuedAt"] },
      slopJobs: { indexes: ["status", "queuedAt"] },
    },
    admin: {
      entry: descriptor.adminEntry,
      pages: descriptor.adminPages,
      widgets: descriptor.adminWidgets,
    },
    hooks: {
      "plugin:install": async (_event, ctx) => registerTick(ctx),
      "plugin:activate": async (_event, ctx) => registerTick(ctx),
      // Queue internal linking for a newly published post; the cron tick does the AI work.
      "content:afterPublish": async (event, ctx) => {
        try {
          const outcome = await enqueueLinkJob(
            { kv: ctx.kv as unknown as KvLike, jobs: storeOf<LinkJob>(ctx, "linkJobs") },
            event.content,
            event.collection,
          );
          if (outcome.queued) ctx.log.info(`[ai-writer] Internal links queued for ${event.collection}/${String(event.content.id)}`);
        } catch (err) {
          ctx.log.warn(`[ai-writer] Internal links could not be queued: ${(err as Error).message}`);
        }
      },
      cron: {
        timeout: TICK_TIMEOUT_MS,
        handler: async (event, ctx) => {
          if (event.name !== TICK_TASK) return;
          const { locked, ran } = await cronTick(schedulerDeps(ctx));
          if (locked) ctx.log.info("[ai-writer] Tick skipped: another tick holds the lock");
          else if (ran.length > 0) {
            ctx.log.info(`[ai-writer] Tick finished: ${ran.filter((r) => r.status === "ok").length}/${ran.length} posts written`);
          }
        },
      },
    },
    routes: {
      settings: route((h, ctx) =>
        ctx.request.method.toUpperCase() === "POST" ? h.saveSettings(ctx.input) : h.getSettings(),
      ),
      // The editor panel's model pickers read the catalog, so Editors may too.
      models: { ...route((h) => h.models()), permission: PANEL_ROUTE_PERMISSION },
      terms: route((h, ctx) => h.terms(queryOf(ctx))),
      step: route((h, ctx) => h.step(ctx.input)),
      image: route((h, ctx) => h.image(ctx.input)),
      "express/create": route((h, ctx) => h.expressCreate(ctx.input)),
      rules: ruleRoute((h) => h.list()),
      "rules/save": ruleRoute((h, ctx) => h.save(ctx.input)),
      "rules/toggle": ruleRoute((h, ctx) => h.toggle(ctx.input)),
      "rules/delete": ruleRoute((h, ctx) => h.remove(ctx.input)),
      "rules/run": ruleRoute((h, ctx) => h.run(ctx.input)),
      "rules/tick": ruleRoute((h) => h.tick()),
      runs: ruleRoute((h, ctx) => h.runs(queryOf(ctx))),
      "bulk/entries": bulkRoute((h, ctx) => h.entries(queryOf(ctx))),
      "bulk/edit": bulkRoute((h, ctx) => h.edit(ctx.input)),
      usage: guarded((ctx) =>
        readSettings(ctx.kv as unknown as KvLike).then((settings) =>
          usageRoute({
            runs: storeOf<RunRecord>(ctx, "runs"),
            getOpenRouterKey: () => loadApiKey("openrouter"),
            getMiniMaxKey: () => loadApiKey("minimax"),
            lowCreditThreshold: settings.usageAlerts.lowCredit,
          }),
        ),
      ),
      "slop/queue": guarded((ctx) => queueSlopRoute({ jobs: storeOf<SlopJob>(ctx, "slopJobs") }, ctx.input)),
      "panel/generate": panelRoute((h, ctx) => h.generate(ctx.input)),
      "panel/apply": panelRoute((h, ctx) => h.apply(ctx.input)),
      "panel/features": panelRoute((h, ctx) => h.features(ctx.input)),
    },
  });
}

export default createPlugin;
