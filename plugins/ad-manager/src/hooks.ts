import type { LogAccess } from "emdash";
import { ROLLUP_CRON, ROLLUP_SCHEDULE } from "./constants";
import { LOADER_SOURCE } from "./loader";
import { hasServableAd } from "./lib/serving";
import { runRollup } from "./lib/stats";
import { storesOf } from "./lib/store";

const LOADER_FRAGMENT = {
  kind: "inline-script" as const,
  placement: "body:end" as const,
  key: "ad-manager-loader",
  code: LOADER_SOURCE,
};

/**
 * Injects the loader only when some ad could be served. The loader turns on
 * html[data-ads="on"], which reserves the ad spaces; with nothing to serve it would reserve
 * them and then collapse them again (layout shift on every page). Returning null tells
 * EmDash this plugin contributes nothing to the page.
 *
 * A storage error fails open -- a transient read failure must not make ads disappear -- and
 * is caught here because EmDash drops a throwing page:fragments handler's output entirely.
 */
export async function fragmentsHook(
  ctx: { storage: unknown; kv: unknown; log?: Pick<LogAccess, "warn"> },
  now: Date = new Date(),
): Promise<typeof LOADER_FRAGMENT | null> {
  try {
    return (await hasServableAd(storesOf(ctx), now)) ? LOADER_FRAGMENT : null;
  } catch (error) {
    ctx.log?.warn?.(`[ad-manager] could not check for servable ads, injecting the loader anyway: ${(error as Error)?.message ?? error}`);
    return LOADER_FRAGMENT;
  }
}

interface RollupCtx {
  cron?: {
    list(): Promise<Array<{ name: string }>>;
    schedule(name: string, opts: { schedule: string }): Promise<void>;
  };
  log?: LogAccess;
}

// Native plugins registered in astro.config.mjs and enabled from boot never receive the
// plugin:install / plugin:activate hooks (EmDash only fires those from an admin/marketplace
// install or a re-enable), so this never runs from those hooks alone on this site. Route
// handlers do get ctx.cron, so admin routes also call this idempotent helper to backfill
// the schedule. It checks list() first because schedule() is an unconditional upsert that
// would otherwise reset next_run_at on every call.
export async function ensureRollupScheduled(ctx: RollupCtx): Promise<void> {
  if (!ctx.cron) return;
  const tasks = await ctx.cron.list();
  if (tasks.some((task) => task.name === ROLLUP_CRON)) return;
  await ctx.cron.schedule(ROLLUP_CRON, { schedule: ROLLUP_SCHEDULE });
}

// Shared by plugin:install, plugin:activate and the route-level backfill: a scheduling
// failure must never crash a hook or break an admin route's normal response, so it's
// caught and logged rather than swallowed silently or rethrown.
export async function ensureRollupSafely(ctx: RollupCtx): Promise<void> {
  try {
    await ensureRollupScheduled(ctx);
  } catch (error) {
    ctx.log?.warn?.(`[ad-manager] could not schedule the stats rollup: ${(error as Error)?.message ?? error}`);
  }
}

export async function cronHook(
  event: { name: string },
  ctx: { storage: unknown; kv: unknown; log?: LogAccess },
): Promise<void> {
  if (event.name !== ROLLUP_CRON) return;
  const { processed, stoppedOnBudget } = await runRollup(storesOf(ctx), new Date());
  ctx.log?.info?.(`[ad-manager] rollup processed ${processed} events`);
  if (stoppedOnBudget) {
    ctx.log?.warn?.(`[ad-manager] rollup stopped on its time budget after processing ${processed} events; backlog remains for the next run`);
  }
}
