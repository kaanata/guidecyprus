import type { AdSpaceId } from "../spaces";
import { toCreative } from "./creative";
import { isLive } from "./schedule";
import type { ServeInput } from "./schema";
import { matchesCountry, matchesPage } from "./targeting";
import type { Creative, StoredAd } from "./types";

export type Rng = () => number;

/** Weighted random sampling without replacement. */
export function pickWeighted<T extends { weight: number }>(items: T[], count: number, rng: Rng = Math.random): T[] {
  const pool = items.slice();
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, item) => sum + item.weight, 0);
    let remaining = rng() * total;
    let index = 0;
    for (; index < pool.length - 1; index++) {
      remaining -= pool[index]!.weight;
      if (remaining < 0) break;
    }
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}

/** Per-space request cap, mirroring `serveInputSchema`'s `spaces[].count` max (schema.ts). */
const MAX_COUNT_PER_SPACE = 4;

export function selectFills(
  ads: StoredAd[],
  /** `country` comes from the server (Cloudflare geo), never from the request body. */
  request: ServeInput & { country?: string | null },
  now: Date,
  codeAdsEnabled: boolean,
  rng: Rng = Math.random,
): Partial<Record<AdSpaceId, Creative[]>> {
  // A single request can list the same space more than once (e.g. a hand-crafted
  // request that skips the browser loader's own grouping). Merge those entries so
  // each space is selected for exactly once, summing -- not overwriting -- counts.
  const counts = new Map<AdSpaceId, number>();
  for (const { space, count } of request.spaces) {
    counts.set(space, Math.min((counts.get(space) ?? 0) + count, MAX_COUNT_PER_SPACE));
  }

  const fills: Partial<Record<AdSpaceId, Creative[]>> = {};
  for (const [space, count] of counts) {
    const eligible = ads.filter(
      (ad) =>
        ad.space === space &&
        ad.status === "active" &&
        isLive(ad, now) &&
        matchesPage(ad, request.page) &&
        matchesCountry(ad, request.country ?? null) &&
        (ad.kind !== "code" || codeAdsEnabled),
    );
    const picked = pickWeighted(eligible, count, rng);
    if (picked.length > 0) fills[space] = picked.map(toCreative);
  }
  return fills;
}
