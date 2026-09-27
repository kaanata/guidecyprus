import { describe, expect, it } from "vitest";
import {
  emptyRuleForm,
  formatWhen,
  formFromRule,
  ruleInputFromForm,
  ruleStatus,
  topicCount,
} from "../src/admin/rules-state";
import { createRule, ruleInputSchema, ruleOptionsSchema, type Rule } from "../src/lib/rules";

const NOW = new Date("2026-09-11T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function rule(overrides: Partial<Rule> = {}): Rule {
  const config = ruleInputSchema.parse({
    name: "Tea",
    topics: ["a", "b"],
    intervalHours: 6,
    postsPerRun: 2,
    options: { sections: 4, status: "published", models: { title: "m/t" } },
  });
  return { ...createRule(config, "rule-t1", NOW), ...overrides };
}

describe("rule form", () => {
  it("starts empty with schema defaults", () => {
    expect(emptyRuleForm()).toEqual({
      name: "",
      topicMode: "topic",
      topicSource: "list",
      topicsText: "",
      feedsText: "",
      intervalHours: 24,
      postsPerRun: 1,
      active: true,
      options: ruleOptionsSchema.parse({}),
    });
  });

  it("round-trips a rule through the form, carrying its updatedAt for the conflict check", () => {
    const r = rule({ updatedAt: at(5_000) });
    const { expectedUpdatedAt, ...fields } = ruleInputFromForm(formFromRule(r));
    expect(expectedUpdatedAt).toBe(r.updatedAt);
    const input = ruleInputSchema.parse(fields);
    expect(input).toMatchObject({
      id: "rule-t1",
      name: "Tea",
      topics: ["a", "b"],
      intervalHours: 6,
      postsPerRun: 2,
      active: true,
      options: r.options,
    });
  });

  it("omits the id for a new rule, trims the name and cleans topics via the schema", () => {
    const input = ruleInputFromForm({ ...emptyRuleForm(), name: "  New  ", topicsText: "x\n\n X \ny" });
    expect(input.id).toBeUndefined();
    expect(input.expectedUpdatedAt).toBeUndefined();
    expect(input.name).toBe("New");
    expect(ruleInputSchema.parse(input).topics).toEqual(["x", "y"]);
  });

  it("round-trips an RSS rule's feeds and fills options missing from older stored rules", () => {
    const legacyOptions = { ...rule().options } as Record<string, unknown>;
    delete legacyOptions.instructions;
    delete legacyOptions.byline;
    const r = rule({
      topicSource: "rss",
      feeds: ["https://a.test/rss", "https://b.test/rss"],
      options: legacyOptions as Rule["options"],
    });
    const form = formFromRule(r);
    expect(form.feedsText).toBe("https://a.test/rss\nhttps://b.test/rss");
    expect(form.options).toMatchObject({ instructions: "", byline: "" });
    const input = ruleInputFromForm({ ...form, feedsText: " https://a.test/rss \n\n" });
    expect(input).toMatchObject({ topicSource: "rss", feeds: ["https://a.test/rss"] });
  });

  it("opens a rule stored with the retired sports schedule as a typed list, in English, and saves cleanly", () => {
    const legacyOptions = { ...rule().options, language: "Turkish" } as Record<string, unknown>;
    delete legacyOptions.locale;
    const legacy = { ...rule(), topicSource: "sports", sportsMix: "all", options: legacyOptions } as unknown as Rule;
    const form = formFromRule(legacy);
    expect(form.topicSource).toBe("list");
    expect(form.options.locale).toBe("en");
    const parsed = ruleInputSchema.parse(ruleInputFromForm(form));
    expect(parsed.topicSource).toBe("list");
    expect(parsed).not.toHaveProperty("sportsMix");
    expect(parsed.options).not.toHaveProperty("language");
  });

  it("keeps a Turkish rule's locale through the form", () => {
    const r = rule({ options: { ...rule().options, locale: "tr" } });
    expect(ruleInputSchema.parse(ruleInputFromForm(formFromRule(r))).options.locale).toBe("tr");
  });

  it("describes an empty automatic rule as waiting rather than empty", () => {
    expect(ruleStatus(rule({ topics: [], topicSource: "rss" }))).toBe("Waiting for new topics");
    expect(ruleStatus(rule({ topics: [] }))).toBe("Queue empty");
  });

  it("does not share option objects with the source rule", () => {
    const r = rule();
    const form = formFromRule(r);
    form.options.models.title = "changed";
    expect(r.options.models.title).toBe("m/t");
  });

  it("counts unique non-blank topics", () => {
    expect(topicCount("a\n\nA\nb\n  ")).toBe(2);
    expect(topicCount("")).toBe(0);
  });
});

describe("formatWhen", () => {
  it.each([
    [undefined, "—"],
    [at(30_000), "now"],
    [at(-30_000), "just now"],
    [at(-5 * 60_000), "5m ago"],
    [at(90 * 60_000), "in 2h"],
    [at(3 * 86_400_000), "in 3d"],
  ])("%s → %s", (iso, expected) => {
    expect(formatWhen(iso, NOW)).toBe(expected);
  });
});

describe("ruleStatus", () => {
  it("describes paused, empty, running and scheduled rules", () => {
    expect(ruleStatus(rule({ active: false, failStreak: 3 }))).toBe("Paused after 3 failures");
    expect(ruleStatus(rule({ active: false }))).toBe("Paused");
    expect(ruleStatus(rule({ topics: [] }))).toBe("Queue empty");
    expect(ruleStatus(rule({ pendingInRun: 2 }))).toBe("Running (2 left)");
    expect(ruleStatus(rule())).toBe("Scheduled");
  });
});
