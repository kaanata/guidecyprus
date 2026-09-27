import { toCreative } from "../src/lib/creative";
import { pickWeighted, selectFills } from "../src/lib/select";
import { makeAd, seededRng } from "./helpers/fixtures";

const now = new Date("2026-09-12T12:00:00.000Z");

describe("pickWeighted", () => {
  const items = [
    { id: "light", weight: 1 },
    { id: "heavy", weight: 3 },
  ];

  it("picks by cumulative weight", () => {
    expect(pickWeighted(items, 1, () => 0.1)[0]?.id).toBe("light");
    expect(pickWeighted(items, 1, () => 0.5)[0]?.id).toBe("heavy");
  });

  it("never repeats an item and stops when the pool is empty", () => {
    const picked = pickWeighted(items, 3, seededRng(1));
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
  });

  it("follows the weights over many draws", () => {
    const rng = seededRng(42);
    let light = 0;
    for (let i = 0; i < 10000; i++) if (pickWeighted(items, 1, rng)[0]?.id === "light") light++;
    expect(light / 10000).toBeGreaterThan(0.22);
    expect(light / 10000).toBeLessThan(0.28);
  });
});

describe("toCreative", () => {
  it("exposes only public banner fields", () => {
    const creative = toCreative(makeAd({ disclosure: "18+ · Play responsibly" }));
    expect(Object.keys(creative).sort()).toEqual(["adId", "alt", "disclosure", "height", "href", "image", "kind", "width"]);
    expect(creative).toMatchObject({ adId: "ad-1", kind: "banner", width: 300, height: 250 });
  });

  it("sizes code creatives to the space's reserved box", () => {
    const creative = toCreative(
      makeAd({ kind: "code", space: "article-sidebar", banner: undefined, code: { html: "<ins></ins>" } }),
    );
    expect(creative).toEqual({ adId: "ad-1", kind: "code", width: 300, height: 600, html: "<ins></ins>" });
  });
});

describe("selectFills", () => {
  const request = { page: { type: "article" as const, competition: "premier-league" }, spaces: [{ space: "in-feed" as const, count: 2 }] };

  it("returns only eligible ads for the requested space", () => {
    const ads = [
      makeAd({ id: "ok" }),
      makeAd({ id: "paused", status: "paused" }),
      makeAd({ id: "ended", endsAt: "2026-09-12T11:00:00.000Z" }),
      makeAd({ id: "other-league", targeting: { pageTypes: [], competitions: ["la-liga"] } }),
      makeAd({ id: "home-only", targeting: { pageTypes: ["home"], competitions: [] } }),
      makeAd({ id: "other-space", space: "in-article" }),
    ];
    const fills = selectFills(ads, request, now, true, seededRng(7));
    expect(fills["in-feed"]?.map((c) => c.adId)).toEqual(["ok"]);
  });

  it("filters by the visitor's country", () => {
    const ads = [
      makeAd({ id: "everywhere" }),
      makeAd({ id: "turkey", targeting: { pageTypes: [], competitions: [], countries: ["TR"] } }),
      makeAd({ id: "uk", targeting: { pageTypes: [], competitions: [], countries: ["GB"] } }),
    ];
    const one = { ...request, spaces: [{ space: "in-feed" as const, count: 4 }] };
    const ids = (country: string | null) =>
      (selectFills(ads, { ...one, country }, now, true, seededRng(2))["in-feed"] ?? []).map((c) => c.adId).sort();
    expect(ids("TR")).toEqual(["everywhere", "turkey"]);
    expect(ids(null)).toEqual(["everywhere"]);
  });

  it("drops code ads when code ads are switched off", () => {
    const code = makeAd({ id: "code", kind: "code", banner: undefined, code: { html: "<ins></ins>" } });
    expect(selectFills([code], request, now, false, seededRng(1))).toEqual({});
    expect(selectFills([code], request, now, true, seededRng(1))["in-feed"]).toHaveLength(1);
  });

  it("fills up to the requested count without repeats", () => {
    const ads = [makeAd({ id: "a" }), makeAd({ id: "b" }), makeAd({ id: "c" })];
    const ids = selectFills(ads, request, now, true, seededRng(3))["in-feed"]?.map((c) => c.adId) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("omits spaces with nothing to show", () => {
    expect(selectFills([], request, now, true)).toEqual({});
  });

  it("sums duplicate space entries into one selection instead of using only the last entry", () => {
    // 4 eligible ads, two entries of 2 each: naively processing entries in order and
    // keeping only the last one's picks would yield just 2 ads; summing the counts
    // (2 + 2 = 4) should select all 4, deduplicated.
    const ads = Array.from({ length: 4 }, (_, i) => makeAd({ id: `ad-${i}` }));
    const dupRequest = {
      page: { type: "article" as const, competition: "premier-league" },
      spaces: [
        { space: "in-feed" as const, count: 2 },
        { space: "in-feed" as const, count: 2 },
      ],
    };
    const ids = selectFills(ads, dupRequest, now, true, seededRng(11))["in-feed"]?.map((c) => c.adId) ?? [];
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("clamps the summed count to 4 (the per-space max) rather than to a single entry's count", () => {
    // 5 eligible ads, two entries of 3 each: the sum (6) must clamp down to 4 -- not to
    // the pool size (5), and not to a single entry's count (3).
    const ads = Array.from({ length: 5 }, (_, i) => makeAd({ id: `ad-${i}` }));
    const dupRequest = {
      page: { type: "article" as const, competition: "premier-league" },
      spaces: [
        { space: "in-feed" as const, count: 3 },
        { space: "in-feed" as const, count: 3 },
      ],
    };
    const ids = selectFills(ads, dupRequest, now, true, seededRng(11))["in-feed"]?.map((c) => c.adId) ?? [];
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("keeps the first-appearance order of spaces in the result", () => {
    const ads = [makeAd({ id: "feed-ad", space: "in-feed" }), makeAd({ id: "sidebar-ad", space: "article-sidebar" })];
    const orderedRequest = {
      page: { type: "article" as const, competition: "premier-league" },
      spaces: [
        { space: "article-sidebar" as const, count: 1 },
        { space: "in-feed" as const, count: 1 },
        { space: "article-sidebar" as const, count: 1 },
      ],
    };
    const fills = selectFills(ads, orderedRequest, now, true, seededRng(1));
    expect(Object.keys(fills)).toEqual(["article-sidebar", "in-feed"]);
  });

  it("still fills a normal single-entry request the same as before", () => {
    const ads = [makeAd({ id: "a" }), makeAd({ id: "b" }), makeAd({ id: "c" })];
    const ids = selectFills(ads, request, now, true, seededRng(3))["in-feed"]?.map((c) => c.adId) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
