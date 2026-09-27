import { describe, expect, it } from "vitest";
import {
  alignSections,
  canCreate,
  contentParams,
  DRAFT_KEY,
  headingsFromText,
  initialExpressState,
  loadDraft,
  pendingParts,
  saveDraft,
  textToParagraphs,
  toCreatePayload,
  type ExpressState,
} from "../src/admin/express-state";
import { featuresOf } from "../src/lib/collections";

const filled: ExpressState = {
  ...initialExpressState,
  topic: "tea",
  title: "Tea 101",
  headingsText: "Water\nLeaves",
  sections: [
    { heading: "Water", text: "Fresh.\n\nCold." },
    { heading: "Leaves", text: "Loose." },
  ],
  intro: "Hi.",
  outro: "Bye.",
  excerpt: "Short.",
  featuredImage: { provider: "local", id: "m1", src: "/m1.png", alt: "Tea" },
};

describe("express-state helpers", () => {
  it("headingsFromText trims lines and drops blanks", () => {
    expect(headingsFromText("  Water \n\n Leaves\n")).toEqual(["Water", "Leaves"]);
  });

  it("headingsFromText drops later case-insensitive duplicates, keeping the first spelling", () => {
    expect(headingsFromText("Water\nwater\n Leaves \nWATER")).toEqual(["Water", "Leaves"]);
  });

  it("textToParagraphs splits on blank lines and normalises whitespace", () => {
    expect(textToParagraphs("One\nline.\n\n\n Two. ")).toEqual(["One line.", "Two."]);
  });

  it("alignSections keeps text for surviving headings and starts new ones empty", () => {
    expect(alignSections(["Leaves", "Brewing"], filled.sections)).toEqual([
      { heading: "Leaves", text: "Loose." },
      { heading: "Brewing", text: "" },
    ]);
  });

  it("pendingParts lists every missing part in pipeline order", () => {
    expect(pendingParts(initialExpressState)).toEqual([
      "title",
      "outline",
      "sections",
      "intro",
      "outro",
      "excerpt",
      "image",
    ]);
    expect(pendingParts(filled)).toEqual([]);
    expect(pendingParts({ ...filled, includeFaq: true, autoTags: true })).toEqual(["faq", "tags"]);
  });

  it("pendingParts skips image, tags and excerpt a collection cannot hold", () => {
    const pages = featuresOf({ fields: ["title", "content"], hasSeo: false, taxonomies: [] });
    expect(pendingParts({ ...initialExpressState, autoTags: true }, pages)).toEqual([
      "title",
      "outline",
      "sections",
      "intro",
      "outro",
    ]);
  });

  it("toCreatePayload converts text to paragraphs and honours the include toggles", () => {
    expect(toCreatePayload(filled)).toEqual({
      title: "Tea 101",
      intro: ["Hi."],
      sections: [
        { heading: "Water", paragraphs: ["Fresh.", "Cold."] },
        { heading: "Leaves", paragraphs: ["Loose."] },
      ],
      outro: ["Bye."],
      faq: [],
      excerpt: "Short.",
      featuredImage: filled.featuredImage,
      structure: { headingLevel: "h2", toc: false, outroHeader: "" },
      post: { collection: "posts", status: "draft", locale: "en", categories: [], tags: [] },
    });
    const trimmed = toCreatePayload({
      ...filled,
      includeOutro: false,
      includeFaq: true,
      faq: [{ q: "Q?", a: "" }],
      sections: [{ heading: "Water", text: "" }, { heading: "Leaves", text: "Loose." }],
    });
    expect(trimmed.outro).toEqual([]);
    expect(trimmed.faq).toEqual([]);
    expect(trimmed.sections).toEqual([{ heading: "Leaves", paragraphs: ["Loose."] }]);
  });

  it("toCreatePayload sends the chosen collection and locale, dropping what the collection cannot hold", () => {
    const tr = toCreatePayload({ ...filled, locale: "tr" });
    expect(tr.post).toMatchObject({ collection: "posts", locale: "tr" });
    const pages = featuresOf({ fields: ["title", "content"], hasSeo: false, taxonomies: [] });
    const page = toCreatePayload({ ...filled, collection: "pages", categories: ["beaches"], tags: ["sun"] }, pages);
    expect(page.post).toMatchObject({ collection: "pages", categories: [], tags: [] });
    expect(page.featuredImage).toBeUndefined();
    expect(page.excerpt).toBe("");
  });

  it("toCreatePayload passes the chosen status through", () => {
    expect(toCreatePayload({ ...filled, status: "published" }).post.status).toBe("published");
    expect(toCreatePayload({ ...filled, status: "draft" }).post.status).toBe("draft");
  });

  it("canCreate needs a title and at least one written section", () => {
    expect(canCreate(filled)).toBe(true);
    expect(canCreate({ ...filled, title: " " })).toBe(false);
    expect(canCreate(initialExpressState)).toBe(false);
  });

  it("contentParams sends the locale and blanks as undefined", () => {
    expect(contentParams({ ...initialExpressState, locale: "tr", style: "Lively" })).toEqual({
      locale: "tr",
      style: "Lively",
      tone: undefined,
    });
  });

  it("loadDraft merges over the initial state and tolerates bad JSON; saveDraft writes JSON", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadDraft(storage)).toEqual(initialExpressState);
    saveDraft(storage, { ...initialExpressState, topic: "tea" });
    expect(JSON.parse(store.get(DRAFT_KEY) as string).topic).toBe("tea");
    expect(loadDraft(storage).topic).toBe("tea");
    store.set(DRAFT_KEY, "{not json");
    expect(loadDraft(storage)).toEqual(initialExpressState);
  });

  it("loadDraft reads drafts saved before locales in English and drops unknown values", () => {
    const store = new Map<string, string>([[DRAFT_KEY, JSON.stringify({ topic: "tea", language: "Turkish" })]]);
    const draft = loadDraft({ getItem: (k: string) => store.get(k) ?? null });
    expect(draft.locale).toBe("en");
    expect(draft.collection).toBe("posts");
    store.set(DRAFT_KEY, JSON.stringify({ locale: "de", collection: "Bad Name" }));
    expect(loadDraft({ getItem: (k: string) => store.get(k) ?? null })).toMatchObject({ locale: "en", collection: "posts" });
  });
});
