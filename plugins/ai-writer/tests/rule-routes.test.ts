import { describe, expect, it, vi } from "vitest";
import { createRuleHandlers, type RuleRouteDeps } from "../src/lib/rule-routes";
import { createRule, RULE_ID_PATTERN, ruleInputSchema, type Rule } from "../src/lib/rules";
import type { RunRecord, StoredRun } from "../src/lib/runs";
import { RuleBusyError } from "../src/lib/scheduler";
import { memoryStore } from "./helpers";

const NOW = new Date("2026-09-11T12:00:00Z");
const EARLIER = new Date("2026-09-01T08:00:00Z");

function existing(id: string, overrides: Partial<Rule> = {}): Rule {
  return { ...createRule(ruleInputSchema.parse({ name: id, topics: ["a"] }), id, EARLIER), ...overrides };
}

function runRecord(ruleId: string, startedAt: string): RunRecord {
  return { source: "rule", ruleId, topic: "a", status: "ok", warnings: [], calls: 3, startedAt, finishedAt: startedAt };
}

function setup(rules: Rule[] = [], runs: Record<string, RunRecord> = {}) {
  const rulesStore = memoryStore<Rule>(Object.fromEntries(rules.map((r) => [r.id, r])));
  const runsStore = memoryStore<RunRecord>(runs);
  const runRule = vi.fn(
    async (rule: Rule): Promise<StoredRun> => ({ ...runRecord(rule.id, NOW.toISOString()), id: "run-new" }),
  );
  const ensureTick = vi.fn(async () => {});
  const deps: RuleRouteDeps = { rules: rulesStore, runs: runsStore, now: () => NOW, runRule, ensureTick };
  return { h: createRuleHandlers(deps), rulesStore, runRule, ensureTick };
}

describe("rules/save", () => {
  it("creates a rule with defaults, stores it, and registers the tick", async () => {
    const { h, rulesStore, ensureTick } = setup();
    const { rule, warnings } = await h.save({ name: "Tea", topics: ["a", "b"] });
    expect(rule.id).toMatch(RULE_ID_PATTERN);
    expect(rule).toMatchObject({ name: "Tea", topics: ["a", "b"], nextRunAt: NOW.toISOString(), pendingInRun: 0 });
    expect(rulesStore.map.get(rule.id)).toEqual(rule);
    expect(ensureTick).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("requires a feed for an RSS rule", async () => {
    const { h } = setup();
    await expect(h.save({ name: "News", topicSource: "rss" })).rejects.toMatchObject({ code: "invalid_input" });
    const { rule } = await h.save({ name: "News", topicSource: "rss", feeds: ["https://f.test/rss"] });
    expect(rule).toMatchObject({ topicSource: "rss", feeds: ["https://f.test/rss"] });
  });

  it("rejects invalid input", async () => {
    const { h } = setup();
    await expect(h.save({ name: "Tea", intervalHours: 0 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an id that does not exist", async () => {
    const { h } = setup();
    await expect(h.save({ id: "rule-missing", name: "Tea" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("updates an existing rule and keeps its run state", async () => {
    const { h } = setup([existing("rule-a", { pendingInRun: 1 })]);
    const { rule } = await h.save({ id: "rule-a", name: "Renamed", topics: ["z"] });
    expect(rule).toMatchObject({
      id: "rule-a",
      name: "Renamed",
      topics: ["z"],
      pendingInRun: 1,
      createdAt: EARLIER.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("refuses a stale edit and writes nothing", async () => {
    const stored = existing("rule-a", { topics: ["b"], updatedAt: NOW.toISOString() });
    const { h, rulesStore } = setup([stored]);
    await expect(
      h.save({ id: "rule-a", name: "Renamed", topics: ["a", "b"], expectedUpdatedAt: EARLIER.toISOString() }),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "This rule changed after you opened it (a run used a topic, or it was edited elsewhere). Reload the page and try again.",
    });
    expect(rulesStore.map.get("rule-a")).toEqual(stored);
  });

  it("saves an edit whose expectedUpdatedAt matches, without storing it", async () => {
    const { h, rulesStore } = setup([existing("rule-a")]);
    const { rule } = await h.save({ id: "rule-a", name: "Renamed", expectedUpdatedAt: EARLIER.toISOString() });
    expect(rule.name).toBe("Renamed");
    expect(rulesStore.map.get("rule-a")).not.toHaveProperty("expectedUpdatedAt");
    expect(rule).not.toHaveProperty("expectedUpdatedAt");
  });

  it("never stores expectedUpdatedAt on a new rule", async () => {
    const { h, rulesStore } = setup();
    const { rule } = await h.save({ name: "Tea", expectedUpdatedAt: EARLIER.toISOString() });
    expect(rulesStore.map.get(rule.id)).not.toHaveProperty("expectedUpdatedAt");
  });

  it("still saves, with a warning, when the tick cannot be registered", async () => {
    const { h, rulesStore, ensureTick } = setup();
    ensureTick.mockRejectedValueOnce(new Error("cron unavailable"));
    const { rule, warnings } = await h.save({ name: "Tea" });
    expect(rulesStore.map.has(rule.id)).toBe(true);
    expect(warnings).toEqual(["The schedule could not be registered: cron unavailable"]);
  });
});

describe("rules/toggle", () => {
  it("flips only the active flag and keeps the stored queue and run state", async () => {
    const paused = existing("rule-a", { active: false, failStreak: 3, lastError: "boom", topics: ["x", "y"], pendingInRun: 1 });
    const { h, rulesStore, ensureTick } = setup([paused]);
    const { rule, warnings } = await h.toggle({ id: "rule-a", active: true });
    expect(rule).toMatchObject({
      id: "rule-a",
      name: "rule-a",
      active: true,
      failStreak: 0,
      topics: ["x", "y"],
      pendingInRun: 1,
      updatedAt: NOW.toISOString(),
    });
    expect(rule.lastError).toBeUndefined();
    expect(rulesStore.map.get("rule-a")).toEqual(rule);
    expect(ensureTick).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("ends an in-progress run when pausing", async () => {
    const { h, rulesStore } = setup([existing("rule-a", { pendingInRun: 2 })]);
    await h.toggle({ id: "rule-a", active: false });
    expect(rulesStore.map.get("rule-a")).toMatchObject({ active: false, pendingInRun: 0, topics: ["a"] });
  });

  it("reports unknown ids and invalid input", async () => {
    const { h } = setup();
    await expect(h.toggle({ id: "rule-missing", active: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.toggle({ id: "rule-a" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("still toggles, with a warning, when the tick cannot be registered", async () => {
    const { h, rulesStore, ensureTick } = setup([existing("rule-a", { active: false })]);
    ensureTick.mockRejectedValueOnce(new Error("cron unavailable"));
    const { warnings } = await h.toggle({ id: "rule-a", active: true });
    expect((rulesStore.map.get("rule-a") as Rule).active).toBe(true);
    expect(warnings).toEqual(["The schedule could not be registered: cron unavailable"]);
  });
});

describe("rules", () => {
  it("lists rules oldest first", async () => {
    const later = existing("rule-b", { createdAt: NOW.toISOString() });
    const { h } = setup([later, existing("rule-a")]);
    expect((await h.list()).rules.map((r) => r.id)).toEqual(["rule-a", "rule-b"]);
  });
});

describe("rules/delete", () => {
  it("deletes a rule", async () => {
    const { h, rulesStore } = setup([existing("rule-a")]);
    expect(await h.remove({ id: "rule-a" })).toEqual({ ok: true });
    expect(rulesStore.map.has("rule-a")).toBe(false);
  });

  it("reports unknown and malformed ids", async () => {
    const { h } = setup();
    await expect(h.remove({ id: "rule-missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.remove({ id: "../x" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("rules/run", () => {
  it("runs the stored rule once and returns the run", async () => {
    const { h, runRule } = setup([existing("rule-a")]);
    const { run } = await h.run({ id: "rule-a" });
    expect(runRule).toHaveBeenCalledWith(expect.objectContaining({ id: "rule-a", topics: ["a"] }));
    expect(run).toMatchObject({ id: "run-new", ruleId: "rule-a", status: "ok" });
  });

  it("reports busy while a scheduled run holds the lock", async () => {
    const { h, runRule } = setup([existing("rule-a")]);
    runRule.mockRejectedValueOnce(new RuleBusyError());
    await expect(h.run({ id: "rule-a" })).rejects.toMatchObject({
      code: "busy",
      message: "A scheduled run is in progress. Try again in a few minutes.",
    });
  });

  it("reports an empty queue when a tick used the last topic first", async () => {
    const { h, runRule } = setup([existing("rule-a")]);
    runRule.mockResolvedValueOnce(null);
    await expect(h.run({ id: "rule-a" })).rejects.toMatchObject({ code: "empty_queue" });
  });

  it("lets an automatic rule with an empty queue fetch topics, and explains when none were found", async () => {
    const { h, runRule } = setup([existing("rule-auto", { topics: [], topicSource: "rss", feeds: ["https://cyprus.test/feed"] })]);
    runRule.mockResolvedValueOnce(null);
    await expect(h.run({ id: "rule-auto" })).rejects.toMatchObject({
      code: "empty_queue",
      message: "No new topics were found for this rule",
    });
    expect(runRule).toHaveBeenCalledOnce();
  });

  it("refuses unknown rules and empty queues", async () => {
    const { h, runRule } = setup([existing("rule-empty", { topics: [] })]);
    await expect(h.run({ id: "rule-missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.run({ id: "rule-empty" })).rejects.toMatchObject({ code: "empty_queue" });
    expect(runRule).not.toHaveBeenCalled();
  });
});

describe("runs", () => {
  const runs = {
    "run-1": runRecord("rule-a", "2026-09-11T10:00:00.000Z"),
    "run-2": runRecord("rule-b", "2026-09-11T11:00:00.000Z"),
    "run-3": runRecord("rule-a", "2026-09-11T12:00:00.000Z"),
  };

  it("returns runs newest first, filtered by rule, with a coerced limit", async () => {
    const { h } = setup([], runs);
    expect((await h.runs({})).runs.map((r) => r.id)).toEqual(["run-3", "run-2", "run-1"]);
    expect((await h.runs({ ruleId: "rule-a" })).runs.map((r) => r.id)).toEqual(["run-3", "run-1"]);
    expect((await h.runs({ limit: "1" })).runs.map((r) => r.id)).toEqual(["run-3"]);
  });

  it("rejects an out-of-range limit", async () => {
    const { h } = setup([], runs);
    await expect(h.runs({ limit: "0" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.runs({ limit: "51" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("rules/tick", () => {
  it("runs a scheduler tick and returns its runs", async () => {
    const ran: StoredRun[] = [{ ...runRecord("rule-a", NOW.toISOString()), id: "run-1" }];
    const rulesStore = memoryStore<Rule>();
    const h = createRuleHandlers({
      rules: rulesStore,
      runs: memoryStore<RunRecord>(),
      runRule: vi.fn(),
      tick: async () => ({ locked: false, ran }),
    });
    expect(await h.tick()).toEqual({ ran });
  });

  it("reports busy while another tick holds the lock", async () => {
    const h = createRuleHandlers({
      rules: memoryStore<Rule>(),
      runs: memoryStore<RunRecord>(),
      runRule: vi.fn(),
      tick: async () => ({ locked: true, ran: [] }),
    });
    await expect(h.tick()).rejects.toMatchObject({ code: "busy" });
  });
});
