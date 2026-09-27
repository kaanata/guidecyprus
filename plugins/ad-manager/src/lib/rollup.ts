import type { DailyStat, EventRecord } from "./types";

export function statId(adId: string, day: string): string {
  return `${adId}:${day}`;
}

/** Sum append-only event records onto existing daily totals. Pure: returns new objects. */
export function rollupEvents(
  events: Array<{ id: string; data: EventRecord }>,
  existing: Map<string, DailyStat>,
): { stats: Array<{ id: string; data: DailyStat }>; processedIds: string[] } {
  const merged = new Map<string, DailyStat>();
  for (const { data } of events) {
    for (const [adId, counts] of Object.entries(data.counts)) {
      const id = statId(adId, data.day);
      const current = merged.get(id) ?? { ...(existing.get(id) ?? { adId, day: data.day, impressions: 0, clicks: 0 }) };
      current.impressions += counts.impressions;
      current.clicks += counts.clicks;
      merged.set(id, current);
    }
  }
  return {
    stats: Array.from(merged, ([id, data]) => ({ id, data })),
    processedIds: events.map((event) => event.id),
  };
}
