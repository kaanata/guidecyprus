import { describe, expect, it, vi } from "vitest";
import { insertLink, linkedHrefs } from "../src/lib/internal-links";
import { defaultSettings } from "../src/lib/settings";
import {
  deslopArticle,
  describeSlop,
  fromEditable,
  lintSlop,
  SLOP_GUIDE,
  slopAskFor,
  SlopEditError,
  toEditable,
  type SlopAsk,
} from "../src/lib/slop";

const span = (key: string, text: string, marks: string[] = []) => ({ _type: "span", _key: key, text, marks });
const block = (key: string, text: string, style = "normal") => ({
  _type: "block",
  _key: key,
  style,
  markDefs: [] as Array<Record<string, unknown>>,
  children: [span(`${key}s`, text)],
});
const textOf = (b: unknown) => ((b as { children: Array<{ text: string }> }).children ?? []).map((c) => c.text).join("");
const reply = (json: unknown): SlopAsk => vi.fn(async () => ({ json, raw: JSON.stringify(json) }));

// The rule set of petergyang/no-ai-slop (skills/no-ai-slop/SKILL.md), copied here as the spec
// so the writing prompt is checked against upstream, not against our own constants.
const UPSTREAM = {
  bannedWords: [
    "delve", "foster", "leverage", "utilize", "facilitate", "empower", "streamline", "robust",
    "cutting-edge", "paradigm shift", "game changer", "this is huge", "this changes everything",
    "tapestry", "realm", "beacon", "multifaceted", "meticulous", "intricate", "paramount",
    "transformative", "elevate", "embark", "supercharge", "harness", "ever-evolving",
  ],
  adverbs: [
    "just", "literally", "honestly", "simply", "actually", "truly", "fundamentally",
    "importantly", "crucially", "inherently", "inevitably",
  ],
  phrases: [
    "it's worth noting", "it's important to note", "at the end of the day", "when it comes to",
    "at its core", "in today's world", "in the age of", "in the world of", "the reality is",
    "the truth is", "in terms of", "with regard to", "in order to", "going forward",
    "in this article", "let's dive in",
  ],
  patterns: [
    "binary contrasts", "throat-clearing openers", "faux-insight setups", "colon reveals",
    "superficial analysis", "importance puffery", "interpretive metadiscourse", "weasel attribution",
    "fake-strong verbs", "synonym cycling", "negative listing", "dramatic fragments", "robotic rhythm",
    "rhetorical setups", "fake-profound kickers", "summary-recap endings", "formatting slop", "em dashes",
  ],
  principles: ["lead with the point", "active voice", "strong verbs", "concrete", "portability test", "show, don't tell"],
};

describe("SLOP_GUIDE (the rules every writing prompt carries)", () => {
  const guide = SLOP_GUIDE.toLowerCase();

  it.each(Object.entries(UPSTREAM))("includes every upstream %s entry", (_kind, entries) => {
    expect(entries.filter((e) => !guide.includes(e.toLowerCase()))).toEqual([]);
  });

  it("is written for writing, not for editing someone else's draft", () => {
    expect(guide).not.toMatch(/what changed|writer's voice|paste your draft/);
  });
});

describe("lintSlop", () => {
  it("names banned words, empty phrases, patterns and em-dash clusters with counts", () => {
    const found = lintSlop(
      "We delve into robust itineraries. It's worth noting that the harbour plays a vital role — always — and more — here. In conclusion, experts agree. Delving deeper.",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'banned word "delve" ×2',
        'banned word "robust"',
        `empty phrase "it's worth noting"`,
        "importance puffery",
        "weasel attribution",
        "summary-recap ending",
        "em dashes ×3",
      ]),
    );
  });

  it("catches binary contrasts with curly apostrophes and ignores clean prose", () => {
    expect(lintSlop("It’s not about the formation, it’s the spacing.")).toContain("binary contrast");
    expect(lintSlop("The back three gives the wing-backs licence to push high.")).toEqual([]);
    // Word boundaries: "realmente" or "elevated view" patterns must not trip unrelated words.
    expect(lintSlop("The harnessing of the brand")).toContain('banned word "harness"');
    expect(lintSlop("A realmadrid fan site")).toEqual([]);
  });

  it("flags the upstream phrases we used to miss and negative listing", () => {
    const found = lintSlop(
      "This is huge for the island. In the world of travel, hotels discount in order to fill rooms. Not luck. Not money. Timing.",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        'banned word "this is huge"',
        'empty phrase "in the world of"',
        'empty phrase "in order to"',
        "negative listing",
      ]),
    );
    expect(lintSlop("Not every hotel can afford it.")).not.toContain("negative listing");
  });
});

describe("editable blocks", () => {
  const linked = insertLink([block("p", "Visitors walk slowly to take in the view.")], 0, "walk slowly", "/slow-walks") as unknown[];

  it("writes links as [anchor](href) and rebuilds them exactly", () => {
    const e = toEditable(linked[0], 0);
    expect(e?.text).toBe("Visitors [walk slowly](/slow-walks) to take in the view.");
    const rebuilt = fromEditable(linked[0], "Visitors [walk slowly](/slow-walks) to enjoy the view.", e?.links ?? []);
    expect(textOf(rebuilt)).toBe("Visitors walk slowly to enjoy the view.");
    expect(linkedHrefs([rebuilt])).toEqual(new Set(["/slow-walks"]));
  });

  it("rejects edits that drop, rename, retarget or invent links", () => {
    const e = toEditable(linked[0], 0);
    const links = e?.links ?? [];
    expect(fromEditable(linked[0], "Visitors walk slowly to enjoy the view.", links)).toBeNull();
    expect(fromEditable(linked[0], "Visitors [walk fast](/slow-walks) to enjoy the view.", links)).toBeNull();
    expect(fromEditable(linked[0], "Visitors [walk slowly](/other) now.", links)).toBeNull();
    expect(fromEditable(linked[0], "Visitors [walk slowly](/slow-walks) and [more](/slow-walks).", links)).toBeNull();
  });

  it("leaves blocks with bold/italic marks, images and quotes out of the edit", () => {
    const bold = { ...block("b", ""), markDefs: [], children: [span("b1", "Strong", ["strong"])] };
    expect(toEditable(bold, 0)).toBeNull();
    expect(toEditable({ _type: "image" }, 0)).toBeNull();
    expect(toEditable(block("q", "A quote", "blockquote"), 0)).toBeNull();
  });
});

describe("deslopArticle", () => {
  const content = [
    block("h", "Why Kyrenia matters", "h2"),
    ...(insertLink([block("p1", "Visitors delve into a robust old town to find the harbour.")], 0, "find the harbour", "/harbour-walk") as unknown[]),
    block("p2", "It's worth noting that this plays a vital role."),
    { _type: "image", asset: { _ref: "img" } },
    block("p3", "In conclusion, Kyrenia is a tapestry of charm."),
  ];
  const input = { title: "Kyrenia", excerpt: "A robust look at Kyrenia.", content };

  it("edits text in place, keeps links, headings and non-text blocks, and deletes filler", async () => {
    const ask = reply({
      excerpt: "How Kyrenia rewards a slow morning walk.",
      blocks: [
        { i: 0, text: "Why Kyrenia matters" },
        { i: 1, text: "Visitors walk through the old town to [find the harbour](/harbour-walk)." },
        { i: 2, text: "" },
        { i: 4, text: "Kyrenia is best seen early, before the day trips arrive." },
      ],
    });
    const out = await deslopArticle(ask, input);
    expect(out.content).toHaveLength(4);
    expect(textOf(out.content[1])).toBe("Visitors walk through the old town to find the harbour.");
    expect(linkedHrefs(out.content)).toEqual(new Set(["/harbour-walk"]));
    expect(out.content[2]).toEqual({ _type: "image", asset: { _ref: "img" } });
    expect(out.excerpt).toBe("How Kyrenia rewards a slow morning walk.");
    expect(out).toMatchObject({ editedBlocks: 2, removedBlocks: 1, keptBlocks: 0 });
    expect(out.before.length).toBeGreaterThan(0);
    expect(out.after).toEqual([]);
    const [system, prompt] = (ask as unknown as { mock: { calls: string[][] } }).mock.calls[0];
    expect(system).toContain("Never add claims");
    expect(prompt).toContain("[find the harbour](/harbour-walk)");
    expect(prompt).toContain('banned word "delve"');
    expect(describeSlop(out)).toMatch(/^Edited 2 block\(s\); removed 1 filler paragraph\(s\); patterns before: /);
  });

  it("edits against the same full upstream rule set the writer follows", async () => {
    const ask = reply({ blocks: [{ i: 1, text: "Visitors walk through the old town to [find the harbour](/harbour-walk)." }] });
    await deslopArticle(ask, input);
    const [system] = (ask as unknown as { mock: { calls: string[][] } }).mock.calls[0];
    const rules = system.toLowerCase();
    const all = [...UPSTREAM.bannedWords, ...UPSTREAM.adverbs, ...UPSTREAM.phrases, ...UPSTREAM.patterns];
    expect(all.filter((e) => !rules.includes(e.toLowerCase()))).toEqual([]);
  });

  it("tells the editor to keep the article's language", async () => {
    const ask = reply({ blocks: [{ i: 1, text: "Visitors walk through the old town to [find the harbour](/harbour-walk)." }] });
    await deslopArticle(ask, input);
    const [system] = (ask as unknown as { mock: { calls: string[][] } }).mock.calls[0];
    expect(system).toContain("Keep the article in its original language");
  });

  it("skips the English-only checker for non-English articles", async () => {
    const tr = [block("h", "Girne Limanı", "h2"), block("p", "Liman, it's worth noting, robust bir yer.")];
    const ask = reply({ blocks: [{ i: 1, text: "Liman sakin bir yer." }] });
    const out = await deslopArticle(ask, { title: "Girne", excerpt: "", content: tr, locale: "tr" });
    expect(out.before).toEqual([]);
    expect(out.after).toEqual([]);
    const [, prompt] = (ask as unknown as { mock: { calls: string[][] } }).mock.calls[0];
    expect(prompt).not.toContain("PATTERNS FOUND BY A CHECKER");
    expect(textOf(out.content[1])).toBe("Liman sakin bir yer.");
  });

  it("keeps a block unchanged when its edit loses a link, and never deletes headings", async () => {
    const out = await deslopArticle(
      reply({ blocks: [{ i: 0, text: "" }, { i: 1, text: "Visitors walk through the old town." }, { i: 2, text: "Kyrenia matters." }] }),
      input,
    );
    expect(textOf(out.content[0])).toBe("Why Kyrenia matters");
    expect(linkedHrefs(out.content)).toEqual(new Set(["/harbour-walk"]));
    expect(out.keptBlocks).toBe(2);
    expect(out.editedBlocks).toBe(1);
    expect(out.excerpt).toBe("A robust look at Kyrenia.");
  });

  it("refuses edits that cut too much or return nothing", async () => {
    const long = { ...input, content: [block("a", "x".repeat(400)), block("b", "y".repeat(400))] };
    await expect(deslopArticle(reply({ blocks: [{ i: 0, text: "short" }, { i: 1, text: "" }] }), long)).rejects.toBeInstanceOf(
      SlopEditError,
    );
    await expect(deslopArticle(reply({ nope: true }), input)).rejects.toThrow(/no blocks/);
  });

  it("edits long articles in parts and leaves a failed part as written", async () => {
    const many = Array.from({ length: 14 }, (_, i) => block(`p${i}`, `Paragraph ${i} is robust.`));
    const ask: SlopAsk = vi.fn(async (_s: string, prompt: string) => {
      if (prompt.includes("PART 2 OF")) throw new Error("timeout");
      const blocks = (JSON.parse(prompt.slice(prompt.indexOf("{"))) as { blocks: Array<{ i: number }> }).blocks;
      const json = { excerpt: "E", blocks: blocks.map((b) => ({ i: b.i, text: `Paragraph ${b.i} is solid.` })) };
      return { json, raw: JSON.stringify(json) };
    });
    const out = await deslopArticle(ask, { title: "T", excerpt: "", content: many });
    // 6 + 6 + 2 blocks; the second part times out twice (one retry).
    expect(ask).toHaveBeenCalledTimes(4);
    expect(out.failedParts).toBe(1);
    expect(out.partErrors).toEqual(["timeout"]);
    expect(textOf(out.content[0])).toBe("Paragraph 0 is solid.");
    expect(textOf(out.content[7])).toBe("Paragraph 7 is robust.");
    expect(textOf(out.content[13])).toBe("Paragraph 13 is solid.");
    expect(describeSlop(out)).toContain("1 part(s) could not be edited");
  });

  it("retries a part once after an empty reply", async () => {
    let first = true;
    const ask: SlopAsk = vi.fn(async () => {
      if (first) {
        first = false;
        return { json: "", raw: "" };
      }
      const json = { blocks: [{ i: 2, text: "Kyrenia matters here." }] };
      return { json, raw: JSON.stringify(json) };
    });
    const out = await deslopArticle(ask, input);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(out.failedParts).toBe(0);
    expect(out.editedBlocks).toBe(1);
  });

  it("rethrows a transport error when every part fails, so the job can retry", async () => {
    const ask: SlopAsk = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(deslopArticle(ask, input)).rejects.toThrow("network down");
    await expect(deslopArticle(ask, input)).rejects.not.toBeInstanceOf(SlopEditError);
  });

  it("accepts a bare array reply and string block indexes", async () => {
    const out = await deslopArticle(reply([{ i: "4", text: "Kyrenia is quiet before the day trips arrive." }]), input);
    expect(textOf(out.content[out.content.length - 1])).toBe("Kyrenia is quiet before the day trips arrive.");
    expect(out.excerpt).toBe(input.excerpt);
  });

  it("asks for a long timeout on edit calls", async () => {
    const generateText = vi.fn(async () => ({ json: {}, raw: "{}" }));
    await slopAskFor({ generateText }, defaultSettings)("S", "P");
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 120_000 }));
  });

  it("makes no call when there is no editable text", async () => {
    const ask = reply({});
    const out = await deslopArticle(ask, { title: "T", excerpt: "", content: [{ _type: "image" }] });
    expect(out.editedBlocks).toBe(0);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("slopAskFor", () => {
  it("uses the no-AI-slop model, JSON output and the prompt prefix", async () => {
    const generateText = vi.fn(async () => ({ json: {}, raw: "{}" }));
    const settings = { ...defaultSettings, promptPrefix: "House style.", noAiSlop: { enabled: true, model: "vendor/editor" } };
    await slopAskFor({ generateText }, settings)("RULES", "PROMPT");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vendor/editor", system: "House style.\n\nRULES", prompt: "PROMPT", responseFormat: { type: "json_object" } }),
    );
  });
});
