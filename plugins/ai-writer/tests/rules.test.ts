import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  applyRefill,
  beginRun,
  createRule,
  isDue,
  MAX_SOURCE_SEEN,
  needsRefill,
  newRuleId,
  pickDueRules,
  pipelineOptionsFor,
  RULE_ID_PATTERN,
  ruleConfigProblem,
  ruleInputSchema,
  setRuleActive,
  topicSourceOf,
  updateRule,
  type Rule,
} from "../src/lib/rules";

const NOW = new Date("2026-09-11T12:00:00Z");
const hoursFrom = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000).toISOString();

function rule(overrides: Partial<Rule> = {}): Rule {
  const base = createRule(ruleInputSchema.parse({ name: "Tea", topics: ["a", "b", "c"] }), "rule-t1", NOW);
  return { ...base, ...overrides };
}

describe("ruleInputSchema", () => {
  it("fills defaults", () => {
    const r = ruleInputSchema.parse({ name: "Tea" });
    expect(r).toMatchObject({
      name: "Tea",
      mode: "article",
      topicMode: "topic",
      topics: [],
      intervalHours: 24,
      postsPerRun: 1,
      active: true,
      topicSource: "list",
      feeds: [],
    });
    expect(r.options).toEqual({
      sections: 5,
      headingLevel: "h2",
      paragraphsPerSection: 2,
      intro: true,
      outro: true,
      outroHeader: "",
      toc: false,
      faq: false,
      featuredImage: true,
      collection: "posts",
      status: "draft",
      categories: [],
      tags: [],
      autoTags: false,
      locale: "en",
      style: "",
      tone: "",
      models: {},
      instructions: "",
      byline: "",
    });
  });

  it.each([
    ["intervalHours below 1", { intervalHours: 0 }],
    ["intervalHours above 168", { intervalHours: 169 }],
    ["postsPerRun above 5", { postsPerRun: 6 }],
    ["sections below 2", { options: { sections: 1 } }],
    ["sections above 12", { options: { sections: 13 } }],
    ["paragraphs above 6", { options: { paragraphsPerSection: 7 } }],
    ["unknown status", { options: { status: "scheduled" } }],
    ["bad collection", { options: { collection: "Posts" } }],
    ["unknown locale", { options: { locale: "de" } }],
    ["the retired sports source", { topicSource: "sports" }],
    ["unknown model slot", { options: { models: { banner: "x/y" } } }],
    ["bad id", { id: "../etc" }],
    ["blank name", { name: "  " }],
  ])("rejects %s", (_label, patch) => {
    expect(ruleInputSchema.safeParse({ name: "Tea", ...patch }).success).toBe(false);
  });

  it("trims topics, drops blanks and case-insensitive duplicates", () => {
    expect(ruleInputSchema.parse({ name: "Tea", topics: ["  Green tea ", "", "green TEA", "Oolong"] }).topics).toEqual([
      "Green tea",
      "Oolong",
    ]);
  });

  it("accepts blank per-slot models (meaning: use Settings)", () => {
    expect(ruleInputSchema.parse({ name: "Tea", options: { models: { title: "", image: "img/x" } } }).options.models).toEqual({
      title: "",
      image: "img/x",
    });
  });
});

describe("newRuleId", () => {
  it("matches the rule id pattern", () => {
    expect(newRuleId(NOW, () => 0.5)).toMatch(RULE_ID_PATTERN);
  });
});

describe("createRule", () => {
  it("starts due now with an empty run state", () => {
    const r = createRule(ruleInputSchema.parse({ id: "rule-ignored", name: "Tea", topics: ["a"] }), "rule-new", NOW);
    expect(r).toMatchObject({
      id: "rule-new",
      nextRunAt: NOW.toISOString(),
      pendingInRun: 0,
      failStreak: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(r.lastRunAt).toBeUndefined();
  });
});

describe("updateRule", () => {
  const later = new Date(NOW.getTime() + 60_000);

  it("keeps the schedule and run state while applying edits", () => {
    const existing = rule({ pendingInRun: 1, nextRunAt: hoursFrom(NOW, 5) });
    const next = updateRule(existing, ruleInputSchema.parse({ name: "Renamed", topics: ["x"] }), later);
    expect(next).toMatchObject({
      id: "rule-t1",
      name: "Renamed",
      topics: ["x"],
      pendingInRun: 1,
      nextRunAt: hoursFrom(NOW, 5),
      createdAt: NOW.toISOString(),
      updatedAt: later.toISOString(),
    });
  });

  it("clears the failure streak when a paused rule is re-activated", () => {
    const paused = rule({ active: false, failStreak: 3, lastError: "boom" });
    const next = updateRule(paused, ruleInputSchema.parse({ name: "Tea", active: true }), later);
    expect(next.failStreak).toBe(0);
    expect(next.lastError).toBeUndefined();
  });

  it("ends an in-progress run when the rule is deactivated", () => {
    const next = updateRule(rule({ pendingInRun: 2 }), ruleInputSchema.parse({ name: "Tea", active: false }), later);
    expect(next.pendingInRun).toBe(0);
  });

  it("ends an in-progress run when the queue is cleared", () => {
    const next = updateRule(rule({ pendingInRun: 2 }), ruleInputSchema.parse({ name: "Tea", topics: [] }), later);
    expect(next.pendingInRun).toBe(0);
  });

  it("caps an in-progress run at a lowered postsPerRun", () => {
    const existing = rule({ postsPerRun: 5, pendingInRun: 4 });
    const next = updateRule(existing, ruleInputSchema.parse({ name: "Tea", topics: ["a"], postsPerRun: 2 }), later);
    expect(next.pendingInRun).toBe(2);
  });

  it("recomputes nextRunAt from lastRunAt when the interval changes", () => {
    const existing = rule({ lastRunAt: NOW.toISOString(), nextRunAt: hoursFrom(NOW, 24) });
    const next = updateRule(existing, ruleInputSchema.parse({ name: "Tea", intervalHours: 6 }), later);
    expect(next.nextRunAt).toBe(hoursFrom(NOW, 6));
  });
});

describe("setRuleActive", () => {
  const later = new Date(NOW.getTime() + 60_000);

  it("re-activation clears the failure streak and keeps everything else", () => {
    const paused = rule({ active: false, failStreak: 3, lastError: "boom", topics: ["x", "y"], pendingInRun: 1 });
    const next = setRuleActive(paused, true, later);
    expect(next).toMatchObject({
      active: true,
      failStreak: 0,
      topics: ["x", "y"],
      pendingInRun: 1,
      nextRunAt: paused.nextRunAt,
      updatedAt: later.toISOString(),
    });
    expect(next.lastError).toBeUndefined();
  });

  it("deactivation ends an in-progress run", () => {
    const next = setRuleActive(rule({ pendingInRun: 2 }), false, later);
    expect(next).toMatchObject({ active: false, pendingInRun: 0, topics: ["a", "b", "c"] });
  });

  it("keeps the failure streak when an active rule stays active", () => {
    const next = setRuleActive(rule({ failStreak: 1, lastError: "boom" }), true, later);
    expect(next).toMatchObject({ active: true, failStreak: 1, lastError: "boom" });
  });
});

describe("isDue", () => {
  it("is false for inactive rules and empty queues", () => {
    expect(isDue(rule({ active: false }), NOW)).toBe(false);
    expect(isDue(rule({ topics: [] }), NOW)).toBe(false);
  });

  it("is true when nextRunAt has passed or a run is in progress", () => {
    expect(isDue(rule({ nextRunAt: hoursFrom(NOW, -1) }), NOW)).toBe(true);
    expect(isDue(rule({ nextRunAt: hoursFrom(NOW, 1) }), NOW)).toBe(false);
    expect(isDue(rule({ nextRunAt: hoursFrom(NOW, 1), pendingInRun: 1 }), NOW)).toBe(true);
  });
});

describe("pickDueRules", () => {
  it("returns in-progress rules first, then the longest overdue, up to the limit", () => {
    const old = rule({ id: "rule-old", nextRunAt: hoursFrom(NOW, -10) });
    const recent = rule({ id: "rule-recent", nextRunAt: hoursFrom(NOW, -1) });
    const running = rule({ id: "rule-running", nextRunAt: hoursFrom(NOW, 3), pendingInRun: 1 });
    const future = rule({ id: "rule-future", nextRunAt: hoursFrom(NOW, 3) });
    expect(pickDueRules([recent, future, old, running], NOW, 2).map((r) => r.id)).toEqual(["rule-running", "rule-old"]);
  });
});

describe("beginRun", () => {
  it("starts a run of postsPerRun posts only when none is in progress", () => {
    expect(beginRun(rule({ postsPerRun: 3 })).pendingInRun).toBe(3);
    const running = rule({ postsPerRun: 3, pendingInRun: 1 });
    expect(beginRun(running)).toBe(running);
  });
});

describe("applyOutcome", () => {
  it("ok: consumes the topic and finishes a one-post run", () => {
    const next = applyOutcome(rule({ pendingInRun: 1, failStreak: 2, lastError: "x" }), "a", { kind: "ok" }, NOW);
    expect(next).toMatchObject({
      topics: ["b", "c"],
      pendingInRun: 0,
      failStreak: 0,
      lastRunAt: NOW.toISOString(),
      nextRunAt: hoursFrom(NOW, 24),
    });
    expect(next.lastError).toBeUndefined();
  });

  it("ok: spreads a multi-post run across ticks without rescheduling", () => {
    const next = applyOutcome(rule({ postsPerRun: 3, pendingInRun: 3 }), "a", { kind: "ok" }, NOW);
    expect(next.pendingInRun).toBe(2);
    expect(next.nextRunAt).toBe(NOW.toISOString());
    expect(next.lastRunAt).toBeUndefined();
  });

  it("ok: finishes the run when the queue empties", () => {
    const next = applyOutcome(rule({ topics: ["a"], pendingInRun: 3 }), "a", { kind: "ok" }, NOW);
    expect(next).toMatchObject({ topics: [], pendingInRun: 0, nextRunAt: hoursFrom(NOW, 24) });
  });

  it("skipped: consumes the topic without using up the run", () => {
    const next = applyOutcome(rule({ pendingInRun: 1 }), "a", { kind: "skipped" }, NOW);
    expect(next.topics).toEqual(["b", "c"]);
    expect(next.pendingInRun).toBe(1);
  });

  it("error: keeps the topic and counts the failure", () => {
    const next = applyOutcome(rule({ pendingInRun: 1 }), "a", { kind: "error", message: "boom" }, NOW);
    expect(next).toMatchObject({ topics: ["a", "b", "c"], failStreak: 1, lastError: "boom", active: true, pendingInRun: 1 });
  });

  it("error: deactivates the rule on the third consecutive failure", () => {
    const next = applyOutcome(rule({ pendingInRun: 1, failStreak: 2 }), "a", { kind: "error", message: "boom" }, NOW);
    expect(next).toMatchObject({ active: false, failStreak: 3, pendingInRun: 0 });
  });

  it("error: truncates long messages to 500 characters", () => {
    const next = applyOutcome(rule(), "a", { kind: "error", message: "x".repeat(900) }, NOW);
    expect(next.lastError).toHaveLength(500);
  });

  it("removes the topic by value when the queue changed during the run", () => {
    const next = applyOutcome(rule({ topics: ["new", "a", "b"], pendingInRun: 2 }), "a", { kind: "ok" }, NOW);
    expect(next.topics).toEqual(["new", "b"]);
  });

  it("manual ok: consumes the topic but leaves the schedule and run counter alone", () => {
    const r = rule({ nextRunAt: hoursFrom(NOW, 5), failStreak: 1, lastError: "old" });
    const next = applyOutcome(r, "a", { kind: "ok" }, NOW, true);
    expect(next).toMatchObject({ topics: ["b", "c"], pendingInRun: 0, nextRunAt: hoursFrom(NOW, 5), failStreak: 0 });
    expect(next.lastRunAt).toBeUndefined();
    expect(next.lastError).toBeUndefined();
  });

  it("manual error: records the error without counting it", () => {
    const next = applyOutcome(rule({ failStreak: 2 }), "a", { kind: "error", message: "boom" }, NOW, true);
    expect(next).toMatchObject({ failStreak: 2, active: true, lastError: "boom", topics: ["a", "b", "c"] });
  });
});

describe("pipelineOptionsFor", () => {
  it("maps rule options onto pipeline options", () => {
    const r = rule({
      topicMode: "title",
      options: {
        ...rule().options,
        sections: 7,
        status: "published",
        locale: "tr",
        models: { section: "m/s" },
      },
    });
    expect(pipelineOptionsFor(r)).toMatchObject({
      mode: "article",
      topicMode: "title",
      sections: 7,
      paragraphsPerSection: 2,
      status: "published",
      collection: "posts",
      locale: "tr",
      params: { style: "", tone: "" },
      models: { section: "m/s" },
    });
  });

  it("writes rules stored before locales existed in English", () => {
    const { locale: _dropped, ...options } = rule().options;
    const legacy = { ...rule(), options: { ...options, language: "Turkish" } } as unknown as Rule;
    expect(pipelineOptionsFor(legacy).locale).toBe("en");
  });
});

describe("topic sources", () => {
  const base = (overrides: Partial<Rule> = {}): Rule => ({
    ...createRule(
      ruleInputSchema.parse({ name: "Auto", topicSource: "rss", feeds: ["https://cyprus-news.test/feed"] }),
      "rule-auto",
      NOW,
    ),
    ...overrides,
  });

  it("treats rules stored before topic sources as typed lists", () => {
    const legacy = { ...base(), topicSource: undefined } as unknown as Rule;
    expect(topicSourceOf(legacy)).toBe("list");
    expect(needsRefill(legacy, NOW)).toBe(false);
  });

  it("loads rules stored with the retired sports schedule as typed lists", () => {
    const legacy = { ...base(), topicSource: "sports", sportsMix: "analysis" } as unknown as Rule;
    expect(topicSourceOf(legacy)).toBe("list");
    expect(needsRefill(legacy, NOW)).toBe(false);
  });

  it("requires at least one feed for the RSS source and https feed URLs", () => {
    expect(ruleConfigProblem(ruleInputSchema.parse({ name: "R", topicSource: "rss" }))).toMatch(/feed/);
    expect(
      ruleConfigProblem(ruleInputSchema.parse({ name: "R", topicSource: "rss", feeds: ["https://x.test/feed"] })),
    ).toBeNull();
    expect(ruleInputSchema.safeParse({ name: "R", feeds: ["http://x.test/feed"] }).success).toBe(false);
  });

  it("refills only active automatic rules whose queue is empty and whose time has come", () => {
    expect(needsRefill(base(), NOW)).toBe(true);
    expect(needsRefill(base({ active: false }), NOW)).toBe(false);
    expect(needsRefill(base({ topics: ["left"] }), NOW)).toBe(false);
    expect(needsRefill(base({ pendingInRun: 1 }), NOW)).toBe(false);
    expect(needsRefill(base({ nextRunAt: new Date(NOW.getTime() + 60_000).toISOString() }), NOW)).toBe(false);
    expect(needsRefill(base({ topicSource: "list" }), NOW)).toBe(false);
  });

  it("queues found topics, remembers their keys and records a source error", () => {
    const next = applyRefill(base(), [{ key: "k1", topic: "One" }, { key: "k2", topic: "one" }], NOW, "feed down");
    expect(next.topics).toEqual(["One"]);
    expect(next.sourceSeen).toEqual(["k1", "k2"]);
    expect(next.sourceError).toBe("feed down");
    expect(next.lastError).toBeUndefined();
    expect(next.nextRunAt).toBe(base().nextRunAt);
    expect(applyRefill(next, [], NOW).sourceError).toBeUndefined();
  });

  it("waits a full interval when nothing new was found", () => {
    const next = applyRefill(base({ intervalHours: 6 }), [], NOW);
    expect(next.topics).toEqual([]);
    expect(next.nextRunAt).toBe(new Date(NOW.getTime() + 6 * 3_600_000).toISOString());
  });

  it("keeps only the most recent remembered keys", () => {
    const seen = Array.from({ length: MAX_SOURCE_SEEN }, (_, i) => `old-${i}`);
    const next = applyRefill(base({ sourceSeen: seen }), [{ key: "new", topic: "New" }], NOW);
    expect(next.sourceSeen).toHaveLength(MAX_SOURCE_SEEN);
    expect(next.sourceSeen?.at(-1)).toBe("new");
    expect(next.sourceSeen?.[0]).toBe("old-1");
  });

  it("passes instructions and byline to the pipeline", () => {
    const rule = createRule(
      ruleInputSchema.parse({ name: "R", options: { instructions: "Be brief.", byline: "editorial" } }),
      "rule-x",
      NOW,
    );
    expect(pipelineOptionsFor(rule)).toMatchObject({ instructions: "Be brief.", byline: "editorial" });
  });
});
