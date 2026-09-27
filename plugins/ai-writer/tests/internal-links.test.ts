import { describe, expect, it, vi } from "vitest";
import type { ContentHandlers, UpdateBody } from "../src/lib/content";
import {
  chooseInbound,
  chooseOutbound,
  hasPendingDraft,
  hrefFor,
  insertLink,
  linkedHrefs,
  paragraphsOf,
  rankRelated,
  runLinkJob,
  type Ask,
  type Candidate,
  type LinkEntry,
} from "../src/lib/internal-links";
import type { GenerateTextInput } from "../src/lib/openrouter";
import { defaultSettings } from "../src/lib/settings";

const span = (key: string, text: string, marks: string[] = []) => ({ _type: "span", _key: key, text, marks });
const block = (key: string, text: string, style = "normal") => ({
  _type: "block",
  _key: key,
  style,
  markDefs: [] as Array<Record<string, unknown>>,
  children: [span(`${key}s`, text)],
});
const reply = (json: unknown): ReturnType<Ask> => Promise.resolve({ json, raw: JSON.stringify(json) });

describe("Portable Text helpers", () => {
  const body = [
    block("h", "Harbour guide", "h2"),
    block("p1", "We walked the old harbour all afternoon."),
    { _type: "image", asset: { _ref: "x" } },
    block("p2", "The Bellapais abbey tour paid off."),
  ];

  it("lists body paragraphs with their block index, skipping headings and non-text blocks", () => {
    expect(paragraphsOf(body)).toEqual([
      { block: 1, text: "We walked the old harbour all afternoon." },
      { block: 3, text: "The Bellapais abbey tour paid off." },
    ]);
  });

  it("wraps a phrase in a link mark without changing the text", () => {
    const next = insertLink(body, 1, "old harbour", "/old-harbour") as typeof body;
    const b = next[1] as ReturnType<typeof block>;
    expect(b.children.map((c) => c.text).join("")).toBe("We walked the old harbour all afternoon.");
    expect(b.children.map((c) => c.text)).toEqual(["We walked the ", "old harbour", " all afternoon."]);
    const linkKey = b.markDefs[0]._key as string;
    expect(b.markDefs).toEqual([{ _type: "link", _key: linkKey, href: "/old-harbour" }]);
    expect(b.children[1].marks).toEqual([linkKey]);
    expect(new Set(b.children.map((c) => c._key)).size).toBe(3);
    expect(body[1]).toEqual(block("p1", "We walked the old harbour all afternoon."));
    expect(linkedHrefs(next)).toEqual(new Set(["/old-harbour"]));
  });

  it("matches case-insensitively but keeps the original casing", () => {
    const next = insertLink(body, 3, "BELLAPAIS ABBEY", "/a") as typeof body;
    expect((next[3] as ReturnType<typeof block>).children[1].text).toBe("Bellapais abbey");
  });

  it("refuses headings, missing phrases, overlong anchors and text already inside a link", () => {
    expect(insertLink(body, 0, "Harbour", "/x")).toBeNull();
    expect(insertLink(body, 1, "not here", "/x")).toBeNull();
    expect(insertLink(body, 1, "a ".repeat(60), "/x")).toBeNull();
    const linked = insertLink(body, 1, "old harbour", "/x") as unknown[];
    expect(insertLink(linked, 1, "harbour", "/y")).toBeNull();
    expect(insertLink(linked, 1, "afternoon", "/y")).not.toBeNull();
  });

  it("builds locale-aware hrefs: /{slug} for English, /tr/{slug} for Turkish", () => {
    expect(hrefFor("{localePrefix}/{slug}", "posts", "kyrenia-harbour", "en")).toBe("/kyrenia-harbour");
    expect(hrefFor("{localePrefix}/{slug}", "posts", "girne-limani", "tr")).toBe("/tr/girne-limani");
    expect(hrefFor("{localePrefix}/{slug}", "posts", "no-locale")).toBe("/no-locale");
    expect(hrefFor("/{collection}/{slug}", "posts", "kyrenia-harbour", "tr")).toBe("/posts/kyrenia-harbour");
    expect(hrefFor("{localePrefix}/guide/{slug}", "pages", "çay", "tr")).toBe("/tr/guide/%C3%A7ay");
  });

  it("detects pending drafts", () => {
    expect(hasPendingDraft({ id: "a", draftRevisionId: "r2", liveRevisionId: "r1" })).toBe(true);
    expect(hasPendingDraft({ id: "a", draftRevisionId: "r1", liveRevisionId: "r1" })).toBe(false);
    expect(hasPendingDraft({ id: "a", draftRevisionId: null, liveRevisionId: "r1" })).toBe(false);
  });
});

const CANDIDATES: Candidate[] = [
  { id: "c1", slug: "kyrenia-harbour", title: "A Walk Around Kyrenia Harbour", excerpt: "" },
  { id: "c2", slug: "bellapais-abbey", title: "Visiting Bellapais Abbey", excerpt: "History" },
  { id: "c3", slug: "cooking", title: "Best Pasta Recipes", excerpt: "" },
];

describe("AI choices", () => {
  it("ranks related candidates, ignoring unknown numbers and duplicates", async () => {
    const ask = vi.fn((_prompt: string) => reply({ related: [2, 9, 2, 1] }));
    expect(await rankRelated(ask, { title: "Kyrenia", excerpt: "" }, CANDIDATES)).toEqual([CANDIDATES[1], CANDIDATES[0]]);
    expect(ask.mock.calls[0][0]).toContain("3. Best Pasta Recipes");
  });

  it("keeps only outbound anchors that exist verbatim, one per paragraph and per target", async () => {
    const paragraphs = [{ text: "They walked the old harbour early." }, { text: "The Bellapais abbey visit was worth it." }];
    const ask = vi.fn(() =>
      reply({
        links: [
          { article: 1, paragraph: 1, anchor: "old harbour" },
          { article: 2, paragraph: 1, anchor: "early" },
          { article: 2, paragraph: 2, anchor: "invented words" },
          { article: 1, paragraph: 2, anchor: "Bellapais abbey" },
          { article: 2, paragraph: 2, anchor: "Bellapais Abbey" },
        ],
      }),
    );
    expect(await chooseOutbound(ask, paragraphs, CANDIDATES.slice(0, 2), 5)).toEqual([
      { target: CANDIDATES[0], paragraph: 0, anchor: "old harbour" },
      { target: CANDIDATES[1], paragraph: 1, anchor: "Bellapais Abbey" },
    ]);
  });

  it("caps outbound anchors and makes no call when there is nothing to link", async () => {
    const ask = vi.fn(() => reply({ links: [{ article: 1, paragraph: 1, anchor: "a b" }, { article: 2, paragraph: 2, anchor: "c d" }] }));
    expect(await chooseOutbound(ask, [{ text: "a b" }, { text: "c d" }], CANDIDATES, 1)).toHaveLength(1);
    const none = vi.fn();
    expect(await chooseOutbound(none, [], CANDIDATES, 5)).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });

  it("returns an inbound anchor only when it is really in the paragraph", async () => {
    const paragraphs = [{ text: "A coast defined by the Kyrenia harbour." }];
    expect(await chooseInbound(() => reply({ paragraph: 1, anchor: "Kyrenia harbour" }), paragraphs, { title: "T", excerpt: "" })).toEqual({
      paragraph: 0,
      anchor: "Kyrenia harbour",
    });
    expect(await chooseInbound(() => reply({ paragraph: 1, anchor: "Paphos" }), paragraphs, { title: "T", excerpt: "" })).toBeNull();
    expect(await chooseInbound(() => reply({ paragraph: null, anchor: null }), paragraphs, { title: "T", excerpt: "" })).toBeNull();
  });
});

describe("runLinkJob", () => {
  const entry = (id: string, slug: string, title: string, text: string, extra: Partial<LinkEntry> = {}): LinkEntry => ({
    id,
    slug,
    status: "published",
    liveRevisionId: `${id}-r1`,
    draftRevisionId: null,
    data: { title, excerpt: `${title} summary`, content: [block(`${id}p`, text)] },
    ...extra,
  });

  function setup(entries: LinkEntry[], answers: (input: GenerateTextInput) => unknown) {
    const store = new Map(entries.map((e) => [e.id, structuredClone(e)]));
    const updates: Array<{ id: string; body: UpdateBody }> = [];
    const published: string[] = [];
    const content: Pick<ContentHandlers, "get" | "update" | "publish"> = {
      get: vi.fn(async (_c: string, id: string) => {
        const e = store.get(id);
        return e ? { success: true as const, data: { item: e } } : { success: false as const, error: { message: "Content item not found" } };
      }),
      update: vi.fn(async (_c: string, id: string, body: UpdateBody) => {
        updates.push({ id, body });
        const e = store.get(id) as LinkEntry;
        e.data = { ...e.data, ...body.data };
        return { success: true as const, data: { item: e } };
      }),
      publish: vi.fn(async (_c: string, id: string) => {
        published.push(id);
        return { success: true as const, data: {} };
      }),
    };
    const calls: GenerateTextInput[] = [];
    const client = {
      generateText: vi.fn(async (input: GenerateTextInput) => {
        calls.push(input);
        const json = answers(input);
        return { json, raw: JSON.stringify(json) };
      }),
    };
    const listPublished = vi.fn(async () => ({ success: true as const, data: { items: [...store.values()] } }));
    const settings = { ...defaultSettings, models: { ...defaultSettings.models, fallbackText: "" } };
    return { deps: { client, settings, content, listPublished }, store, updates, published, calls };
  }

  const NEW: LinkEntry = {
    ...entry("new", "kyrenia-day-trip", "A Day Trip to Kyrenia", ""),
    data: {
      title: "A Day Trip to Kyrenia",
      excerpt: "Day trip",
      content: [block("n1", "Start the day at the old harbour."), block("n2", "Then drive up to the Bellapais abbey.")],
    },
  };
  const OLD_PRESS = entry("harbour", "kyrenia-harbour", "A Walk Around Kyrenia Harbour", "Most visitors plan a Kyrenia day trip around the castle.");
  const OLD_SCOUT = entry("abbey", "bellapais-abbey", "Bellapais Abbey", "Guides often suggest a trip to Kyrenia afterwards.");
  const OLD_DRAFTY = entry("drafty", "drafty", "Kyrenia History", "The town has a long history.", { draftRevisionId: "drafty-r2" });

  const answers = (input: GenerateTextInput) => {
    if (input.prompt.includes('{"related"')) return { related: [1, 2, 3] };
    if (input.prompt.includes('{"links"')) {
      return {
        links: [
          { article: 1, paragraph: 1, anchor: "old harbour" },
          { article: 2, paragraph: 2, anchor: "Bellapais abbey" },
        ],
      };
    }
    if (input.prompt.includes("Kyrenia day trip around")) return { paragraph: 1, anchor: "Kyrenia day trip" };
    if (input.prompt.includes("trip to Kyrenia afterwards")) return { paragraph: 1, anchor: "trip to Kyrenia" };
    return { paragraph: null, anchor: null };
  };

  it("links the new post to related posts and related posts back, publishing each change", async () => {
    const { deps, store, published, calls } = setup([NEW, OLD_PRESS, OLD_SCOUT], answers);
    const result = await runLinkJob(deps, "posts", "new");

    expect(result.outbound.map((l) => [l.id, l.anchor])).toEqual([
      ["harbour", "old harbour"],
      ["abbey", "Bellapais abbey"],
    ]);
    expect(result.inbound.map((l) => [l.id, l.anchor])).toEqual([
      ["harbour", "Kyrenia day trip"],
      ["abbey", "trip to Kyrenia"],
    ]);
    expect(linkedHrefs(store.get("new")?.data?.content)).toEqual(new Set(["/kyrenia-harbour", "/bellapais-abbey"]));
    expect(linkedHrefs(store.get("harbour")?.data?.content)).toEqual(new Set(["/kyrenia-day-trip"]));
    expect(published).toEqual(["new", "harbour", "abbey"]);
    expect(result.calls).toBe(calls.length);
    expect(calls.every((c) => c.responseFormat?.type === "json_object")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("respects the limits and skips older posts with pending editor drafts", async () => {
    const { deps, store } = setup([NEW, OLD_DRAFTY, OLD_PRESS, OLD_SCOUT], (input) =>
      input.prompt.includes('{"related"') ? { related: [1, 2, 3] } : answers(input),
    );
    deps.settings = { ...deps.settings, internalLinks: { ...deps.settings.internalLinks, maxOutbound: 1, maxInbound: 1 } };
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.outbound).toHaveLength(1);
    expect(result.inbound.map((l) => l.id)).toEqual(["harbour"]);
    expect(result.warnings).toContain('"Kyrenia History" skipped: it has unpublished editor changes');
    expect(linkedHrefs(store.get("drafty")?.data?.content).size).toBe(0);
  });

  it("does not touch the new post's body while it has pending editor changes, but still adds backlinks", async () => {
    const { deps, published } = setup([{ ...NEW, draftRevisionId: "new-r2" }, OLD_PRESS], answers);
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.outbound).toEqual([]);
    expect(result.warnings).toContain("Outbound links skipped: the post has unpublished editor changes");
    expect(published).toEqual(["harbour"]);
  });

  it("does not add a second backlink when an older post already links to the new one", async () => {
    const pressLinked = structuredClone(OLD_PRESS);
    pressLinked.data!.content = insertLink(pressLinked.data!.content as unknown[], 0, "visitors", "/kyrenia-day-trip");
    const { deps, updates } = setup([NEW, pressLinked], answers);
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.inbound).toEqual([]);
    expect(updates.map((u) => u.id)).toEqual(["new"]);
  });

  it("reports nothing to do when there are no other published posts", async () => {
    const { deps, calls } = setup([NEW], answers);
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.warnings).toEqual(["No other published posts to link with"]);
    expect(calls).toHaveLength(0);
  });

  it("fails for posts that are missing or not published", async () => {
    const { deps } = setup([{ ...NEW, status: "draft" }], answers);
    await expect(runLinkJob(deps, "posts", "new")).rejects.toThrow(/no longer published/);
    await expect(runLinkJob(deps, "posts", "gone")).rejects.toThrow(/not found/);
  });

  it("keeps the link but warns when publishing the change fails", async () => {
    const { deps } = setup([NEW, OLD_PRESS], answers);
    deps.content.publish = vi.fn(async () => ({ success: false as const, error: { message: "locked" } }));
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.outbound).toHaveLength(1);
    expect(result.warnings).toContain("Outbound links: saved as a draft; publishing failed: locked");
  });

  it("links only within the post's locale, with /tr/ URLs for Turkish posts", async () => {
    const trNew: LinkEntry = { ...NEW, slug: "girne-gezisi", locale: "tr" };
    const { deps, store } = setup([trNew, { ...OLD_PRESS, slug: "girne-limani", locale: "tr" }, { ...OLD_SCOUT, slug: "bellapais-manastiri", locale: "tr" }], answers);
    await runLinkJob(deps, "posts", "new");
    expect(deps.listPublished).toHaveBeenCalledWith("posts", "tr");
    expect(linkedHrefs(store.get("new")?.data?.content)).toEqual(new Set(["/tr/girne-limani", "/tr/bellapais-manastiri"]));
    expect(linkedHrefs(store.get("harbour")?.data?.content)).toEqual(new Set(["/tr/girne-gezisi"]));
  });

  it("never links to a post in another locale, even if the listing returns one", async () => {
    const trNew: LinkEntry = { ...NEW, locale: "tr" };
    const { deps, calls } = setup([trNew, { ...OLD_PRESS, locale: "en" }], answers);
    const result = await runLinkJob(deps, "posts", "new");
    expect(result.warnings).toEqual(["No other published posts to link with"]);
    expect(calls).toHaveLength(0);
  });

  it("asks for travel relatedness: place, region, category, activity or theme", async () => {
    const { deps, calls } = setup([NEW, OLD_PRESS], answers);
    await runLinkJob(deps, "posts", "new");
    const rank = calls.find((c) => c.prompt.includes('{"related"'));
    expect(rank?.prompt).toContain("same place, region, category, activity or theme");
    expect(rank?.prompt).not.toMatch(/team|competition/);
  });

  it("uses the linking model from settings", async () => {
    const { deps, calls } = setup([NEW, OLD_PRESS], answers);
    deps.settings = { ...deps.settings, internalLinks: { ...deps.settings.internalLinks, model: "vendor/linker" } };
    await runLinkJob(deps, "posts", "new");
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["vendor/linker"]));
  });
});
