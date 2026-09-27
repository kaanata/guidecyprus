import type { AdSpaceId, PageType } from "../spaces";

export interface MediaRef {
  mediaId: string;
  url: string;
  width: number;
  height: number;
}

export interface Ad {
  name: string;
  advertiser?: string;
  kind: "banner" | "code";
  space: AdSpaceId;
  status: "active" | "paused";
  weight: number;
  startsAt?: string;
  endsAt?: string;
  /** Empty lists mean "everywhere". `countries` is missing on ads saved before country targeting. */
  targeting: { pageTypes: PageType[]; competitions: string[]; countries?: string[] };
  disclosure?: string;
  banner?: { image: MediaRef; mobileImage?: MediaRef; href: string; alt: string };
  code?: { html: string };
  createdAt: string;
  updatedAt: string;
}

export type StoredAd = Ad & { id: string };

export interface PageContext {
  type: PageType;
  competition?: string;
}

interface CreativeImage {
  url: string;
  width: number;
  height: number;
}

export type Creative =
  | {
      adId: string;
      kind: "banner";
      width: number;
      height: number;
      href: string;
      alt: string;
      image: CreativeImage;
      mobileImage?: CreativeImage;
      disclosure?: string;
    }
  | { adId: string; kind: "code"; width: number; height: number; html: string; disclosure?: string };

export interface EventCounts {
  impressions: number;
  clicks: number;
}

export interface EventRecord {
  createdAt: string;
  day: string;
  counts: Record<string, EventCounts>;
}

export interface DailyStat {
  adId: string;
  day: string;
  impressions: number;
  clicks: number;
}

export interface AdListItem extends StoredAd {
  last7: EventCounts;
}

export interface StatsRow {
  adId: string;
  name: string;
  space: AdSpaceId | null;
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface StatsSummary {
  days: number;
  rows: StatsRow[];
  daily: Record<string, Array<{ day: string } & EventCounts>>;
  lastRollupAt: string | null;
}
