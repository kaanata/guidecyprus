import { runRollup, statsSummary } from "../src/lib/stats";
import { memoryStores } from "./helpers/memory";

const now = new Date("2026-09-12T12:00:00.000Z");

function addEvent(stores: ReturnType<typeof memoryStores>, id: string, minute: number, counts: Record<string, { impressions: number; clicks: number }>) {
  return stores.events.put(id, { createdAt: `2026-09-12T10:${String(minute).padStart(2, "0")}:00.000Z`, day: "2026-09-12", counts });
}

describe("runRollup", () => {
  it("adds events onto daily stats, deletes them and records the run time", async () => {
    const stores = memoryStores();
    await stores.stats.put("a:2026-09-12", { adId: "a", day: "2026-09-12", impressions: 10, clicks: 1 });
    await addEvent(stores, "e1", 1, { a: { impressions: 3, clicks: 1 } });
    await addEvent(stores, "e2", 2, { a: { impressions: 2, clicks: 0 }, b: { impressions: 1, clicks: 0 } });

    expect(await runRollup(stores, now)).toEqual({ processed: 2, stoppedOnBudget: false });
    expect(stores.stats.rows.get("a:2026-09-12")).toEqual({ adId: "a", day: "2026-09-12", impressions: 15, clicks: 2 });
    expect(stores.stats.rows.get("b:2026-09-12")).toEqual({ adId: "b", day: "2026-09-12", impressions: 1, clicks: 0 });
    expect(stores.events.rows.size).toBe(0);
    expect(stores.kv.data.get("stats:lastRollupAt")).toBe(now.toISOString());
  });

  it("works through several pages", async () => {
    const stores = memoryStores();
    for (let i = 0; i < 5; i++) await addEvent(stores, `e${i}`, i, { a: { impressions: 1, clicks: 0 } });
    expect(await runRollup(stores, now, { maxPages: 5, pageSize: 2 })).toEqual({ processed: 5, stoppedOnBudget: false });
    expect(stores.stats.rows.get("a:2026-09-12")?.impressions).toBe(5);
  });

  it("stops after the page limit and leaves the rest for the next run", async () => {
    const stores = memoryStores();
    for (let i = 0; i < 5; i++) await addEvent(stores, `e${i}`, i, { a: { impressions: 1, clicks: 0 } });
    expect(await runRollup(stores, now, { maxPages: 1, pageSize: 2 })).toEqual({ processed: 2, stoppedOnBudget: false });
    expect(stores.events.rows.size).toBe(3);
  });

  it("records the run time even with nothing to do", async () => {
    const stores = memoryStores();
    expect(await runRollup(stores, now)).toEqual({ processed: 0, stoppedOnBudget: false });
    expect(stores.kv.data.get("stats:lastRollupAt")).toBe(now.toISOString());
  });

  it("drains every page while the wall-clock budget allows it", async () => {
    const stores = memoryStores();
    for (let i = 0; i < 9; i++) await addEvent(stores, `e${i}`, i, { a: { impressions: 1, clicks: 0 } });

    const result = await runRollup(stores, now, { pageSize: 2, budgetMs: 100_000 });

    expect(result).toEqual({ processed: 9, stoppedOnBudget: false });
    expect(stores.events.rows.size).toBe(0);
    expect(stores.stats.rows.get("a:2026-09-12")?.impressions).toBe(9);
  });

  it("stops when the wall-clock budget runs out and leaves the remaining events in storage", async () => {
    const stores = memoryStores();
    for (let i = 0; i < 5; i++) await addEvent(stores, `e${i}`, i, { a: { impressions: 1, clicks: 0 } });

    let calls = 0;
    // First call establishes the deadline (0 + budgetMs); the next call, checked after the
    // first full page, is already past it.
    const clock = () => (calls++ === 0 ? 0 : 1_000_000);

    const result = await runRollup(stores, now, { pageSize: 2, budgetMs: 1_000, clock });

    expect(result).toEqual({ processed: 2, stoppedOnBudget: true });
    expect(stores.events.rows.size).toBe(3);
    expect(stores.stats.rows.get("a:2026-09-12")?.impressions).toBe(2);
    expect(stores.kv.data.get("stats:lastRollupAt")).toBe(now.toISOString());
  });
});

describe("statsSummary", () => {
  it("summarises the window with CTR, daily series and deleted ads", async () => {
    const stores = memoryStores();
    await stores.ads.put("a", {
      name: "Welcome offer",
      kind: "banner",
      space: "in-feed",
      status: "active",
      weight: 10,
      targeting: { pageTypes: [], competitions: [] },
      banner: { image: { mediaId: "m", url: "/a.jpg", width: 300, height: 250 }, href: "https://example.com", alt: "x" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await stores.stats.put("a:2026-09-12", { adId: "a", day: "2026-09-12", impressions: 200, clicks: 3 });
    await stores.stats.put("a:2026-09-06", { adId: "a", day: "2026-09-06", impressions: 100, clicks: 0 });
    await stores.stats.put("a:2026-09-05", { adId: "a", day: "2026-09-05", impressions: 5000, clicks: 50 });
    await stores.stats.put("gone:2026-09-12", { adId: "gone", day: "2026-09-12", impressions: 10, clicks: 1 });

    const result = await statsSummary(stores, { days: 7 }, now);
    expect(result).toMatchObject({ ok: true, days: 7, lastRollupAt: null });
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { adId: "a", name: "Welcome offer", space: "in-feed", impressions: 300, clicks: 3, ctr: 0.01 },
      { adId: "gone", name: "Deleted ad", space: null, impressions: 10, clicks: 1, ctr: 0.1 },
    ]);
    expect(result.daily.a?.map((d) => d.day)).toEqual(["2026-09-06", "2026-09-12"]);
  });

  it("defaults to 7 days and rejects other windows", async () => {
    expect(await statsSummary(memoryStores(), undefined, now)).toMatchObject({ ok: true, days: 7, rows: [] });
    expect(await statsSummary(memoryStores(), { days: 14 }, now)).toEqual({ ok: false, error: "INVALID_INPUT" });
  });
});
