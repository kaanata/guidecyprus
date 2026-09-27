import { describe, expect, it } from "vitest";
import { missingKeyNames, switchProvider } from "../src/admin/settings-state";
import { defaultSettings, settingsSchema } from "../src/lib/settings";

describe("switchProvider", () => {
  const start = { ...defaultSettings, models: { ...defaultSettings.models, steps: { title: "a/b" } } };

  it("resets the text models and per-step models to the new provider's defaults", () => {
    const next = switchProvider(start, "text", "minimax");
    expect(next.providers).toEqual({ text: "minimax", image: "openrouter" });
    expect(next.models).toEqual({
      defaultText: "MiniMax-M3",
      fallbackText: "MiniMax-M2.7",
      defaultImage: "bytedance-seed/seedream-5-0-lite",
      steps: {},
    });
    expect(start.providers.text).toBe("openrouter");
  });

  it("resets only the image model when the image provider changes", () => {
    const next = switchProvider(start, "image", "minimax");
    expect(next.providers).toEqual({ text: "openrouter", image: "minimax" });
    expect(next.models).toEqual({ ...start.models, defaultImage: "image-01" });
  });

  it("switching back restores the OpenRouter defaults", () => {
    const minimax = switchProvider(defaultSettings, "text", "minimax");
    expect(switchProvider(minimax, "text", "openrouter").models).toEqual(defaultSettings.models);
  });

  it("returns the same object when the provider is unchanged", () => {
    expect(switchProvider(defaultSettings, "text", "openrouter")).toBe(defaultSettings);
  });

  it("always produces settings the schema accepts", () => {
    for (const kind of ["text", "image"] as const) {
      expect(settingsSchema.safeParse(switchProvider(start, kind, "minimax")).success).toBe(true);
    }
  });
});

describe("missingKeyNames", () => {
  it("names each selected provider without a bound key, once", () => {
    expect(missingKeyNames({ text: "minimax", image: "openrouter" }, { openrouter: true, minimax: false })).toEqual([
      "MINIMAX_API_KEY",
    ]);
    expect(missingKeyNames({ text: "minimax", image: "minimax" }, { openrouter: true, minimax: false })).toEqual([
      "MINIMAX_API_KEY",
    ]);
    expect(missingKeyNames({ text: "openrouter", image: "minimax" }, { openrouter: false, minimax: false })).toEqual([
      "OPENROUTER_API_KEY",
      "MINIMAX_API_KEY",
    ]);
  });

  it("ignores unselected providers and an unknown key state", () => {
    expect(missingKeyNames({ text: "openrouter", image: "openrouter" }, { openrouter: true, minimax: false })).toEqual(
      [],
    );
    expect(missingKeyNames({ text: "minimax", image: "minimax" }, null)).toEqual([]);
  });
});

describe("switchProvider and internal links", () => {
  it("clears the linking model when the text provider changes", () => {
    const withModel = { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, model: "vendor/linker" } };
    expect(switchProvider(withModel, "text", "minimax").internalLinks.model).toBe("");
    expect(switchProvider(withModel, "image", "minimax").internalLinks.model).toBe("vendor/linker");
  });
});
