import { describe, expect, it } from "vitest";
import { assemble, defaultStructure, structureFor } from "../src/lib/assemble";
import type { ArticleParts, PortableTextBlock } from "../src/lib/types";

const parts: ArticleParts = {
  title: "T",
  intro: ["Intro."],
  sections: [
    { heading: "First", paragraphs: ["P1.", "P2."] },
    { heading: "Second", paragraphs: ["P3."] },
    { heading: "Empty", paragraphs: [] },
  ],
  outro: ["Bye."],
  faq: [{ q: "Why?", a: "Because." }],
};

const shape = (blocks: PortableTextBlock[]) => blocks.map((b) => [b.style, b.children.map((c) => c.text).join("")]);

describe("assemble", () => {
  it("orders intro, sections, FAQ, and outro with default headers", () => {
    expect(shape(assemble(parts, defaultStructure))).toEqual([
      ["normal", "Intro."],
      ["h2", "First"],
      ["normal", "P1."],
      ["normal", "P2."],
      ["h2", "Second"],
      ["normal", "P3."],
      ["h2", "FAQ"],
      ["h3", "Why?"],
      ["normal", "Because."],
      ["h2", "Conclusion"],
      ["normal", "Bye."],
    ]);
  });

  it("adds a bullet-list table of contents after the intro", () => {
    const blocks = assemble(parts, { ...defaultStructure, toc: true });
    expect(shape(blocks).slice(1, 4)).toEqual([
      ["h2", "Table of Contents"],
      ["normal", "First"],
      ["normal", "Second"],
    ]);
    expect(blocks[2]).toMatchObject({ listItem: "bullet", level: 1 });
    expect(blocks[1].listItem).toBeUndefined();
  });

  it("localises the structural headers per locale", () => {
    expect(structureFor("en")).toEqual(defaultStructure);
    const tr = structureFor("tr");
    expect([tr.tocHeader, tr.faqHeader, tr.outroHeader]).toEqual(["İçindekiler", "Sıkça Sorulan Sorular", "Sonuç"]);
    const texts = shape(assemble(parts, { ...tr, toc: true })).map(([, text]) => text);
    expect(texts).toContain("İçindekiler");
    expect(texts).toContain("Sıkça Sorulan Sorular");
    expect(texts.at(-2)).toBe("Sonuç");
  });

  it("uses h3 for section headings when asked", () => {
    const blocks = assemble(parts, { ...defaultStructure, headingLevel: "h3" });
    expect(shape(blocks)[1]).toEqual(["h3", "First"]);
  });

  it("omits the FAQ and outro when they are empty, and skips blank paragraphs", () => {
    const blocks = assemble({ ...parts, faq: [], outro: [], intro: ["  "] }, defaultStructure);
    expect(shape(blocks).map(([, text]) => text)).toEqual(["First", "P1.", "P2.", "Second", "P3."]);
  });

  it("gives every block and span a unique key and empty marks", () => {
    const blocks = assemble(parts, { ...defaultStructure, toc: true });
    const keys = blocks.flatMap((b) => [b._key, ...b.children.map((c) => c._key)]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of blocks) {
      expect(b._type).toBe("block");
      expect(b.markDefs).toEqual([]);
      for (const c of b.children) expect(c.marks).toEqual([]);
    }
  });
});
