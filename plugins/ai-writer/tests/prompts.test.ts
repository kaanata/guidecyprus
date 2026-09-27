import { describe, expect, it } from "vitest";
import { buildPrompt, DEFAULT_PROMPTS, renderTemplate, SYSTEM_BASE } from "../src/lib/prompts";
import { defaultSettings } from "../src/lib/settings";
import { SLOP_GUIDE } from "../src/lib/slop";
import { TEXT_SLOTS } from "../src/lib/types";

describe("renderTemplate", () => {
  it("substitutes known variables", () => {
    expect(renderTemplate('About "%%topic%%" in %%language%%.', { topic: "tea", language: "English" })).toBe(
      'About "tea" in English.',
    );
  });

  it("replaces missing variables with nothing and collapses the gap", () => {
    expect(renderTemplate("A %%instructions%% B", {})).toBe("A B");
  });

  it("never leaves %% markers, even for unknown names", () => {
    expect(renderTemplate("x %%not_a_var%% y", {})).not.toContain("%%");
  });
});

describe("buildPrompt", () => {
  it("has a default article prompt for every text slot", () => {
    for (const slot of TEXT_SLOTS) expect(DEFAULT_PROMPTS.article[slot].length).toBeGreaterThan(20);
  });

  it("uses the default template when no override is set", () => {
    const { prompt } = buildPrompt(
      "title",
      "article",
      { topic: "green tea", language: "English", style: "Informative", tone: "Neutral" },
      defaultSettings,
    );
    expect(prompt).toContain('"green tea"');
    expect(prompt).not.toContain("%%");
  });

  it("uses a non-blank override", () => {
    const settings = { ...defaultSettings, promptOverrides: { article: { title: "Custom %%topic%%" } } };
    expect(buildPrompt("title", "article", { topic: "x" }, settings).prompt).toBe("Custom x");
  });

  it("ignores a blank override", () => {
    const settings = { ...defaultSettings, promptOverrides: { article: { title: "   " } } };
    expect(buildPrompt("title", "article", { topic: "x" }, settings).prompt).toContain('"x"');
  });

  it("puts the global prefix before the base system message", () => {
    const off = { ...defaultSettings, noAiSlop: { enabled: false, model: "" } };
    const settings = { ...off, promptPrefix: "Write like a seasoned travel writer." };
    expect(buildPrompt("title", "article", {}, settings).system).toBe(
      `Write like a seasoned travel writer.\n\n${SYSTEM_BASE}`,
    );
    expect(buildPrompt("title", "article", {}, off).system).toBe(SYSTEM_BASE);
  });

  it("adds the no-AI-slop guide to writing prompts when it is on, but not to the image description", () => {
    expect(buildPrompt("section", "article", {}, defaultSettings).system).toBe(`${SYSTEM_BASE}\n\n${SLOP_GUIDE}`);
    expect(buildPrompt("imagePrompt", "article", {}, defaultSettings).system).toBe(SYSTEM_BASE);
  });
});
