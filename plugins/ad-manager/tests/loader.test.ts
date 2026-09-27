// @vitest-environment happy-dom
import { LOADER_SOURCE, loaderMain } from "../src/loader";

type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };

class FakeIO {
  static last: FakeIO | null = null;
  targets: Element[] = [];
  constructor(private readonly callback: (entries: Entry[]) => void) {
    FakeIO.last = this;
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve(target: Element) {
    this.targets = this.targets.filter((t) => t !== target);
  }
  disconnect() {}
  show(target: Element, ratio: number) {
    this.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
  }
}

const bannerFill = {
  adId: "ad-1",
  kind: "banner",
  width: 300,
  height: 250,
  href: "https://example.com/offer",
  alt: "Welcome offer",
  image: { url: "/a.jpg", width: 300, height: 250 },
  disclosure: "<b>18+</b> · Play responsibly",
};

let fetchMock: ReturnType<typeof vi.fn>;

function serveReturns(fills: Record<string, unknown[]>) {
  fetchMock.mockImplementation(async (url: string) => ({
    json: async () =>
      String(url).endsWith("/serve") ? { success: true, data: { ok: true, fills } } : { success: true, data: { ok: true } },
  }));
}

function bodiesSentTo(route: "serve" | "track") {
  return (fetchMock.mock.calls as Array<[string, { body?: string }]>)
    .filter(([url]) => url.endsWith(`/${route}`))
    .map(([, init]) => JSON.parse(init.body ?? "{}"));
}

const slots = () => Array.from(document.querySelectorAll<HTMLElement>("[data-ad-space]"));
const run = (opts: Parameters<typeof loaderMain>[1] = {}) => loaderMain(window, { isDisplayed: () => true, ...opts });

beforeEach(() => {
  document.documentElement.removeAttribute("data-ads");
  document.body.innerHTML = `
    <div class="page" data-ad-page="article" data-ad-competition="premier-league">
      <aside data-ad-space="top-banner"><div class="ad-slot__body"></div></aside>
      <aside data-ad-space="in-feed"><div class="ad-slot__body"></div></aside>
      <aside data-ad-space="in-feed"><div class="ad-slot__body"></div></aside>
    </div>`;
  fetchMock = vi.fn();
  (window as unknown as { fetch: unknown }).fetch = fetchMock;
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  FakeIO.last = null;
});

describe("loaderMain", () => {
  it("marks the page and sends one serve request with the page context", async () => {
    serveReturns({});
    await run();
    expect(document.documentElement.getAttribute("data-ads")).toBe("on");
    expect(bodiesSentTo("serve")).toEqual([
      {
        page: { type: "article", competition: "premier-league" },
        spaces: [
          { space: "top-banner", count: 1 },
          { space: "in-feed", count: 2 },
        ],
      },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers["X-EmDash-Request"]).toBe("1");
  });

  it("renders a banner with safe DOM and hides spaces with nothing to show", async () => {
    serveReturns({ "in-feed": [bannerFill] });
    await run();
    const [top, first, second] = slots();
    expect(top?.hidden).toBe(true);
    expect(second?.hidden).toBe(true);

    const link = first!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/offer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("sponsored noopener noreferrer");
    const img = link.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/a.jpg");
    expect(img.getAttribute("width")).toBe("300");
    expect(img.getAttribute("alt")).toBe("Welcome offer");
    expect(img.getAttribute("loading")).toBe("lazy");

    expect(first!.querySelector(".ad-slot__disclosure")?.textContent).toBe("<b>18+</b> · Play responsibly");
    expect(first!.querySelector("b")).toBeNull();
    expect(first!.hasAttribute("data-ad-filled")).toBe(true);
    expect(first!.getAttribute("data-ad-id")).toBe("ad-1");
  });

  it("adds a phone image source and loads the top banner eagerly", async () => {
    serveReturns({
      "top-banner": [
        { ...bannerFill, width: 970, height: 90, image: { url: "/wide.jpg", width: 970, height: 90 }, mobileImage: { url: "/phone.jpg", width: 320, height: 100 } },
      ],
    });
    await run();
    const source = slots()[0]!.querySelector("source")!;
    expect(source.getAttribute("media")).toBe("(max-width: 640px)");
    expect(source.getAttribute("srcset")).toBe("/phone.jpg");
    expect(slots()[0]!.querySelector("img")!.getAttribute("loading")).toBe("eager");
  });

  it("hides every space when serve fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await run();
    expect(slots().every((slot) => slot.hidden)).toBe(true);
  });

  it("hides every space when serve is too slow", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    await run({ timeoutMs: 10 });
    expect(slots().every((slot) => slot.hidden)).toBe(true);
  });

  it("recreates code-ad scripts so the browser runs them", async () => {
    const createElement = vi.spyOn(document, "createElement");
    serveReturns({
      "in-feed": [
        {
          adId: "code-1",
          kind: "code",
          width: 300,
          height: 250,
          html: '<ins class="adsbygoogle"></ins><script data-ad-client="ca-pub-1">window.__adRan = true;</script>',
        },
      ],
    });
    await run();
    expect(createElement).toHaveBeenCalledWith("script");
    expect(slots()[1]!.querySelector("script")?.getAttribute("data-ad-client")).toBe("ca-pub-1");
    expect(slots()[1]!.querySelector("ins.adsbygoogle")).not.toBeNull();
    createElement.mockRestore();
  });

  it("counts one impression once at least half is visible and sends it on pagehide", async () => {
    serveReturns({ "in-feed": [bannerFill] });
    await run();
    const first = slots()[1]!;

    FakeIO.last!.show(first, 0.3);
    window.dispatchEvent(new Event("pagehide"));
    expect(bodiesSentTo("track")).toEqual([]);

    FakeIO.last!.show(first, 0.6);
    FakeIO.last!.show(first, 0.9);
    window.dispatchEvent(new Event("pagehide"));
    expect(bodiesSentTo("track")).toEqual([{ events: [{ adId: "ad-1", space: "in-feed", type: "impression" }] }]);
    const trackInit = (fetchMock.mock.calls as Array<[string, { keepalive?: boolean }]>).find(([url]) => url.endsWith("/track"))![1];
    expect(trackInit.keepalive).toBe(true);
  });

  it("sends a click immediately", async () => {
    serveReturns({ "in-feed": [bannerFill] });
    await run();
    document.addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
    slots()[1]!.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(bodiesSentTo("track")).toEqual([{ events: [{ adId: "ad-1", space: "in-feed", type: "click" }] }]);
  });

  it("skips spaces that are not displayed", async () => {
    serveReturns({});
    await run({ isDisplayed: (el) => el.getAttribute("data-ad-space") !== "top-banner" });
    expect(bodiesSentTo("serve")[0].spaces).toEqual([{ space: "in-feed", count: 2 }]);
  });

  it("does nothing on pages without spaces", async () => {
    document.body.innerHTML = "";
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LOADER_SOURCE", () => {
  it("is a self-invoking script that parses", () => {
    expect(LOADER_SOURCE.startsWith("(")).toBe(true);
    expect(LOADER_SOURCE.endsWith(")(window);")).toBe(true);
    expect(LOADER_SOURCE).toContain("data-ad-space");
    expect(() => new Function(LOADER_SOURCE)).not.toThrow();
  });

  it("behaves correctly when run as the exact serialized string EmDash injects", async () => {
    serveReturns({ "in-feed": [bannerFill] });

    // The serialized source references `window`/`document`/`fetch`/`IntersectionObserver`
    // as bare globals (it has no closure over this test file), so the fakes must be
    // installed on globalThis, not just on the local `window` binding.
    const originalFetch = globalThis.fetch;
    const originalIO = (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;

    try {
      // Run the exact string EmDash injects into the page, not the function directly.
      new Function(LOADER_SOURCE)();
      // loaderMain is async; flush pending microtasks (fetch + response.json()) before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(document.documentElement.getAttribute("data-ads")).toBe("on");
      const filled = document.querySelector("[data-ad-filled]");
      expect(filled).not.toBeNull();
      const img = filled?.querySelector(".ad-slot__body img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe("/a.jpg");
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalIO;
    }
  });
});
