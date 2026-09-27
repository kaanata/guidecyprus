import { KV_LAST_ROLLUP } from "../constants";
import { rollupEvents, statId } from "./rollup";
import { statsInputSchema } from "./schema";
import type { Stores } from "./store";
import { DAY_MS, utcDay } from "./track";
import type { EventCounts, StatsRow, StatsSummary } from "./types";

/** Sum daily stats per ad from `fromDay` (inclusive, YYYY-MM-DD) onwards. */
export async function totalsSince(stores: Stores, fromDay: string): Promise<Map<string, EventCounts>> {
  const totals = new Map<string, EventCounts>();
  let cursor: string | undefined;
  do {
    const page = await stores.stats.query({ where: { day: { gte: fromDay } }, limit: 500, cursor });
    for (const { data } of page.items) {
      const total = totals.get(data.adId) ?? { impressions: 0, clicks: 0 };
      total.impressions += data.impressions;
      total.clicks += data.clicks;
      totals.set(data.adId, total);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return totals;
}

/**
 * Move append-only events into per-ad daily totals. Events are deleted only after totals are saved.
 *
 * Pages are drained until either a page comes back shorter than `pageSize` (the backlog is
 * empty) or the wall-clock `budgetMs` runs out -- at high event volume that keeps a single
 * 5-minute tick from running forever, and `stoppedOnBudget` tells the caller a backlog remains.
 * `maxPages` is an optional hard safety cap on top of the budget; leave it unset in production.
 */
export async function runRollup(
  stores: Stores,
  now: Date,
  options: { maxPages?: number; pageSize?: number; budgetMs?: number; clock?: () => number } = {},
): Promise<{ processed: number; stoppedOnBudget: boolean }> {
  const { maxPages, pageSize = 500, budgetMs = 20_000, clock = Date.now } = options;
  const deadline = clock() + budgetMs;
  let processed = 0;
  let stoppedOnBudget = false;

  for (let page = 0; maxPages === undefined || page < maxPages; page++) {
    const { items } = await stores.events.query({ orderBy: { createdAt: "asc" }, limit: pageSize });
    if (items.length === 0) break;

    const ids = [...new Set(items.flatMap((event) => Object.keys(event.data.counts).map((adId) => statId(adId, event.data.day))))];
    const existing = await stores.stats.getMany(ids);
    const { stats, processedIds } = rollupEvents(items, existing);
    await stores.stats.putMany(stats);
    await stores.events.deleteMany(processedIds);
    processed += processedIds.length;

    if (items.length < pageSize) break;
    if (clock() >= deadline) {
      stoppedOnBudget = true;
      break;
    }
  }
  await stores.kv.set(KV_LAST_ROLLUP, now.toISOString());
  return { processed, stoppedOnBudget };
}

export async function statsSummary(
  stores: Stores,
  raw: unknown,
  now: Date,
): Promise<({ ok: true } & StatsSummary) | { ok: false; error: "INVALID_INPUT" }> {
  const parsed = statsInputSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };
  const { days } = parsed.data;
  const fromDay = utcDay(new Date(now.getTime() - (days - 1) * DAY_MS));

  const daily: StatsSummary["daily"] = {};
  const totals = new Map<string, EventCounts>();
  let cursor: string | undefined;
  do {
    const page = await stores.stats.query({ where: { day: { gte: fromDay } }, limit: 500, cursor });
    for (const { data } of page.items) {
      (daily[data.adId] ??= []).push({ day: data.day, impressions: data.impressions, clicks: data.clicks });
      const total = totals.get(data.adId) ?? { impressions: 0, clicks: 0 };
      total.impressions += data.impressions;
      total.clicks += data.clicks;
      totals.set(data.adId, total);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (const series of Object.values(daily)) series.sort((a, b) => a.day.localeCompare(b.day));

  const ads = await stores.ads.getMany([...totals.keys()]);
  const rows: StatsRow[] = Array.from(totals, ([adId, total]) => {
    const ad = ads.get(adId);
    return {
      adId,
      name: ad?.name ?? "Deleted ad",
      space: ad?.space ?? null,
      impressions: total.impressions,
      clicks: total.clicks,
      ctr: total.impressions > 0 ? Math.round((total.clicks / total.impressions) * 10000) / 10000 : 0,
    };
  }).sort((a, b) => b.impressions - a.impressions);

  const lastRollupAt = await stores.kv.get<string>(KV_LAST_ROLLUP);
  return { ok: true, days, rows, daily, lastRollupAt };
}
