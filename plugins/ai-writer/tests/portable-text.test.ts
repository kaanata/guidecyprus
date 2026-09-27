import { describe, expect, it } from "vitest";
import { blockText, headingsOf, rewriteOutline } from "../src/lib/portable-text";

const block = (style: string, text: string, listItem?: string) => ({
  _type: "block",
  _key: `k-${text}`,
  style,
  markDefs: [],
  ...(listItem ? { listItem, level: 1 } : {}),
  children: [{ _type: "span", _key: "s", text, marks: [] }],
});

describe("blockText", () => {
  it("joins span text and trims", () => {
    expect(
      blockText({
        _type: "block",
        children: [
          { _type: "span", text: " Hello " },
          { _type: "span", text: "world " },
        ],
      }),
    ).toBe("Hello world");
  });

  it("returns an empty string for non-blocks", () => {
    expect(blockText(null)).toBe("");
    expect(blockText({ _type: "image" })).toBe("");
    expect(blockText({ _type: "block", children: "x" })).toBe("");
  });
});

describe("headingsOf", () => {
  it("returns heading texts of the given style, skipping list items and other types", () => {
    const content = [
      block("h2", "One"),
      block("normal", "Body"),
      block("h2", "Two", "bullet"),
      { _type: "image", style: "h2" },
      block("h3", "Sub"),
      block("h2", "Three"),
    ];
    expect(headingsOf(content, "h2")).toEqual(["One", "Three"]);
    expect(headingsOf(content, "h3")).toEqual(["Sub"]);
    expect(headingsOf("not an array", "h2")).toEqual([]);
  });
});

describe("rewriteOutline", () => {
  it("uses h2 section headings and drops TOC, FAQ and Conclusion headers", () => {
    const content = [
      block("h2", "Table of Contents"),
      block("h2", "Kyrenia Harbour"),
      block("h2", "Bellapais Abbey"),
      block("h2", "faq"),
      block("h3", "When to visit?"),
      block("h2", "Conclusion"),
    ];
    expect(rewriteOutline(content)).toEqual(["Kyrenia Harbour", "Bellapais Abbey"]);
  });

  it("drops the Turkish TOC, FAQ and Conclusion headers too", () => {
    const content = [
      block("h2", "İçindekiler"),
      block("h2", "Girne Limanı"),
      block("h2", "Bellapais Manastırı"),
      block("h2", "Sıkça Sorulan Sorular"),
      block("h3", "Ne zaman gidilir?"),
      block("h2", "SONUÇ"),
    ];
    expect(rewriteOutline(content)).toEqual(["Girne Limanı", "Bellapais Manastırı"]);
  });

  it("falls back to h3 headings when there are fewer than two h2 sections", () => {
    const content = [block("h2", "Only One"), block("h3", "Alpha"), block("h3", "Beta")];
    expect(rewriteOutline(content)).toEqual(["Alpha", "Beta"]);
  });

  it("returns the short h2 list when neither level has two headings", () => {
    expect(rewriteOutline([block("h2", "Only One"), block("h3", "Alone")])).toEqual(["Only One"]);
    expect(rewriteOutline(undefined)).toEqual([]);
  });
});
