import { cronHook, fragmentsHook } from "../src/hooks";
import { LOADER_SOURCE } from "../src/loader";
import { runRollup } from "../src/lib/stats";
import { routes } from "../src/routes";
import { makeAd } from "./helpers/fixtures";
import { memoryStores } from "./helpers/memory";

vi.mock("../src/lib/stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/stats")>();
  return { ...actual, runRollup: vi.fn(actual.runRollup) };
});

type TestStores = ReturnType<typeof memoryStores>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(stores: TestStores, method: "GET" | "POST", input?: unknown, country: string | null = null): any {
  return {
    request: { method },
    requestMeta: { ip: null, userAgent: null, referer: null, geo: country ? { country, region: null, city: null } : null },
    input,
    storage: { ads: stores.ads, events: stores.events, stats: stores.stats },
    kv: stores.kv,
  };
}

function makeCronCtx(stores: TestStores, method: "GET" | "POST", input: unknown, cron: unknown): any {
  return { ...makeCtx(stores, method, input), cron };
}

const bannerInput = {
  name: "Welcome offer",
  kind: "banner",
  space: "in-feed",
  banner: { image: { mediaId: "m1", url: "/a.jpg", width: 300, height: 250 }, href: "https://example.com", alt: "Offer" },
};

describe("routes", () => {
  it("has the expected routes and only serve and track are public", () => {
    expect(Object.keys(routes).sort()).toEqual([
      "ads/delete",
      "ads/get",
      "ads/list",
      "ads/save",
      "serve",
      "settings",
      "stats/summary",
      "track",
    ]);
    const publicRoutes = Object.entries(routes)
      .filter(([, route]) => route.public)
      .map(([name]) => name)
      .sort();
    expect(publicRoutes).toEqual(["serve", "track"]);
  });

  it("serves country-targeted ads only to visitors from those countries", async () => {
    const stores = memoryStores();
    const input = { ...bannerInput, targeting: { countries: ["TR"] } };
    expect(await routes["ads/save"]!.handler(makeCtx(stores, "POST", input))).toMatchObject({ ok: true });
    const serveBody = { page: { type: "home" }, spaces: [{ space: "in-feed", count: 1 }] };
    const fromTurkey = (await routes.serve!.handler(makeCtx(stores, "POST", serveBody, "TR"))) as { fills: Record<string, unknown[]> };
    const fromGermany = (await routes.serve!.handler(makeCtx(stores, "POST", serveBody, "DE"))) as { fills: Record<string, unknown[]> };
    expect(fromTurkey.fills["in-feed"]).toHaveLength(1);
    expect(fromGermany.fills).toEqual({});
  });

  it("saves, lists, serves and tracks an ad", async () => {
    const stores = memoryStores();
    expect(await routes["ads/save"]!.handler(makeCtx(stores, "POST", bannerInput))).toMatchObject({ ok: true });

    const list = await routes["ads/list"]!.handler(makeCtx(stores, "GET"));
    expect(list).toMatchObject({ ok: true, codeAdsEnabled: true, ads: [{ name: "Welcome offer" }] });

    const served = (await routes.serve!.handler(
      makeCtx(stores, "POST", { page: { type: "home" }, spaces: [{ space: "in-feed", count: 1 }] }),
    )) as { ok: boolean; fills: Record<string, Array<{ adId: string }>> };
    expect(served.ok).toBe(true);
    const adId = served.fills["in-feed"]![0]!.adId;

    const tracked = await routes.track!.handler(
      makeCtx(stores, "POST", { events: [{ adId, space: "in-feed", type: "impression" }] }),
    );
    expect(tracked).toEqual({ ok: true, accepted: 1 });
    expect(stores.events.rows.size).toBe(1);
  });

  it("reads and saves settings", async () => {
    const stores = memoryStores();
    expect(await routes.settings!.handler(makeCtx(stores, "GET"))).toEqual({ ok: true, codeAdsEnabled: true });
    expect(await routes.settings!.handler(makeCtx(stores, "POST", { codeAdsEnabled: false }))).toEqual({
      ok: true,
      codeAdsEnabled: false,
    });
  });

  it("returns a stats summary", async () => {
    expect(await routes["stats/summary"]!.handler(makeCtx(memoryStores(), "POST", { days: 30 }))).toMatchObject({
      ok: true,
      days: 30,
      rows: [],
    });
  });

  it("schedules the rollup when ads/list runs with a cron API", async () => {
    const list = vi.fn(async () => []);
    const schedule = vi.fn(async () => undefined);
    const ctx = makeCronCtx(memoryStores(), "GET", undefined, { list, schedule });

    const result = await routes["ads/list"]!.handler(ctx);

    expect(schedule).toHaveBeenCalledWith("stats-rollup", { schedule: "*/5 * * * *" });
    expect(result).toMatchObject({ ok: true, ads: [], codeAdsEnabled: true });
  });

  it("does not touch cron when serve runs", async () => {
    const list = vi.fn(async () => []);
    const schedule = vi.fn(async () => undefined);
    const ctx = makeCronCtx(memoryStores(), "POST", { page: { type: "home" }, spaces: [] }, { list, schedule });

    await routes.serve!.handler(ctx);

    expect(list).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("does not break the route when scheduling the rollup fails, but logs a warning", async () => {
    const list = vi.fn(async () => []);
    const schedule = vi.fn(async () => {
      throw new Error("cron unavailable");
    });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = { ...makeCronCtx(memoryStores(), "GET", undefined, { list, schedule }), log };

    const result = await routes["ads/list"]!.handler(ctx);

    expect(result).toMatchObject({ ok: true, ads: [], codeAdsEnabled: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not schedule the stats rollup"));
  });
});

describe("hooks", () => {
  it("injects the loader at the end of the body when an ad is live", async () => {
    const stores = memoryStores();
    await stores.ads.put("a", makeAd());
    const ctx = { storage: { ads: stores.ads, events: stores.events, stats: stores.stats }, kv: stores.kv };
    expect(await fragmentsHook(ctx, new Date("2026-09-15T00:00:00.000Z"))).toEqual({
      kind: "inline-script",
      placement: "body:end",
      key: "ad-manager-loader",
      code: LOADER_SOURCE,
    });
  });

  it("runs the rollup only for its own cron task", async () => {
    const stores = memoryStores();
    await stores.events.put("e1", {
      createdAt: "2026-09-12T10:00:00.000Z",
      day: "2026-09-12",
      counts: { a: { impressions: 1, clicks: 0 } },
    });
    const ctx = { storage: { ads: stores.ads, events: stores.events, stats: stores.stats }, kv: stores.kv };

    await cronHook({ name: "someone-else" }, ctx);
    expect(stores.events.rows.size).toBe(1);

    await cronHook({ name: "stats-rollup" }, ctx);
    expect(stores.events.rows.size).toBe(0);
    expect(stores.stats.rows.get("a:2026-09-12")?.impressions).toBe(1);
  });

  it("logs how many events were processed when a logger is available", async () => {
    const stores = memoryStores();
    await stores.events.put("e1", {
      createdAt: "2026-09-12T10:00:00.000Z",
      day: "2026-09-12",
      counts: { a: { impressions: 1, clicks: 0 } },
    });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = { storage: { ads: stores.ads, events: stores.events, stats: stores.stats }, kv: stores.kv, log };

    await cronHook({ name: "stats-rollup" }, ctx);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("processed 1"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not crash without a logger, and warns through one when the rollup stops on its budget", async () => {
    const stores = memoryStores();
    const ctxNoLog = { storage: { ads: stores.ads, events: stores.events, stats: stores.stats }, kv: stores.kv };
    vi.mocked(runRollup).mockResolvedValueOnce({ processed: 500, stoppedOnBudget: true });
    await expect(cronHook({ name: "stats-rollup" }, ctxNoLog)).resolves.toBeUndefined();

    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.mocked(runRollup).mockResolvedValueOnce({ processed: 500, stoppedOnBudget: true });
    await cronHook({ name: "stats-rollup" }, { ...ctxNoLog, log });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("stopped on its time budget"));
  });
});
