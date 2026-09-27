export const AD_SPACE_IDS = ["top-banner", "in-feed", "article-sidebar", "in-article"] as const;
export type AdSpaceId = (typeof AD_SPACE_IDS)[number];

export const PAGE_TYPES = ["home", "latest", "competition", "article", "tag", "search", "page"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export interface Size {
  width: number;
  height: number;
}

export interface AdSpace {
  id: AdSpaceId;
  label: string;
  description: string;
  /** Box the theme reserves so the page doesn't jump when an ad loads. */
  reserve: { desktop: Size; mobile: Size | null };
  /** Creative sizes allowed for the main image or code ad. */
  accepts: Size[];
  /** Sizes allowed for the optional phone image (top banner only). */
  acceptsMobile: Size[];
}

export const AD_SPACES: Record<AdSpaceId, AdSpace> = {
  "top-banner": {
    id: "top-banner",
    label: "Top banner",
    description: "Under the competition chips on every page",
    reserve: { desktop: { width: 970, height: 90 }, mobile: { width: 320, height: 100 } },
    accepts: [
      { width: 970, height: 90 },
      { width: 728, height: 90 },
    ],
    acceptsMobile: [
      { width: 320, height: 100 },
      { width: 320, height: 50 },
    ],
  },
  "in-feed": {
    id: "in-feed",
    label: "In-feed",
    description: "Between Top stories and Latest, and every 6 cards in lists",
    reserve: { desktop: { width: 300, height: 250 }, mobile: { width: 300, height: 250 } },
    accepts: [{ width: 300, height: 250 }],
    acceptsMobile: [],
  },
  "article-sidebar": {
    id: "article-sidebar",
    label: "Article sidebar",
    description: "Top of the article's right-hand gutter (desktop only)",
    reserve: { desktop: { width: 300, height: 600 }, mobile: null },
    accepts: [
      { width: 300, height: 600 },
      { width: 300, height: 250 },
    ],
    acceptsMobile: [],
  },
  "in-article": {
    id: "in-article",
    label: "In-article",
    description: "Inside the article after the 2nd paragraph",
    reserve: { desktop: { width: 300, height: 250 }, mobile: { width: 300, height: 250 } },
    accepts: [{ width: 300, height: 250 }],
    acceptsMobile: [],
  },
};

export function isAcceptedSize(space: AdSpaceId, size: Size, which: "main" | "mobile"): boolean {
  const list = which === "main" ? AD_SPACES[space].accepts : AD_SPACES[space].acceptsMobile;
  return list.some((s) => s.width === size.width && s.height === size.height);
}
