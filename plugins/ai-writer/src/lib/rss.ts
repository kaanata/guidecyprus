import { XMLParser } from "fast-xml-parser";

// RSS 2.0 and Atom feed reader for the "RSS feeds" rule topic source.

export type FeedItem = { url: string; title: string };
export type FeedError = { feed: string; message: string };

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TITLE = 300;

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  // Parsed elements with attributes carry their text under "#text".
  if (v && typeof v === "object" && typeof (v as { "#text"?: unknown })["#text"] === "string") {
    return (v as { "#text": string })["#text"].trim();
  }
  return "";
}

function atomLink(v: unknown): string {
  for (const link of asArray(v) as Array<Record<string, unknown> | string>) {
    if (typeof link === "string") return link.trim();
    const rel = link["@_rel"];
    if ((rel === undefined || rel === "alternate") && typeof link["@_href"] === "string") return link["@_href"].trim();
  }
  return "";
}

/** Items of an RSS 2.0 or Atom document, or null when it is neither. */
export function parseFeed(xml: string): FeedItem[] | null {
  let parsed: unknown;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
  } catch {
    return null;
  }
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };
  let raw: FeedItem[];
  if (root.rss) {
    raw = asArray(root.rss.channel?.item).map((it) => {
      const item = (it ?? {}) as Record<string, unknown>;
      return { url: text(item.link), title: text(item.title) };
    });
  } else if (root.feed) {
    raw = asArray(root.feed.entry).map((it) => {
      const entry = (it ?? {}) as Record<string, unknown>;
      return { url: atomLink(entry.link), title: text(entry.title) };
    });
  } else {
    return null;
  }
  return raw
    .filter((i) => /^https?:\/\//i.test(i.url) && i.title.length > 0)
    .map((i) => ({ url: i.url, title: i.title.slice(0, MAX_TITLE).trim() }));
}

/**
 * New items across `feeds` in feed order, skipping URLs in `seen`. A failing
 * feed is reported and never stops the others.
 */
export async function fetchFeedItems(
  feeds: string[],
  opts: { seen?: ReadonlySet<string>; maxPerFeed?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ items: FeedItem[]; errors: FeedError[] }> {
  const f = opts.fetchImpl ?? fetch;
  const items: FeedItem[] = [];
  const errors: FeedError[] = [];
  for (const feed of feeds) {
    let xml: string;
    try {
      const res = await f(feed, {
        headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push({ feed, message: `HTTP ${res.status}` });
        continue;
      }
      xml = await res.text();
    } catch (err) {
      errors.push({ feed, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = parseFeed(xml);
    if (parsed === null) {
      errors.push({ feed, message: "Not an RSS or Atom feed" });
      continue;
    }
    let taken = 0;
    for (const item of parsed) {
      if (opts.maxPerFeed !== undefined && taken >= opts.maxPerFeed) break;
      if (opts.seen?.has(item.url) || items.some((i) => i.url === item.url)) continue;
      items.push(item);
      taken++;
    }
  }
  return { items, errors };
}
