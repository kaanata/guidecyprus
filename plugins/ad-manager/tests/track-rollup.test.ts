import { rollupEvents, statId } from "../src/lib/rollup";
import { aggregateEvents, toEventRecord, utcDay } from "../src/lib/track";

describe("track helpers", () => {
  it("formats UTC days", () => {
    expect(utcDay(new Date("2026-09-12T23:59:59.000Z"))).toBe("2026-09-12");
  });

  it("counts impressions and clicks per active ad and drops others", () => {
    const counts = aggregateEvents(
      [
        { adId: "a", space: "in-feed", type: "impression" },
        { adId: "a", space: "in-feed", type: "impression" },
        { adId: "a", space: "in-feed", type: "click" },
        { adId: "gone", space: "in-feed", type: "impression" },
      ],
      new Set(["a"]),
    );
    expect(counts).toEqual({ a: { impressions: 2, clicks: 1 } });
  });

  it("builds an event record, or null when there is nothing to store", () => {
    const now = new Date("2026-09-12T08:00:00.000Z");
    expect(toEventRecord({}, now)).toBeNull();
    expect(toEventRecord({ a: { impressions: 1, clicks: 0 } }, now)).toEqual({
      createdAt: "2026-09-12T08:00:00.000Z",
      day: "2026-09-12",
      counts: { a: { impressions: 1, clicks: 0 } },
    });
  });
});

describe("rollupEvents", () => {
  const event = (id: string, day: string, counts: Record<string, { impressions: number; clicks: number }>) => ({
    id,
    data: { createdAt: `${day}T10:00:00.000Z`, day, counts },
  });

  it("adds event counts onto existing daily totals", () => {
    const existing = new Map([[statId("a", "2026-09-12"), { adId: "a", day: "2026-09-12", impressions: 10, clicks: 1 }]]);
    const result = rollupEvents(
      [event("e1", "2026-09-12", { a: { impressions: 5, clicks: 2 } }), event("e2", "2026-09-12", { a: { impressions: 1, clicks: 0 } })],
      existing,
    );
    expect(result.stats).toEqual([
      { id: "a:2026-09-12", data: { adId: "a", day: "2026-09-12", impressions: 16, clicks: 3 } },
    ]);
    expect(result.processedIds).toEqual(["e1", "e2"]);
  });

  it("keeps days and ads separate", () => {
    const result = rollupEvents(
      [
        event("e1", "2026-09-11", { a: { impressions: 1, clicks: 0 }, b: { impressions: 2, clicks: 1 } }),
        event("e2", "2026-09-12", { a: { impressions: 3, clicks: 0 } }),
      ],
      new Map(),
    );
    const byId = Object.fromEntries(result.stats.map((s) => [s.id, s.data]));
    expect(byId["a:2026-09-11"]).toMatchObject({ impressions: 1, clicks: 0 });
    expect(byId["b:2026-09-11"]).toMatchObject({ impressions: 2, clicks: 1 });
    expect(byId["a:2026-09-12"]).toMatchObject({ impressions: 3, clicks: 0 });
  });

  it("does not mutate the existing totals map", () => {
    const stat = { adId: "a", day: "2026-09-12", impressions: 1, clicks: 0 };
    rollupEvents([event("e1", "2026-09-12", { a: { impressions: 1, clicks: 0 } })], new Map([["a:2026-09-12", stat]]));
    expect(stat.impressions).toBe(1);
  });
});
