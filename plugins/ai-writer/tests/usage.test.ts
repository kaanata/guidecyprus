import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/lib/runs";
import {
  formatCost,
  formatTokenPrices,
  getMiniMaxPlanRemains,
  getOpenRouterKeyUsage,
  meter,
  parseOpenRouterUsage,
  readImagePrices,
  recordImagePrices,
  roundCost,
  summarizeRuns,
  usageRoute,
} from "../src/lib/usage";
import { memoryKv, memoryStore } from "./helpers";

describe("usage helpers", () => {
  it("parses OpenRouter usage and ignores replies without it", () => {
    expect(parseOpenRouterUsage({ prompt_tokens: 2, completion_tokens: 17, cost: 6.525e-5 })).toEqual({
      cost: 6.525e-5,
      promptTokens: 2,
      completionTokens: 17,
    });
    expect(parseOpenRouterUsage(undefined)).toBeUndefined();
    expect(parseOpenRouterUsage({ foo: 1 })).toBeUndefined();
  });

  it("formats and rounds costs", () => {
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0.01234)).toBe("$0.0123");
    expect(formatCost(3.456)).toBe("$3.46");
    expect(roundCost(0.1 + 0.2)).toBe(0.3);
  });

  it("meters calls, cost and tokens, counting failed calls without cost", async () => {
    let fail = false;
    const m = meter({
      generateText: async () => {
        if (fail) throw new Error("boom");
        return { json: {}, raw: "", usage: { cost: 0.002, promptTokens: 10, completionTokens: 5 } };
      },
      generateImage: async () => ({ bytes: new Uint8Array(1), contentType: "image/png", usage: { cost: 0.01 } }),
    });
    await m.client.generateText({ model: "a/b", prompt: "p" });
    await m.client.generateImage({ model: "i/m", prompt: "p", width: 1, height: 1 });
    fail = true;
    await expect(m.client.generateText({ model: "a/b", prompt: "p" })).rejects.toThrow("boom");
    expect(m.state).toEqual({ calls: 3, cost: 0.012, tokens: 15 });
  });
});

describe("summarizeRuns", () => {
  const NOW = new Date("2026-09-15T18:00:00.000Z");
  const run = (startedAt: string, source: RunRecord["source"], cost?: number): RunRecord => ({
    source,
    status: "ok",
    warnings: [],
    calls: 2,
    tokens: 100,
    startedAt,
    finishedAt: startedAt,
    ...(cost === undefined ? {} : { cost }),
  });

  it("totals today, the last 7 days and the last 30 days by source", async () => {
    const store = memoryStore<RunRecord>({
      a: run("2026-09-15T09:00:00.000Z", "rule", 0.02),
      b: run("2026-09-15T10:00:00.000Z", "links", 0.003),
      c: run("2026-09-12T10:00:00.000Z", "slop", 0.004),
      d: run("2026-08-25T10:00:00.000Z", "rule", 0.05),
      e: run("2026-07-01T10:00:00.000Z", "rule", 9),
      f: run("2026-09-15T11:00:00.000Z", "express"),
    });
    const s = await summarizeRuns(store, NOW);
    expect(s.today).toMatchObject({ cost: 0.023, runs: 3, calls: 6, tokens: 300 });
    expect(s.today.bySource).toEqual({ rule: { cost: 0.02, runs: 1 }, links: { cost: 0.003, runs: 1 }, express: { cost: 0, runs: 1 } });
    expect(s.week).toMatchObject({ cost: 0.027, runs: 4 });
    expect(s.month).toMatchObject({ cost: 0.077, runs: 5 });
    expect(s.allTime).toMatchObject({ cost: 9.077, runs: 6 });
  });

  it("counts new posts and averages the writing cost over posts that recorded one", async () => {
    const post = (id: string, source: RunRecord["source"], cost?: number, status: RunRecord["status"] = "ok"): RunRecord => ({
      ...run("2026-09-15T09:00:00.000Z", source, cost),
      postId: id,
      status,
    });
    const store = memoryStore<RunRecord>({
      a: post("p1", "rule", 0.02),
      b: post("p2", "rule", 0.04),
      c: post("p3", "express", 0.03),
      d: post("p4", "rule"),
      e: post("p5", "rule", 0.5, "error"),
      f: post("p1", "links", 0.01),
    });
    const s = await summarizeRuns(store, NOW);
    expect(s.today).toMatchObject({ posts: 4, costedPosts: 3, costedPostsCost: 0.09, avgPostCost: 0.03 });
    expect((await summarizeRuns(memoryStore<RunRecord>(), NOW)).today.avgPostCost).toBeNull();
  });
});

describe("getOpenRouterKeyUsage", () => {
  it("reads usage, limit and remaining from the key endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { usage: 5.08, usage_daily: 2.99, usage_weekly: 4.7, usage_monthly: 5.08, limit: 10, limit_remaining: 7.01 } })),
    ) as unknown as typeof fetch;
    expect(await getOpenRouterKeyUsage("k", fetchImpl)).toEqual({ usage: 5.08, daily: 2.99, weekly: 4.7, monthly: 5.08, limit: 10, remaining: 7.01 });
  });

  it("reports a key without a limit and fails on HTTP errors", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: { usage: 1, limit: null } }))) as unknown as typeof fetch;
    expect(await getOpenRouterKeyUsage("k", ok)).toMatchObject({ usage: 1, limit: null, remaining: null });
    const bad = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(getOpenRouterKeyUsage("k", bad)).rejects.toThrow("OpenRouter 401");
  });
});

describe("usageRoute", () => {
  it("returns run totals with the OpenRouter key usage, or the key error", async () => {
    const store = memoryStore<RunRecord>();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { usage: 2, limit: 10, limit_remaining: 8 } }))) as unknown as typeof fetch;
    const ok = await usageRoute({
      runs: store,
      getOpenRouterKey: async () => "k",
      lowCreditThreshold: 2,
      fetchImpl,
      now: () => new Date("2026-09-15T00:00:00Z"),
    });
    expect(ok.openrouter).toMatchObject({ usage: 2, limit: 10, remaining: 8 });
    expect(ok.lowCredit).toEqual({ threshold: 2, low: false });
    const low = await usageRoute({ runs: store, getOpenRouterKey: async () => "k", lowCreditThreshold: 9, fetchImpl });
    expect(low.lowCredit).toEqual({ threshold: 9, low: true });
    const off = await usageRoute({ runs: store, getOpenRouterKey: async () => "k", lowCreditThreshold: 0, fetchImpl });
    expect(off.lowCredit.low).toBe(false);
    expect(ok.summary.month.runs).toBe(0);
    const noKey = await usageRoute({
      runs: store,
      lowCreditThreshold: 2,
      getOpenRouterKey: async () => {
        throw new Error("OPENROUTER_API_KEY is not bound");
      },
    });
    expect(noKey).toMatchObject({ openrouter: null, openrouterError: "OPENROUTER_API_KEY is not bound" });
  });
});

describe("observed image prices and token price labels", () => {
  it("remembers the latest cost per image model and merges with earlier ones", async () => {
    const kv = memoryKv();
    await recordImagePrices(kv, { "meta/muse-image": 0.01 });
    await recordImagePrices(kv, { "bytedance-seed/seedream-5-0-lite": 0.03 });
    await recordImagePrices(kv, {});
    expect(await readImagePrices(kv)).toEqual({ "meta/muse-image": 0.01, "bytedance-seed/seedream-5-0-lite": 0.03 });
  });

  it("records image cost only for images that came back", async () => {
    const m = meter({
      generateText: async () => ({ json: {}, raw: "" }),
      generateImage: async (input: { model: string }) =>
        input.model === "empty/model"
          ? { bytes: new Uint8Array(0), contentType: "image/png", usage: { cost: 0.02 } }
          : { bytes: new Uint8Array(3), contentType: "image/png", usage: { cost: 0.01 } },
    });
    await m.client.generateImage({ model: "meta/muse-image", prompt: "p", width: 1, height: 1 });
    await m.client.generateImage({ model: "empty/model", prompt: "p", width: 1, height: 1 });
    expect(m.imageCosts).toEqual({ "meta/muse-image": 0.01 });
  });

  it("formats per-token prices per million tokens", () => {
    expect(formatTokenPrices(0.00000075, 0.00000375)).toBe("$0.75 in / $3.75 out per 1M tokens");
    expect(formatTokenPrices(0.00000015, undefined)).toBe("$0.15 in / ? out per 1M tokens");
    expect(formatTokenPrices(0.00000002, 0)).toBe("$0.020 in / $0.00 out per 1M tokens");
    expect(formatTokenPrices()).toBe("");
  });
});

describe("MiniMax Token Plan quota", () => {
  const REMAINS = {
    model_remains: [
      {
        model_name: "general",
        end_time: 1789502400000,
        weekly_end_time: 1789948800000,
        current_interval_remaining_percent: 99,
        current_weekly_remaining_percent: 8,
      },
      { model_name: "video", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
    ],
  };

  it("reads the shared general quota windows", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(REMAINS))) as unknown as typeof fetch;
    expect(await getMiniMaxPlanRemains("sk-cp-x", fetchImpl)).toEqual({
      interval: { remainingPercent: 99, resetsAt: new Date(1789502400000).toISOString() },
      weekly: { remainingPercent: 8, resetsAt: new Date(1789948800000).toISOString() },
    });
    const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toBe("https://www.minimax.io/v1/token_plan/remains");
  });

  it("returns null for a key without a plan and fails on HTTP errors", async () => {
    const none = vi.fn(async () => new Response(JSON.stringify({ model_remains: [] }))) as unknown as typeof fetch;
    expect(await getMiniMaxPlanRemains("k", none)).toBeNull();
    const bad = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(getMiniMaxPlanRemains("k", bad)).rejects.toThrow("MiniMax 401");
  });

  it("flags a low plan window in the usage route and still reports OpenRouter", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("token_plan")
        ? new Response(JSON.stringify(REMAINS))
        : new Response(JSON.stringify({ data: { usage: 1, limit: 10, limit_remaining: 9 } })),
    ) as unknown as typeof fetch;
    const out = await usageRoute({
      runs: memoryStore<RunRecord>(),
      getOpenRouterKey: async () => "or",
      getMiniMaxKey: async () => "sk-cp-x",
      lowCreditThreshold: 2,
      fetchImpl,
    });
    expect(out.minimax?.weekly.remainingPercent).toBe(8);
    expect(out.lowPlan).toBe(true);
    expect(out.openrouter?.remaining).toBe(9);
  });
});

