import type { TrackEvent } from "./schema";
import type { EventCounts, EventRecord } from "./types";

export const DAY_MS = 86_400_000;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function aggregateEvents(events: TrackEvent[], activeIds: Set<string>): Record<string, EventCounts> {
  const counts: Record<string, EventCounts> = {};
  for (const event of events) {
    if (!activeIds.has(event.adId)) continue;
    const entry = (counts[event.adId] ??= { impressions: 0, clicks: 0 });
    if (event.type === "impression") entry.impressions += 1;
    else entry.clicks += 1;
  }
  return counts;
}

export function toEventRecord(counts: Record<string, EventCounts>, now: Date): EventRecord | null {
  if (Object.keys(counts).length === 0) return null;
  return { createdAt: now.toISOString(), day: utcDay(now), counts };
}
