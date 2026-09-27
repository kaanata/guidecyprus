import { describe, expect, it, vi } from "vitest";
import { DuplicateTopicError } from "../src/lib/content";
import { PipelineError, type PipelineResult } from "../src/lib/pipeline";
import type { Provider } from "../src/lib/providers";
import { createRule, ruleInputSchema, type Rule } from "../src/lib/rules";
import { listRuns, type RunRecord } from "../src/lib/runs";
import {
  acquireTickLock,
  cronTick,
  LOCK_STALE_MS,
  releaseTickLock,
  RuleBusyError,
  runRuleManually,
  runRuleOnce,
  TICK_LOCK_KEY,
  type SchedulerDeps,
} from "../src/lib/scheduler";
import { SETTINGS_KEY } from "../src/lib/settings";
import { memoryKv, memoryStore, minimaxTextSettings } from "./helpers";

const NOW = new Date("2026-09-11T12:00:00Z");
const hoursFrom = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000).toISOString();

function makeRule(id: string, overrides: Partial<Rule> = {}): Rule {
  const created = createRule(
    ruleInputSchema.parse({ name: `Rule ${id}`, topics: ["t1", "t2", "t3"] }),
    id,
    new Date(NOW.getTime() - 3_600_000),
  );
  return { ...created, ...overrides };
}

const okResult = (topic: string): PipelineResult => ({
  postId: `post-${topic}`,
  slug: topic,
  title: topic,
  status: "draft",
  warnings: [],
  calls: 9,
  cost: 0.021,
  tokens: 4200,
  imageCosts: {},
});

type PipelineFn = (deps: unknown, topic: string) => Promise<PipelineResult>;

function setup(rules: Rule[], pipeline: PipelineFn = async (_d, topic) => okResult(topic), clock?: () => Date) {
  const rulesStore = memoryStore<Rule>(Object.fromEntries(rules.map((r) => [r.id, r])));
  const runsStore = memoryStore<RunRecord>();
  const kv = memoryKv();
  const pipe = vi.fn(pipeline);
  const log = vi.fn();
  const deps: SchedulerDeps = {
    kv,
    rules: rulesStore,
    runs: runsStore,
    getApiKey: async () => "test-key",
    content: { get: vi.fn(), create: vi.fn(), publish: vi.fn() } as unknown as SchedulerDeps["content"],
    getTerms: async () => [],
    now: clock ?? (() => NOW),
    pipeline: pipe as unknown as SchedulerDeps["pipeline"],
    log,
  };
  return { deps, rulesStore, runsStore, kv, pipe, log };
}

describe("tick lock", () => {
  it("acquires a free lock, refuses a fresh one, and takes over a stale one", async () => {
    const kv = memoryKv();
    expect(await acquireTickLock(kv, NOW, "a")).toBe(true);
    expect(await acquireTickLock(kv, new Date(NOW.getTime() + 60_000), "b")).toBe(false);
    expect(await acquireTickLock(kv, new Date(NOW.getTime() + LOCK_STALE_MS + 1), "c")).toBe(true);
    await releaseTickLock(kv, "a");
    expect(kv.map.has(TICK_LOCK_KEY)).toBe(true);
    await releaseTickLock(kv, "c");
    expect(kv.map.has(TICK_LOCK_KEY)).toBe(false);
  });
});

describe("cronTick", () => {
  it("does nothing while another tick holds a fresh lock", async () => {
    const { deps, kv, pipe } = setup([makeRule("rule-a")]);
    kv.map.set(TICK_LOCK_KEY, { at: NOW.toISOString(), token: "other" });
    expect(await cronTick(deps)).toEqual({ locked: true, ran: [] });
    expect(pipe).not.toHaveBeenCalled();
  });

  it("runs at most four due rules with one post each, then releases the lock", async () => {
    const { deps, pipe, kv } = setup([
      makeRule("rule-a"),
      makeRule("rule-b"),
      makeRule("rule-c"),
      makeRule("rule-d"),
      makeRule("rule-e"),
      makeRule("rule-future", { nextRunAt: hoursFrom(NOW, 2) }),
    ]);
    const result = await cronTick(deps);
    expect(result.locked).toBe(false);
    expect(result.ran).toHaveLength(4);
    expect(pipe).toHaveBeenCalledTimes(4);
    expect(kv.map.has(TICK_LOCK_KEY)).toBe(false);
  });

  it("spreads postsPerRun across ticks and reschedules when the run completes", async () => {
    let t = NOW.getTime();
    const { deps, rulesStore } = setup([makeRule("rule-a", { postsPerRun: 2 })], undefined, () => new Date(t));

    await cronTick(deps);
    let stored = rulesStore.map.get("rule-a") as Rule;
    expect(stored.pendingInRun).toBe(1);
    expect(stored.topics).toEqual(["t2", "t3"]);
    expect(stored.lastRunAt).toBeUndefined();

    t += 15 * 60_000;
    await cronTick(deps);
    stored = rulesStore.map.get("rule-a") as Rule;
    expect(stored.pendingInRun).toBe(0);
    expect(stored.topics).toEqual(["t3"]);
    expect(stored.lastRunAt).toBe(new Date(t).toISOString());
    expect(stored.nextRunAt).toBe(hoursFrom(new Date(t), 24));
  });

  it("records a duplicate topic as skipped and moves on to the next topic", async () => {
    const { deps, rulesStore } = setup([makeRule("rule-a")], async () => {
      throw new DuplicateTopicError("t1");
    });
    const { ran } = await cronTick(deps);
    expect(ran[0]).toMatchObject({ status: "skipped", topic: "t1", ruleId: "rule-a" });
    const stored = rulesStore.map.get("rule-a") as Rule;
    expect(stored.topics).toEqual(["t2", "t3"]);
    expect(stored.failStreak).toBe(0);
  });

  it("counts failures and deactivates the rule after three", async () => {
    const { deps, rulesStore } = setup([makeRule("rule-a")], async () => {
      throw new PipelineError("outline", "model returned nothing");
    });
    const first = await cronTick(deps);
    expect(first.ran[0]).toMatchObject({ status: "error", error: "outline: model returned nothing" });
    expect((rulesStore.map.get("rule-a") as Rule).failStreak).toBe(1);
    await cronTick(deps);
    await cronTick(deps);
    const stored = rulesStore.map.get("rule-a") as Rule;
    expect(stored).toMatchObject({ active: false, failStreak: 3, topics: ["t1", "t2", "t3"] });
    expect((await cronTick(deps)).ran).toHaveLength(0);
  });

  it("does not start a second rule once the tick budget is spent", async () => {
    let t = NOW.getTime();
    const { deps, pipe } = setup(
      [makeRule("rule-a"), makeRule("rule-b")],
      async (_d, topic) => {
        t += 6 * 60_000;
        return okResult(topic);
      },
      () => new Date(t),
    );
    const { ran } = await cronTick(deps);
    expect(ran).toHaveLength(1);
    expect(pipe).toHaveBeenCalledTimes(1);
  });

  describe("re-reads each rule before running it", () => {
    // Rule A runs first; its pipeline changes rule B before B's turn.
    function mutatingB(change: (store: ReturnType<typeof setup>["rulesStore"]) => Promise<void>) {
      let first = true;
      const ctx = setup([makeRule("rule-a"), makeRule("rule-b")], async (_d, topic) => {
        if (first) {
          first = false;
          await change(ctx.rulesStore);
        }
        return okResult(topic);
      });
      return ctx;
    }

    it("does not run or recreate a rule deleted during the tick", async () => {
      const { deps, rulesStore, pipe } = mutatingB(async (store) => {
        await store.delete("rule-b");
      });
      const { ran } = await cronTick(deps);
      expect(ran.map((r) => r.ruleId)).toEqual(["rule-a"]);
      expect(pipe).toHaveBeenCalledTimes(1);
      expect(rulesStore.map.has("rule-b")).toBe(false);
    });

    it("does not run a rule paused during the tick", async () => {
      const { deps, rulesStore, pipe } = mutatingB(async (store) => {
        const b = (await store.get("rule-b")) as Rule;
        await store.put("rule-b", { ...b, active: false });
      });
      await cronTick(deps);
      expect(pipe).toHaveBeenCalledTimes(1);
      expect((rulesStore.map.get("rule-b") as Rule).active).toBe(false);
    });

    it("uses the queue as edited during the tick", async () => {
      const { deps, rulesStore } = mutatingB(async (store) => {
        const b = (await store.get("rule-b")) as Rule;
        await store.put("rule-b", { ...b, topics: ["fresh"] });
      });
      const { ran } = await cronTick(deps);
      expect(ran[1]).toMatchObject({ ruleId: "rule-b", topic: "fresh", status: "ok" });
      expect((rulesStore.map.get("rule-b") as Rule).topics).toEqual([]);
    });
  });

  it("treats a missing text key as a failed attempt without running the pipeline", async () => {
    const { deps, rulesStore, pipe } = setup([makeRule("rule-a")]);
    const getApiKey = vi.fn(async (_p: Provider): Promise<string> => {
      throw new Error("OPENROUTER_API_KEY is not bound");
    });
    deps.getApiKey = getApiKey;
    const { ran } = await cronTick(deps);
    expect(ran[0]).toMatchObject({ status: "error", error: "OPENROUTER_API_KEY is not bound" });
    expect((rulesStore.map.get("rule-a") as Rule).failStreak).toBe(1);
    expect(getApiKey).toHaveBeenCalledWith("openrouter");
    expect(pipe).not.toHaveBeenCalled();
  });

  it("checks the selected text provider's key", async () => {
    const { deps, kv } = setup([makeRule("rule-a")]);
    kv.map.set(SETTINGS_KEY, minimaxTextSettings);
    const getApiKey = vi.fn(async (_p: Provider) => "k");
    deps.getApiKey = getApiKey;
    const { ran } = await cronTick(deps);
    expect(ran[0]).toMatchObject({ status: "ok" });
    expect(getApiKey).toHaveBeenCalledWith("minimax");
  });
});

describe("runRuleManually", () => {
  it("refuses while a cron tick holds a fresh lock", async () => {
    const { deps, kv, pipe } = setup([makeRule("rule-a")]);
    kv.map.set(TICK_LOCK_KEY, { at: NOW.toISOString(), token: "tick" });
    await expect(runRuleManually(deps, "rule-a")).rejects.toBeInstanceOf(RuleBusyError);
    expect(pipe).not.toHaveBeenCalled();
    expect(kv.map.get(TICK_LOCK_KEY)).toEqual({ at: NOW.toISOString(), token: "tick" });
  });

  it("runs the stored rule as a manual run and releases the lock", async () => {
    const rule = makeRule("rule-a", { nextRunAt: hoursFrom(NOW, 6) });
    const { deps, kv, rulesStore } = setup([rule]);
    const run = await runRuleManually(deps, "rule-a");
    expect(run).toMatchObject({ ruleId: "rule-a", topic: "t1", status: "ok" });
    expect(rulesStore.map.get("rule-a")).toMatchObject({ topics: ["t2", "t3"], nextRunAt: hoursFrom(NOW, 6) });
    expect(kv.map.has(TICK_LOCK_KEY)).toBe(false);
  });

  it("returns null when the rule is gone or its queue is empty", async () => {
    const { deps, kv, pipe } = setup([makeRule("rule-a", { topics: [] })]);
    expect(await runRuleManually(deps, "rule-a")).toBeNull();
    expect(await runRuleManually(deps, "rule-missing")).toBeNull();
    expect(pipe).not.toHaveBeenCalled();
    expect(kv.map.has(TICK_LOCK_KEY)).toBe(false);
  });
});

describe("runRuleOnce", () => {
  it("writes a run record with the post link", async () => {
    const { deps, runsStore } = setup([makeRule("rule-a")]);
    const run = await runRuleOnce(deps, makeRule("rule-a"), true);
    expect(run).toMatchObject({
      source: "rule",
      ruleId: "rule-a",
      ruleName: "Rule rule-a",
      topic: "t1",
      postId: "post-t1",
      editUrl: "/_emdash/admin/content/posts/post-t1",
      status: "ok",
      calls: 9,
      startedAt: NOW.toISOString(),
    });
    expect(run.id).toMatch(/^run-/);
    expect(await listRuns(runsStore, { limit: 5 })).toEqual([run]);
  });

  it("manual runs consume the topic but leave the schedule alone", async () => {
    const rule = makeRule("rule-a", { nextRunAt: hoursFrom(NOW, 6) });
    const { deps, rulesStore } = setup([rule]);
    await runRuleOnce(deps, rule, true);
    expect(rulesStore.map.get("rule-a")).toMatchObject({
      topics: ["t2", "t3"],
      nextRunAt: hoursFrom(NOW, 6),
      pendingInRun: 0,
    });
  });

  it("keeps edits made to the rule while the post was generating", async () => {
    const rule = makeRule("rule-a");
    const { deps, rulesStore } = setup([rule]);
    deps.pipeline = (async (_d: unknown, topic: string) => {
      const current = (await rulesStore.get("rule-a")) as Rule;
      await rulesStore.put("rule-a", { ...current, name: "Edited", topics: [...current.topics, "t4"] });
      return okResult(topic);
    }) as unknown as SchedulerDeps["pipeline"];
    await runRuleOnce(deps, rule, true);
    expect(rulesStore.map.get("rule-a")).toMatchObject({ name: "Edited", topics: ["t2", "t3", "t4"] });
  });

  it("does not resurrect a rule deleted during the run", async () => {
    const rule = makeRule("rule-a");
    const { deps, rulesStore } = setup([rule]);
    deps.pipeline = (async (_d: unknown, topic: string) => {
      await rulesStore.delete("rule-a");
      return okResult(topic);
    }) as unknown as SchedulerDeps["pipeline"];
    await runRuleOnce(deps, rule, true);
    expect(rulesStore.map.has("rule-a")).toBe(false);
  });

  it("logs but does not throw when run history cannot be written", async () => {
    const { deps, runsStore, log } = setup([makeRule("rule-a")]);
    runsStore.put = async () => {
      throw new Error("disk full");
    };
    const run = await runRuleOnce(deps, makeRule("rule-a"), true);
    expect(run.status).toBe("ok");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("still records the run when the rule state cannot be saved", async () => {
    const { deps, rulesStore, runsStore, log } = setup([makeRule("rule-a")]);
    rulesStore.put = async () => {
      throw new Error("rules write failed");
    };
    const run = await runRuleOnce(deps, makeRule("rule-a"), true);
    expect(run.status).toBe("ok");
    expect(await listRuns(runsStore, { limit: 5 })).toEqual([run]);
    expect(log).toHaveBeenCalledWith("Rule state could not be saved: rules write failed");
  });

  it("hands the rule's locale and the collection lookup to the pipeline", async () => {
    const rule = makeRule("rule-tr", { options: { ...makeRule("x").options, locale: "tr", collection: "pages" } });
    const { deps, pipe } = setup([rule]);
    deps.getCollectionInfo = vi.fn(async () => null);
    const run = await runRuleOnce(deps, rule, true);
    const [pipeDeps, , options] = pipe.mock.calls[0] as unknown as [{ getCollectionInfo: unknown }, string, { locale: string }];
    expect(options.locale).toBe("tr");
    expect(pipeDeps.getCollectionInfo).toBe(deps.getCollectionInfo);
    expect(run.editUrl).toBe("/_emdash/admin/content/pages/post-t1");
  });

  it("refuses a rule with an empty queue", async () => {
    const rule = makeRule("rule-a", { topics: [] });
    const { deps } = setup([rule]);
    await expect(runRuleOnce(deps, rule, true)).rejects.toThrow("no topics left");
  });
});

describe("automatic topic sources", () => {
  const autoRule = (id: string, overrides: Partial<Rule> = {}): Rule =>
    makeRule(id, { topics: [], topicSource: "rss", feeds: ["https://cyprus.test/feed"], postsPerRun: 2, ...overrides });

  it("refills an empty feed rule on the tick and writes its first post", async () => {
    const { deps, rulesStore, pipe } = setup([autoRule("rule-s")]);
    deps.findTopics = vi.fn(async () => ({
      found: [
        { key: "https://cyprus.test/a", topic: "Kyrenia harbour reopens" },
        { key: "https://cyprus.test/b", topic: "Troodos trail guide" },
      ],
    }));
    const result = await cronTick(deps);
    expect(result.ran).toHaveLength(1);
    expect(pipe.mock.calls[0][1]).toBe("Kyrenia harbour reopens");
    const stored = rulesStore.map.get("rule-s") as Rule;
    expect(stored.sourceSeen).toHaveLength(2);
    expect(stored.topics).toEqual(["Troodos trail guide"]);
    expect(stored.pendingInRun).toBe(1);
  });

  it("never refills a rule stored with the retired sports schedule", async () => {
    const legacy = { ...makeRule("rule-old", { topics: [] }), topicSource: "sports" } as unknown as Rule;
    const { deps, pipe } = setup([legacy]);
    deps.findTopics = vi.fn(async () => ({ found: [{ key: "k", topic: "x" }] }));
    await cronTick(deps);
    expect(deps.findTopics).not.toHaveBeenCalled();
    expect(pipe).not.toHaveBeenCalled();
  });

  it("waits an interval when the source has nothing new, without running the pipeline", async () => {
    const { deps, rulesStore, pipe } = setup([autoRule("rule-r", { topicSource: "rss", feeds: ["https://f.test/rss"] })]);
    deps.findTopics = vi.fn(async () => ({ found: [], error: "https://f.test/rss: HTTP 503" }));
    const result = await cronTick(deps);
    expect(result.ran).toEqual([]);
    expect(pipe).not.toHaveBeenCalled();
    const stored = rulesStore.map.get("rule-r") as Rule;
    expect(stored.sourceError).toBe("https://f.test/rss: HTTP 503");
    expect(stored.nextRunAt).toBe(hoursFrom(NOW, 24));
  });

  it("does not refill a list rule with an empty queue", async () => {
    const { deps, pipe } = setup([makeRule("rule-l", { topics: [] })]);
    deps.findTopics = vi.fn(async () => ({ found: [{ key: "k", topic: "x" }] }));
    await cronTick(deps);
    expect(deps.findTopics).not.toHaveBeenCalled();
    expect(pipe).not.toHaveBeenCalled();
  });

  it("Run now fetches topics for an empty automatic rule even before it is due", async () => {
    const { deps, pipe } = setup([autoRule("rule-s", { nextRunAt: hoursFrom(NOW, 5) })]);
    deps.findTopics = vi.fn(async () => ({ found: [{ key: "k1", topic: "Fresh topic" }] }));
    const run = await runRuleManually(deps, "rule-s");
    expect(run?.topic).toBe("Fresh topic");
    expect(pipe).toHaveBeenCalledOnce();
  });

  it("Run now returns null when the source has nothing new", async () => {
    const { deps, pipe } = setup([autoRule("rule-s")]);
    deps.findTopics = vi.fn(async () => ({ found: [] }));
    expect(await runRuleManually(deps, "rule-s")).toBeNull();
    expect(pipe).not.toHaveBeenCalled();
  });
});

describe("internal links on the tick", () => {
  const linkResult = { title: "T", outbound: [], inbound: [], warnings: [], calls: 1, cost: 0.001, tokens: 50 };
  const queuedJob = {
    collection: "posts",
    postId: "p1",
    title: "T",
    status: "queued" as const,
    attempts: 0,
    queuedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };

  it("processes queued link jobs after the rules, inside the same lock", async () => {
    const { deps, kv } = setup([makeRule("rule-a")]);
    const jobs = memoryStore({ "link-posts-p1": queuedJob });
    const runJob = vi.fn(async () => {
      expect(kv.map.has(TICK_LOCK_KEY)).toBe(true);
      return linkResult;
    });
    deps.links = { jobs, listPublished: vi.fn(), runJob };
    const { ran } = await cronTick(deps);
    expect(ran.map((r) => r.source)).toEqual(["rule", "links"]);
    expect(runJob).toHaveBeenCalledOnce();
    expect(jobs.map.get("link-posts-p1")?.status).toBe("done");
  });

  it("leaves link jobs for the next tick when the rules used up the time budget", async () => {
    let t = NOW.getTime();
    const { deps } = setup([makeRule("rule-a")], async (_d, topic) => {
      t += 6 * 60_000;
      return okResult(topic);
    }, () => new Date(t));
    const jobs = memoryStore({ "link-posts-p1": queuedJob });
    const runJob = vi.fn(async () => linkResult);
    deps.links = { jobs, listPublished: vi.fn(), runJob };
    const { ran } = await cronTick(deps);
    expect(ran.map((r) => r.source)).toEqual(["rule"]);
    expect(runJob).not.toHaveBeenCalled();
    expect(jobs.map.get("link-posts-p1")?.status).toBe("queued");
  });
});

describe("no-AI-slop jobs on the tick", () => {
  it("processes queued slop jobs after rules and links, inside the lock", async () => {
    const { deps, kv } = setup([]);
    const slopJobs = memoryStore({
      "slop-posts-p1": {
        collection: "posts",
        postId: "p1",
        title: "T",
        status: "queued" as const,
        attempts: 0,
        queuedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    deps.content = {
      get: vi.fn(async () => {
        expect(kv.map.has(TICK_LOCK_KEY)).toBe(true);
        return { success: false as const, error: { message: "Content item not found" } };
      }),
      update: vi.fn(),
      publish: vi.fn(),
      create: vi.fn(),
    } as unknown as SchedulerDeps["content"];
    deps.slop = { jobs: slopJobs };
    const { ran } = await cronTick(deps);
    expect(ran.map((r) => [r.source, r.status])).toEqual([["slop", "error"]]);
    expect(slopJobs.map.get("slop-posts-p1")?.status).toBe("error");
  });
});

