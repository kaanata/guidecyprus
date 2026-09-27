import { describe, expect, it, vi } from "vitest";
import { fetchFeedItems, parseFeed } from "../src/lib/rss";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title>First story</title><link>https://example.com/1</link></item>
<item><title>Second story</title><link>https://example.com/2</link></item>
<item><title></title><link>https://example.com/untitled</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="text">Atom story</title><link rel="alternate" href="https://example.org/a"/></entry>
</feed>`;

const response = (body: string, status = 200) => new Response(body, { status });

describe("parseFeed", () => {
  it("reads RSS items and drops ones without a title or link", () => {
    expect(parseFeed(RSS)).toEqual([
      { url: "https://example.com/1", title: "First story" },
      { url: "https://example.com/2", title: "Second story" },
    ]);
  });

  it("reads Atom entries", () => {
    expect(parseFeed(ATOM)).toEqual([{ url: "https://example.org/a", title: "Atom story" }]);
  });

  it("returns null for documents that are not feeds", () => {
    expect(parseFeed("<html><body>hi</body></html>")).toBeNull();
    expect(parseFeed("not xml at all")).toBeNull();
  });
});

describe("fetchFeedItems", () => {
  it("skips seen URLs, caps per feed and keeps going past a failing feed", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("bad") ? response("nope", 500) : response(RSS),
    ) as unknown as typeof fetch;
    const out = await fetchFeedItems(["https://bad.example/feed", "https://good.example/feed"], {
      seen: new Set(["https://example.com/1"]),
      maxPerFeed: 5,
      fetchImpl,
    });
    expect(out.items).toEqual([{ url: "https://example.com/2", title: "Second story" }]);
    expect(out.errors).toEqual([{ feed: "https://bad.example/feed", message: "HTTP 500" }]);
  });

  it("reports network errors and non-feed bodies", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("down")) throw new Error("connection refused");
      return response("<html></html>");
    }) as unknown as typeof fetch;
    const out = await fetchFeedItems(["https://down.example/feed", "https://html.example/"], { fetchImpl });
    expect(out.items).toEqual([]);
    expect(out.errors).toEqual([
      { feed: "https://down.example/feed", message: "connection refused" },
      { feed: "https://html.example/", message: "Not an RSS or Atom feed" },
    ]);
  });
});
