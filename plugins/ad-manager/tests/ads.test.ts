import { deleteAd, getAd, listAds, saveAd } from "../src/lib/ads";
import { readCodeAdsEnabled, saveSettings } from "../src/lib/settings";
import { memoryStores } from "./helpers/memory";

const now = new Date("2026-09-12T12:00:00.000Z");
const later = new Date("2026-09-12T13:00:00.000Z");

const bannerInput = {
  name: "Welcome offer",
  kind: "banner",
  space: "in-feed",
  banner: { image: { mediaId: "m1", url: "/a.jpg", width: 300, height: 250 }, href: "https://example.com", alt: "Offer" },
};

function idFactory() {
  let n = 0;
  return () => `ad-${++n}`;
}

describe("saveAd", () => {
  it("creates an ad with an id and timestamps", async () => {
    const stores = memoryStores();
    const result = await saveAd(stores, bannerInput, now, idFactory());
    expect(result).toMatchObject({ ok: true, ad: { id: "ad-1", status: "active", weight: 10, createdAt: now.toISOString() } });
    expect(stores.ads.rows.get("ad-1")?.name).toBe("Welcome offer");
  });

  it("returns field errors for invalid input and writes nothing", async () => {
    const stores = memoryStores();
    const result = await saveAd(stores, { ...bannerInput, name: "" }, now, idFactory());
    expect(result).toEqual({ ok: false, error: "INVALID_INPUT", fieldErrors: { name: "Enter a name" } });
    expect(stores.ads.rows.size).toBe(0);
  });

  it("updates an existing ad and keeps its creation time", async () => {
    const stores = memoryStores();
    await saveAd(stores, bannerInput, now, idFactory());
    const result = await saveAd(stores, { ...bannerInput, id: "ad-1", status: "paused" }, later, idFactory());
    expect(result).toMatchObject({ ok: true, ad: { id: "ad-1", status: "paused", createdAt: now.toISOString(), updatedAt: later.toISOString() } });
  });

  it("refuses to update an ad that does not exist", async () => {
    const result = await saveAd(memoryStores(), { ...bannerInput, id: "missing" }, now, idFactory());
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("listAds", () => {
  it("lists newest first with 7-day totals", async () => {
    const stores = memoryStores();
    const newId = idFactory();
    await saveAd(stores, bannerInput, now, newId);
    await saveAd(stores, { ...bannerInput, name: "Second" }, later, newId);
    await stores.stats.put("ad-1:2026-09-06", { adId: "ad-1", day: "2026-09-06", impressions: 40, clicks: 2 });
    await stores.stats.put("ad-1:2026-09-05", { adId: "ad-1", day: "2026-09-05", impressions: 999, clicks: 99 });

    const ads = await listAds(stores, later);
    expect(ads.map((a) => a.name)).toEqual(["Second", "Welcome offer"]);
    expect(ads[1]?.last7).toEqual({ impressions: 40, clicks: 2 });
    expect(ads[0]?.last7).toEqual({ impressions: 0, clicks: 0 });
  });
});

describe("getAd and deleteAd", () => {
  it("gets and deletes by id", async () => {
    const stores = memoryStores();
    await saveAd(stores, bannerInput, now, idFactory());
    expect(await getAd(stores, { id: "ad-1" })).toMatchObject({ ok: true, ad: { id: "ad-1" } });
    expect(await deleteAd(stores, { id: "ad-1" })).toEqual({ ok: true });
    expect(await getAd(stores, { id: "ad-1" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await deleteAd(stores, { id: "ad-1" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(await deleteAd(stores, {})).toEqual({ ok: false, error: "INVALID_INPUT" });
  });
});

describe("settings", () => {
  it("defaults code ads to on and saves changes", async () => {
    const { kv } = memoryStores();
    expect(await readCodeAdsEnabled(kv)).toBe(true);
    expect(await saveSettings(kv, { codeAdsEnabled: false })).toEqual({ ok: true, codeAdsEnabled: false });
    expect(await readCodeAdsEnabled(kv)).toBe(false);
    expect(await saveSettings(kv, { codeAdsEnabled: "no" })).toEqual({ ok: false, error: "INVALID_INPUT" });
  });
});
