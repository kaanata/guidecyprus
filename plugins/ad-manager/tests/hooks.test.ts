import { KV_CODE_ADS, ROLLUP_CRON } from "../src/constants";
import { ensureRollupScheduled, fragmentsHook } from "../src/hooks";
import { LOADER_SOURCE } from "../src/loader";
import { makeAd } from "./helpers/fixtures";
import { memoryStores } from "./helpers/memory";

describe("ensureRollupScheduled", () => {
  it("schedules the rollup exactly once when list() returns no matching task", async () => {
    const list = vi.fn(async () => []);
    const schedule = vi.fn(async () => undefined);

    await ensureRollupScheduled({ cron: { list, schedule } });

    expect(list).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("stats-rollup", { schedule: "*/5 * * * *" });
  });

  it("does not schedule when list() already has the rollup task", async () => {
    const list = vi.fn(async () => [{ name: "stats-rollup", schedule: "*/5 * * * *", nextRunAt: "x", lastRunAt: null }]);
    const schedule = vi.fn(async () => undefined);

    await ensureRollupScheduled({ cron: { list, schedule } });

    expect(list).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("is a no-op when ctx.cron is undefined", async () => {
    await expect(ensureRollupScheduled({})).resolves.toBeUndefined();
  });
});

describe("ROLLUP_CRON", () => {
  // EmDash's CronAccess.schedule() rejects any task name that doesn't match this pattern
  // (validateTaskName in node_modules/emdash/dist/cron-Y9aLtgrA.mjs) -- e.g. a colon, like the
  // old "ad-manager:rollup" name, throws "Invalid task name" and the rollup is silently never
  // scheduled. Guard against regressing to an invalid name.
  it("matches EmDash's cron task name pattern", () => {
    expect(ROLLUP_CRON).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});

describe("fragmentsHook", () => {
  const NOW = new Date("2026-09-15T12:00:00.000Z");
  const loader = { kind: "inline-script", placement: "body:end", key: "ad-manager-loader", code: LOADER_SOURCE };

  function ctxOf(stores: ReturnType<typeof memoryStores>, log = { warn: vi.fn() }) {
    return { storage: { ads: stores.ads, events: stores.events, stats: stores.stats }, kv: stores.kv, log };
  }

  it("returns no fragment when there are no ads", async () => {
    expect(await fragmentsHook(ctxOf(memoryStores()), NOW)).toBeNull();
  });

  it("returns no fragment when every ad is paused, expired or not started yet", async () => {
    const stores = memoryStores();
    await stores.ads.put("paused", makeAd({ status: "paused" }));
    await stores.ads.put("expired", makeAd({ endsAt: "2026-09-15T12:00:00.000Z" }));
    await stores.ads.put("future", makeAd({ startsAt: "2026-09-16T00:00:00.000Z" }));

    expect(await fragmentsHook(ctxOf(stores), NOW)).toBeNull();
  });

  it("injects the loader at the end of the body when an active banner ad is live", async () => {
    const stores = memoryStores();
    await stores.ads.put("paused", makeAd({ status: "paused" }));
    await stores.ads.put("live", makeAd({ startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-10-01T00:00:00.000Z" }));

    expect(await fragmentsHook(ctxOf(stores), NOW)).toEqual(loader);
  });

  it("returns no fragment when the only live ads are code ads and code ads are switched off", async () => {
    const stores = memoryStores();
    await stores.ads.put("code", makeAd({ kind: "code", banner: undefined, code: { html: "<div></div>" } }));
    await stores.kv.set(KV_CODE_ADS, false);

    expect(await fragmentsHook(ctxOf(stores), NOW)).toBeNull();
  });

  it("injects the loader for a live code ad while code ads are switched on", async () => {
    const stores = memoryStores();
    await stores.ads.put("code", makeAd({ kind: "code", banner: undefined, code: { html: "<div></div>" } }));

    expect(await fragmentsHook(ctxOf(stores), NOW)).toEqual(loader);
  });

  it("reads storage with a single query and skips the settings read when a banner is live", async () => {
    const stores = memoryStores();
    await stores.ads.put("live", makeAd());
    const query = vi.spyOn(stores.ads, "query");
    const kvGet = vi.spyOn(stores.kv, "get");

    await fragmentsHook(ctxOf(stores), NOW);

    expect(query).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
  });

  it("fails open and warns when storage can't be read", async () => {
    const stores = memoryStores();
    vi.spyOn(stores.ads, "query").mockRejectedValue(new Error("D1 unavailable"));
    const log = { warn: vi.fn() };

    expect(await fragmentsHook(ctxOf(stores, log), NOW)).toEqual(loader);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("D1 unavailable"));
  });
});
