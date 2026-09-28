import type { AdSpaceId } from "../spaces";
import { serveInputSchema, trackInputSchema } from "./schema";
import { isLive } from "./schedule";
import { type Rng, selectFills } from "./select";
import { readCodeAdsEnabled } from "./settings";
import type { Stores } from "./store";
import { aggregateEvents, toEventRecord } from "./track";
import type { Creative } from "./types";

export type ServeResult =
  | { ok: true; fills: Partial<Record<AdSpaceId, Creative[]>> }
  | { ok: false; error: "INVALID_INPUT" };

export async function serveAds(
  stores: Stores,
  raw: unknown,
  now: Date,
  options: { country?: string | null; rng?: Rng } = {},
): Promise<ServeResult> {
  const parsed = serveInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };

  const spaces = [...new Set(parsed.data.spaces.map((entry) => entry.space))];
  const { items } = await stores.ads.query({ where: { status: "active", space: { in: spaces } }, limit: 500 });
  const ads = items.map((row) => ({ ...row.data, id: row.id }));
  const codeAdsEnabled = await readCodeAdsEnabled(stores.kv);
  const request = { ...parsed.data, country: options.country ?? null };
  return { ok: true, fills: selectFills(ads, request, now, codeAdsEnabled, options.rng ?? Math.random) };
}

/** EmDash caps a storage query page at 100 rows. */
const SERVABLE_SCAN_LIMIT = 100;

/**
 * Whether `serve` could return anything at all right now, ignoring page, space and country
 * targeting: some ad is active, inside its schedule window, and not a code ad while code ads
 * are switched off (the same status/schedule/kill-switch checks `selectFills` applies).
 *
 * One indexed query on `status`; the code-ads setting is only read when every live ad is a
 * code ad. A result page that is full (`hasMore`) with nothing servable counts as servable:
 * guessing "no" there could hide ads, guessing "yes" only costs one empty `serve` call.
 */
export async function hasServableAd(stores: Stores, now: Date): Promise<boolean> {
  const page = await stores.ads.query({ where: { status: "active" }, limit: SERVABLE_SCAN_LIMIT });
  const live = page.items.filter((row) => row.data.status === "active" && isLive(row.data, now));
  if (live.some((row) => row.data.kind !== "code")) return true;
  if (page.hasMore) return true;
  if (live.length === 0) return false;
  return readCodeAdsEnabled(stores.kv);
}

export type TrackResult = { ok: true; accepted: number } | { ok: false; error: "INVALID_INPUT" };

/** Appends one event record per request; never read-modify-writes, so concurrent requests can't lose counts. */
export async function trackEvents(stores: Stores, raw: unknown, now: Date, newId: () => string): Promise<TrackResult> {
  const parsed = trackInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };

  const { events } = parsed.data;
  const found = await stores.ads.getMany([...new Set(events.map((event) => event.adId))]);
  const active = new Set(
    Array.from(found)
      .filter(([, ad]) => ad.status === "active")
      .map(([id]) => id),
  );

  const record = toEventRecord(aggregateEvents(events, active), now);
  if (!record) return { ok: true, accepted: 0 };
  await stores.events.put(newId(), record);
  return { ok: true, accepted: events.filter((event) => active.has(event.adId)).length };
}
