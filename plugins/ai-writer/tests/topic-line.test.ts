import { describe, expect, it } from "vitest";
import { parseTopicLine } from "../src/lib/topic-line";

const NOW = new Date("2026-09-14T12:00:00.000Z");

describe("parseTopicLine", () => {
  it("leaves plain topics alone", () => {
    expect(parseTopicLine("  Best beaches near Paphos ", NOW)).toEqual({ topic: "Best beaches near Paphos" });
    expect(parseTopicLine("Paphos | a guide", NOW)).toEqual({ topic: "Paphos | a guide" });
  });

  it("backdates with an explicit UTC time", () => {
    expect(parseTopicLine("2026-08-03 18:30 | Best beaches near Paphos", NOW)).toEqual({
      topic: "Best beaches near Paphos",
      publishedAt: "2026-08-03T18:30:00.000Z",
    });
  });

  it("gives date-only lines a stable daytime hour", () => {
    const a = parseTopicLine("2026-08-03 | Best beaches near Paphos", NOW);
    expect(a).toEqual(parseTopicLine("2026-08-03 | Best beaches near Paphos", NOW));
    const hour = new Date(a.publishedAt as string).getUTCHours();
    expect(a.publishedAt?.startsWith("2026-08-03T")).toBe(true);
    expect(hour).toBeGreaterThanOrEqual(7);
    expect(hour).toBeLessThanOrEqual(20);
  });

  it("strips but ignores future and impossible dates", () => {
    expect(parseTopicLine("2026-10-01 | Later", NOW)).toEqual({ topic: "Later" });
    expect(parseTopicLine("2026-02-30 | Bad day", NOW)).toEqual({ topic: "Bad day" });
    expect(parseTopicLine("2026-08-03 25:00 | Bad hour", NOW)).toEqual({ topic: "Bad hour" });
  });
});
