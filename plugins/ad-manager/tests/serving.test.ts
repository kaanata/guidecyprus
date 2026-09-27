import { serveAds, trackEvents } from "../src/lib/serving";
import type { StoredAd } from "../src/lib/types";
import { makeAd, seededRng } from "./helpers/fixtures";
import { memoryStores } from "./helpers/memory";

const now = new Date("2026-09-12T12:00:00.000Z");
type TestStores = ReturnType<typeof memoryStores>;

async function putAd(stores: TestStores, ad: StoredAd) {
  const { id, ...data } = ad;
  await stores.ads.put(id, data);
}

const serveRequest = { page: { type: "home" }, spaces: [{ space: "in-feed", count: 2 }] };

describe("serveAds", () => {
  it("rejects invalid input", async () => {
    expect(await serveAds(memoryStores(), { page: { type: "nope" }, spaces: [] }, now)).toEqual({
      ok: false,
      error: "INVALID_INPUT",
    });
  });

  it("returns creatives for active, eligible ads only", async () => {
    const stores = memoryStores();
    await putAd(stores, makeAd({ id: "live" }));
    await putAd(stores, makeAd({ id: "paused", status: "paused" }));
    await putAd(stores, makeAd({ id: "sidebar", space: "article-sidebar" }));

    const result = await serveAds(stores, serveRequest, now, { rng: seededRng(5) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fills["in-feed"]?.map((c) => c.adId)).toEqual(["live"]);
    expect(result.fills["in-feed"]?.[0]).not.toHaveProperty("name");
    expect(result.fills["in-feed"]?.[0]).not.toHaveProperty("weight");
  });

  it("uses the country it is given, not one sent in the request body", async () => {
    const stores = memoryStores();
    await putAd(stores, makeAd({ id: "turkey", targeting: { pageTypes: [], competitions: [], countries: ["TR"] } }));
    const spoofed = { ...serveRequest, country: "TR" };
    expect(await serveAds(stores, spoofed, now, { country: null })).toEqual({ ok: true, fills: {} });
    const result = await serveAds(stores, serveRequest, now, { country: "TR" });
    expect(result.ok && result.fills["in-feed"]?.map((c) => c.adId)).toEqual(["turkey"]);
  });

  it("leaves out code ads when they are switched off", async () => {
    const stores = memoryStores();
    await putAd(stores, makeAd({ id: "code", kind: "code", banner: undefined, code: { html: "<ins></ins>" } }));
    await stores.kv.set("settings:codeAdsEnabled", false);
    expect(await serveAds(stores, serveRequest, now)).toEqual({ ok: true, fills: {} });
  });
});

describe("trackEvents", () => {
  const ids = () => {
    let n = 0;
    return () => `event-${++n}`;
  };

  it("rejects invalid input", async () => {
    expect(await trackEvents(memoryStores(), { events: [] }, now, ids())).toEqual({ ok: false, error: "INVALID_INPUT" });
  });

  it("stores one event record for active ads and drops the rest", async () => {
    const stores = memoryStores();
    await putAd(stores, makeAd({ id: "live" }));
    await putAd(stores, makeAd({ id: "paused", status: "paused" }));

    const result = await trackEvents(
      stores,
      {
        events: [
          { adId: "live", space: "in-feed", type: "impression" },
          { adId: "live", space: "in-feed", type: "click" },
          { adId: "paused", space: "in-feed", type: "impression" },
          { adId: "unknown", space: "in-feed", type: "impression" },
        ],
      },
      now,
      ids(),
    );

    expect(result).toEqual({ ok: true, accepted: 2 });
    expect(stores.events.rows.get("event-1")).toEqual({
      createdAt: now.toISOString(),
      day: "2026-09-12",
      counts: { live: { impressions: 1, clicks: 1 } },
    });
  });

  it("writes nothing when no event is for an active ad", async () => {
    const stores = memoryStores();
    const result = await trackEvents(stores, { events: [{ adId: "unknown", space: "in-feed", type: "click" }] }, now, ids());
    expect(result).toEqual({ ok: true, accepted: 0 });
    expect(stores.events.rows.size).toBe(0);
  });
});
