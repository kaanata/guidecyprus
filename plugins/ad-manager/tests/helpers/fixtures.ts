import type { StoredAd } from "../../src/lib/types";

export function makeAd(overrides: Partial<StoredAd> = {}): StoredAd {
  return {
    id: "ad-1",
    name: "Welcome offer",
    advertiser: "Example Sportsbook",
    kind: "banner",
    space: "in-feed",
    status: "active",
    weight: 10,
    targeting: { pageTypes: [], competitions: [] },
    banner: {
      image: { mediaId: "m1", url: "/_emdash/api/media/file/a.jpg", width: 300, height: 250 },
      href: "https://example.com/offer",
      alt: "Welcome offer banner",
    },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Deterministic [0, 1) generator (LCG) for repeatable selection tests. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
