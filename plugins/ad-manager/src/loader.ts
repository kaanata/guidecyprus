/**
 * Browser ad loader, injected into public pages by the page:fragments hook.
 * `loaderMain` is serialised with Function#toString, so it must stay fully
 * self-contained: no imports and no references to anything outside its body.
 */
export interface LoaderOptions {
  /** Decides whether a space is rendered (defaults to "has layout boxes"). */
  isDisplayed?: (el: Element) => boolean;
  /** serve request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
}

export async function loaderMain(win: Window, opts: LoaderOptions = {}): Promise<void> {
  type Img = { url: string; width: number; height: number };
  type Creative = {
    adId: string;
    kind: "banner" | "code";
    width: number;
    height: number;
    disclosure?: string;
    href?: string;
    alt?: string;
    image?: Img;
    mobileImage?: Img;
    html?: string;
  };
  type TrackEvent = { adId: string; space: string; type: "impression" | "click" };

  const doc = win.document;
  const base = "/_emdash/api/plugins/ad-manager/";
  const headers = { "Content-Type": "application/json", "X-EmDash-Request": "1" };
  const isDisplayed = opts.isDisplayed ?? ((el: Element) => el.getClientRects().length > 0);

  doc.documentElement.setAttribute("data-ads", "on");
  const slots = Array.from(doc.querySelectorAll<HTMLElement>("[data-ad-space]")).filter((el) => isDisplayed(el));
  if (slots.length === 0) return;

  const pageEl = doc.querySelector("[data-ad-page]");
  const page: { type: string; competition?: string } = { type: pageEl?.getAttribute("data-ad-page") || "page" };
  const competition = pageEl?.getAttribute("data-ad-competition");
  if (competition) page.competition = competition;

  const counts = new Map<string, number>();
  for (const slot of slots) {
    const space = slot.getAttribute("data-ad-space") ?? "";
    counts.set(space, Math.min((counts.get(space) ?? 0) + 1, 4));
  }

  let fills: Record<string, Creative[]> = {};
  try {
    const controller = new (win as unknown as { AbortController: typeof AbortController }).AbortController();
    const timer = win.setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
    const response = await win.fetch(base + "serve", {
      method: "POST",
      headers,
      body: JSON.stringify({ page, spaces: Array.from(counts, ([space, count]) => ({ space, count })) }),
      signal: controller.signal,
    });
    win.clearTimeout(timer);
    const json = await response.json();
    const data = json && typeof json === "object" && "data" in json ? json.data : json;
    if (!data || (data as unknown as { ok?: boolean }).ok !== true) throw new Error("serve failed");
    fills = (data as unknown as { fills?: Record<string, Creative[]> }).fills ?? {};
  } catch {
    for (const slot of slots) slot.hidden = true;
    return;
  }

  const queue: TrackEvent[] = [];
  const send = (events: TrackEvent[]) => {
    if (events.length === 0) return;
    try {
      void Promise.resolve(
        win.fetch(base + "track", { method: "POST", headers, body: JSON.stringify({ events }), keepalive: true }),
      ).catch(() => undefined);
    } catch {
      // Tracking is best-effort.
    }
  };
  const flush = () => send(queue.splice(0, queue.length));

  const seen = new Set<Element>();
  const markSeen = (slot: Element) => {
    if (seen.has(slot)) return;
    seen.add(slot);
    queue.push({
      adId: slot.getAttribute("data-ad-id") ?? "",
      space: slot.getAttribute("data-ad-space") ?? "",
      type: "impression",
    });
  };
  const IO = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  const observer = IO
    ? new IO(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
              markSeen(entry.target);
              observer?.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.5 },
      )
    : null;

  const used = new Map<string, number>();
  for (const slot of slots) {
    const space = slot.getAttribute("data-ad-space") ?? "";
    const index = used.get(space) ?? 0;
    used.set(space, index + 1);
    const creative = (fills[space] ?? [])[index];
    if (!creative) {
      slot.hidden = true;
      continue;
    }

    const body = slot.querySelector<HTMLElement>(".ad-slot__body") ?? slot;
    try {
      if (creative.kind === "banner" && creative.image && creative.href) {
        const link = doc.createElement("a");
        link.setAttribute("href", creative.href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "sponsored noopener noreferrer");
        const picture = doc.createElement("picture");
        if (creative.mobileImage) {
          const source = doc.createElement("source");
          source.setAttribute("media", "(max-width: 640px)");
          source.setAttribute("srcset", creative.mobileImage.url);
          source.setAttribute("width", String(creative.mobileImage.width));
          source.setAttribute("height", String(creative.mobileImage.height));
          picture.appendChild(source);
        }
        const img = doc.createElement("img");
        img.setAttribute("src", creative.image.url);
        img.setAttribute("width", String(creative.image.width));
        img.setAttribute("height", String(creative.image.height));
        img.setAttribute("alt", creative.alt ?? "");
        img.setAttribute("loading", space === "top-banner" ? "eager" : "lazy");
        img.setAttribute("decoding", "async");
        picture.appendChild(img);
        link.appendChild(picture);
        body.appendChild(link);
        const adId = creative.adId;
        link.addEventListener("click", () => send([{ adId, space, type: "click" }]));
      } else if (creative.kind === "code" && creative.html) {
        body.innerHTML = creative.html;
        // Scripts inserted via innerHTML don't run; replace each with a fresh element.
        for (const old of Array.from(body.querySelectorAll("script"))) {
          const fresh = doc.createElement("script");
          for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
          fresh.textContent = old.textContent ?? "";
          old.replaceWith(fresh);
        }
      } else {
        slot.hidden = true;
        continue;
      }

      if (creative.disclosure) {
        const note = doc.createElement("p");
        note.className = "ad-slot__disclosure";
        note.textContent = creative.disclosure;
        slot.appendChild(note);
      }
      slot.setAttribute("data-ad-filled", "");
      slot.setAttribute("data-ad-id", creative.adId);
      if (observer) observer.observe(slot);
      else markSeen(slot);
    } catch {
      slot.hidden = true;
    }
  }

  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") flush();
  });
  win.addEventListener("pagehide", flush);
}

export const LOADER_SOURCE = `(${loaderMain.toString()})(window);`;
