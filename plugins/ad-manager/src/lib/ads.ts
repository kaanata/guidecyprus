import { adInputSchema, fieldErrorsOf, idInputSchema } from "./schema";
import { totalsSince } from "./stats";
import type { Stores } from "./store";
import { DAY_MS, utcDay } from "./track";
import type { Ad, AdListItem, StoredAd } from "./types";

export type SaveResult =
  | { ok: true; ad: StoredAd }
  | { ok: false; error: "INVALID_INPUT"; fieldErrors: Record<string, string> }
  | { ok: false; error: "NOT_FOUND" };

export async function allAds(stores: Stores): Promise<StoredAd[]> {
  const ads: StoredAd[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.ads.query({ limit: 200, cursor });
    for (const row of page.items) ads.push({ ...row.data, id: row.id });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return ads;
}

export async function listAds(stores: Stores, now: Date): Promise<AdListItem[]> {
  const ads = await allAds(stores);
  const totals = await totalsSince(stores, utcDay(new Date(now.getTime() - 6 * DAY_MS)));
  ads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return ads.map((ad) => ({ ...ad, last7: totals.get(ad.id) ?? { impressions: 0, clicks: 0 } }));
}

export async function getAd(
  stores: Stores,
  raw: unknown,
): Promise<{ ok: true; ad: StoredAd } | { ok: false; error: "INVALID_INPUT" | "NOT_FOUND" }> {
  const parsed = idInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };
  const ad = await stores.ads.get(parsed.data.id);
  return ad ? { ok: true, ad: { ...ad, id: parsed.data.id } } : { ok: false, error: "NOT_FOUND" };
}

export async function saveAd(stores: Stores, raw: unknown, now: Date, newId: () => string): Promise<SaveResult> {
  const parsed = adInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT", fieldErrors: fieldErrorsOf(parsed.error) };

  const { id, ...fields } = parsed.data;
  const stamp = now.toISOString();
  let createdAt = stamp;
  if (id) {
    const existing = await stores.ads.get(id);
    if (!existing) return { ok: false, error: "NOT_FOUND" };
    createdAt = existing.createdAt;
  }

  const adId = id ?? newId();
  const ad: Ad = { ...fields, createdAt, updatedAt: stamp };
  await stores.ads.put(adId, ad);
  return { ok: true, ad: { ...ad, id: adId } };
}

export async function deleteAd(
  stores: Stores,
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: "INVALID_INPUT" | "NOT_FOUND" }> {
  const parsed = idInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "INVALID_INPUT" };
  return (await stores.ads.delete(parsed.data.id)) ? { ok: true } : { ok: false, error: "NOT_FOUND" };
}
