import type { AdSpaceId } from "../spaces";
import { serveInputSchema, trackInputSchema } from "./schema";
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
