import { describe, expect, it, vi } from "vitest";
import { createRule, ruleInputSchema, type Rule } from "../src/lib/rules";
import { findTopics } from "../src/lib/topic-sources";

const NOW = new Date("2026-09-14T06:00:00Z");
const rule = (input: Record<string, unknown>, overrides: Partial<Rule> = {}): Rule => ({
  ...createRule(ruleInputSchema.parse({ name: "R", ...input }), "rule-r", NOW),
  ...overrides,
});

describe("findTopics", () => {
  it("returns unseen feed items capped at postsPerRun, keyed by URL, with feed errors", async () => {
    const xml = `<rss><channel>
      <item><title>Kyrenia harbour reopens</title><link>https://n.test/a</link></item>
      <item><title>New hiking trail in the Troodos</title><link>https://n.test/b</link></item>
      <item><title>Larnaca salt lake flamingos return</title><link>https://n.test/c</link></item>
    </channel></rss>`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("broken") ? new Response("", { status: 404 }) : new Response(xml),
    ) as unknown as typeof fetch;
    const out = await findTopics(
      rule(
        { topicSource: "rss", feeds: ["https://n.test/rss", "https://broken.test/rss"], postsPerRun: 2 },
        { sourceSeen: ["https://n.test/a"] },
      ),
      { now: NOW, fetchImpl },
    );
    expect(out.found).toEqual([
      { key: "https://n.test/b", topic: "New hiking trail in the Troodos" },
      { key: "https://n.test/c", topic: "Larnaca salt lake flamingos return" },
    ]);
    expect(out.error).toBe("https://broken.test/rss: HTTP 404");
  });

  it("finds nothing for a typed list", async () => {
    expect(await findTopics(rule({ topics: ["x"] }), { now: NOW })).toEqual({ found: [] });
  });

  it("finds nothing for a rule stored with the retired sports schedule", async () => {
    const legacy = { ...rule({ topics: [] }), topicSource: "sports" } as unknown as Rule;
    expect(await findTopics(legacy, { now: NOW })).toEqual({ found: [] });
  });
});
