import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/lib/settings";
import {
  cleanTitle,
  generateExcerpt,
  generateFaq,
  generateIntro,
  generateOutline,
  generateRewrite,
  generateSection,
  generateSeo,
  generateTags,
  generateTitle,
  matchTags,
  parseFaq,
  parseHeadings,
  parseSeo,
  splitParagraphs,
  StepError,
  type StepContext,
} from "../src/lib/steps";
import { fakeTextClient, minimaxTextSettings } from "./helpers";

function ctxWith(responses: Array<string | object>, extra: Partial<StepContext> = {}) {
  const fake = fakeTextClient(responses);
  const ctx: StepContext = { client: fake.client, settings: defaultSettings, mode: "article", ...extra };
  return { ctx, calls: fake.calls };
}

describe("parsers", () => {
  it("cleanTitle keeps the first line and strips labels, numbering, quotes, and bold", () => {
    expect(cleanTitle('Title: "**Green Tea Basics**"\nsecond line')).toBe("Green Tea Basics");
    expect(cleanTitle("\n\n1. Brewing Better Coffee")).toBe("Brewing Better Coffee");
  });

  it("cleanTitle clamps to 120 characters", () => {
    expect(cleanTitle("a".repeat(200)).length).toBe(120);
  });

  it("cleanTitle strips curly quotes and guillemets", () => {
    expect(cleanTitle("“Green Tea Basics”")).toBe("Green Tea Basics");
    expect(cleanTitle("«Brewing»")).toBe("Brewing");
  });

  it("parseHeadings reads JSON, strips numbering, dedupes, and clamps", () => {
    const out = { json: { headings: ["1. Origins", "Origins", "- Brewing", "Health"] }, raw: "" };
    expect(parseHeadings(out, 2)).toEqual(["Origins", "Brewing"]);
  });

  it("parseHeadings falls back to raw lines and skips lines without letters", () => {
    const out = { json: "not json", raw: "{\n1. Origins\n2. Brewing\n}" };
    expect(parseHeadings(out, 5)).toEqual(["Origins", "Brewing"]);
  });

  it("splitParagraphs splits on blank lines, drops markdown headings, joins wrapped lines", () => {
    expect(splitParagraphs("# Heading\nFirst line\nwraps here.\n\n\nSecond **bold** para.")).toEqual([
      "First line wraps here.",
      "Second bold para.",
    ]);
  });

  it("parseFaq accepts q/a and question/answer keys and skips empty items", () => {
    const out = {
      json: { items: [{ q: "Q1?", a: "A1." }, { question: "Q2?", answer: "A2." }, { q: "", a: "x" }] },
      raw: "",
    };
    expect(parseFaq(out)).toEqual([
      { q: "Q1?", a: "A1." },
      { q: "Q2?", a: "A2." },
    ]);
  });

  it("matchTags maps labels and slugs to existing slugs and ignores unknown tags", () => {
    const existing = [
      { slug: "green-tea", label: "Green Tea" },
      { slug: "health", label: "Health" },
    ];
    const out = { json: { tags: ["green tea", "HEALTH", "invented"] }, raw: "" };
    expect(matchTags(out, existing)).toEqual(["green-tea", "health"]);
  });
});

describe("step functions", () => {
  it("generateTitle sends the resolved model, fallback, and temperature", async () => {
    const { ctx, calls } = ctxWith(["A Great Title"]);
    expect(await generateTitle(ctx, { topic: "tea" })).toBe("A Great Title");
    expect(calls[0]).toMatchObject({
      model: "meta/muse-spark-1.3-contributor",
      fallbackModels: ["qwen/qwen3.8-flash"],
      temperature: 0.7,
    });
    expect(calls[0].prompt).toContain('"tea"');
  });

  it("a per-request model wins", async () => {
    const { ctx, calls } = ctxWith(["T"]);
    await generateTitle(ctx, { topic: "tea" }, "req/model");
    expect(calls[0].model).toBe("req/model");
  });

  it("writes in the language of the locale", async () => {
    const { ctx, calls } = ctxWith(["T"], { locale: "tr" });
    await generateTitle(ctx, { topic: "Kıbrıs plajları" });
    expect(calls[0].prompt).toContain("in Turkish");
    const en = ctxWith(["T"], { locale: "en", settings: { ...defaultSettings, language: "German" } });
    await generateTitle(en.ctx, { topic: "Cyprus beaches" });
    expect(en.calls[0].prompt).toContain("in English");
  });

  it("falls back to the Settings language when no locale is known", async () => {
    const { ctx, calls } = ctxWith(["T"], { settings: { ...defaultSettings, language: "German" } });
    await generateTitle(ctx, { topic: "Strände" });
    expect(calls[0].prompt).toContain("in German");
  });

  it("generateTitle throws StepError on an empty answer", async () => {
    const { ctx } = ctxWith(["   "]);
    await expect(generateTitle(ctx, { topic: "tea" })).rejects.toBeInstanceOf(StepError);
  });

  it("generateOutline requests JSON and clamps to the requested count", async () => {
    const { ctx, calls } = ctxWith([{ headings: ["A one", "B two", "C three", "D four"] }]);
    expect(await generateOutline(ctx, { title: "T", count: 3 })).toEqual(["A one", "B two", "C three"]);
    expect(calls[0].responseFormat).toEqual({ type: "json_object" });
    expect(calls[0].prompt).toContain("3 section headings");
  });

  it("generateOutline retries once, then throws StepError('outline')", async () => {
    const { ctx, calls } = ctxWith([{ headings: ["Only one"] }]);
    const err = await generateOutline(ctx, { title: "T", count: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).step).toBe("outline");
    expect(calls).toHaveLength(2);
  });

  it("generateSection returns at most the requested paragraphs", async () => {
    const { ctx } = ctxWith(["One.\n\nTwo.\n\nThree."]);
    expect(await generateSection(ctx, { title: "T", heading: "H", paragraphs: 2 })).toEqual(["One.", "Two."]);
  });

  it("generateSection retries once on an empty answer, then throws", async () => {
    const { ctx, calls } = ctxWith([""]);
    await expect(generateSection(ctx, { title: "T", heading: "H", paragraphs: 2 })).rejects.toBeInstanceOf(
      StepError,
    );
    expect(calls).toHaveLength(2);
  });

  it("generateIntro passes the headings list into the prompt", async () => {
    const { ctx, calls } = ctxWith(["Intro one.\n\nIntro two."]);
    expect(await generateIntro(ctx, { title: "T", headings: ["A", "B"] })).toEqual(["Intro one.", "Intro two."]);
    expect(calls[0].prompt).toContain("A; B");
  });

  it("generateFaq throws when no items come back", async () => {
    const { ctx } = ctxWith([{ items: [] }]);
    await expect(generateFaq(ctx, { title: "T" })).rejects.toBeInstanceOf(StepError);
  });

  it("generateExcerpt clamps to 280 characters", async () => {
    const { ctx } = ctxWith(["x".repeat(400)]);
    expect((await generateExcerpt(ctx, { title: "T", headings: ["A"] })).length).toBe(280);
  });

  it("generateTags makes no call when there are no existing tags", async () => {
    const { ctx, calls } = ctxWith(["unused"]);
    expect(await generateTags(ctx, { title: "T", existing: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("parseSeo", () => {
  it("reads camelCase or snake_case keys, cleans and clamps them", () => {
    const long = "x".repeat(300);
    expect(parseSeo({ json: { metaTitle: '“Brew Better Tea”', metaDescription: long }, raw: "" })).toEqual({
      metaTitle: "Brew Better Tea",
      metaDescription: "x".repeat(160),
    });
    expect(parseSeo({ json: { meta_title: "A", meta_description: "B" }, raw: "" })).toEqual({
      metaTitle: "A",
      metaDescription: "B",
    });
  });

  it("returns empty strings for non-object output", () => {
    expect(parseSeo({ json: "nope", raw: "nope" })).toEqual({ metaTitle: "", metaDescription: "" });
  });
});

describe("generateSeo", () => {
  it("calls the seo slot with the title and excerpt and returns clamped meta", async () => {
    const fake = fakeTextClient([{ metaTitle: "T".repeat(80), metaDescription: "Short description." }]);
    const ctx = { client: fake.client, settings: defaultSettings, mode: "article" as const };
    const seo = await generateSeo(ctx, { title: "Green Tea Guide", excerpt: "All about green tea." }, "m/seo");
    expect(seo).toEqual({ metaTitle: "T".repeat(60), metaDescription: "Short description." });
    expect(fake.calls[0].model).toBe("m/seo");
    expect(fake.calls[0].prompt).toContain("Green Tea Guide");
    expect(fake.calls[0].prompt).toContain("All about green tea.");
    expect(fake.calls[0].responseFormat).toEqual({ type: "json_object" });
  });

  it("throws a seo StepError when a field is missing", async () => {
    const fake = fakeTextClient([{ metaTitle: "Only a title" }]);
    const ctx = { client: fake.client, settings: defaultSettings, mode: "article" as const };
    await expect(generateSeo(ctx, { title: "T", excerpt: "" })).rejects.toMatchObject({ name: "StepError", step: "seo" });
  });
});

describe("generateRewrite", () => {
  it("uses the rewrite slot so its prompt override and model apply", async () => {
    const settings = {
      ...defaultSettings,
      models: { ...defaultSettings.models, steps: { rewrite: "m/rewrite" } },
      promptOverrides: { article: { rewrite: "REWRITE %%section%% OF %%title%%" } },
    };
    const fake = fakeTextClient(["First.\n\nSecond.\n\nThird."]);
    const ctx = { client: fake.client, settings, mode: "article" as const };
    const paragraphs = await generateRewrite(ctx, { title: "Tea", heading: "Leaves", paragraphs: 2 });
    expect(paragraphs).toEqual(["First.", "Second."]);
    expect(fake.calls[0].model).toBe("m/rewrite");
    expect(fake.calls[0].prompt).toBe("REWRITE Leaves OF Tea");
  });

  it("retries once on an empty reply, then throws a rewrite StepError", async () => {
    const fake = fakeTextClient(["", ""]);
    const ctx = { client: fake.client, settings: defaultSettings, mode: "article" as const };
    await expect(generateRewrite(ctx, { title: "Tea", heading: "Leaves", paragraphs: 2 })).rejects.toMatchObject({
      step: "rewrite",
    });
    expect(fake.calls).toHaveLength(2);
  });
});

describe("provider-aware steps", () => {
  it("resolves text models against the text provider, skipping a stale rule override", async () => {
    const { client, calls } = fakeTextClient(["Tea Time"]);
    await generateTitle(
      { client, settings: minimaxTextSettings, mode: "article", ruleModels: { title: "google/gemini-3.8-flash" } },
      { topic: "tea" },
    );
    expect(calls[0]).toMatchObject({ model: "MiniMax-M3", fallbackModels: [] });
  });
});
