import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDERS,
  MINIMAX_CATALOG,
  modelBelongsTo,
  PROVIDER_DEFAULTS,
  PROVIDER_KEY_NAMES,
  PROVIDER_LABELS,
  PROVIDERS,
} from "../src/lib/providers";

describe("providers", () => {
  it("names both providers, their labels and key variables", () => {
    expect(PROVIDERS).toEqual(["openrouter", "minimax"]);
    expect(PROVIDER_LABELS).toEqual({ openrouter: "OpenRouter", minimax: "MiniMax" });
    expect(PROVIDER_KEY_NAMES).toEqual({ openrouter: "OPENROUTER_API_KEY", minimax: "MINIMAX_API_KEY" });
    expect(DEFAULT_PROVIDERS).toEqual({ text: "openrouter", image: "openrouter" });
  });

  it("treats slash ids as OpenRouter and slash-free ids as MiniMax", () => {
    expect(modelBelongsTo("openrouter", "google/gemini-3.8-flash")).toBe(true);
    expect(modelBelongsTo("openrouter", "MiniMax-M3")).toBe(false);
    expect(modelBelongsTo("minimax", "MiniMax-M3")).toBe(true);
    expect(modelBelongsTo("minimax", "minimax/minimax-m3")).toBe(false);
  });

  it("lets a blank id belong to every provider", () => {
    for (const p of PROVIDERS) {
      expect(modelBelongsTo(p, "")).toBe(true);
      expect(modelBelongsTo(p, "   ")).toBe(true);
      expect(modelBelongsTo(p, undefined)).toBe(true);
    }
  });

  it("keeps each provider's defaults and the MiniMax catalog consistent", () => {
    for (const p of PROVIDERS) {
      const d = PROVIDER_DEFAULTS[p];
      expect(modelBelongsTo(p, d.defaultText)).toBe(true);
      expect(modelBelongsTo(p, d.fallbackText)).toBe(true);
      expect(modelBelongsTo(p, d.defaultImage)).toBe(true);
    }
    expect(PROVIDER_DEFAULTS.minimax).toEqual({
      defaultText: "MiniMax-M3",
      fallbackText: "MiniMax-M2.7",
      defaultImage: "image-01",
    });
    expect(MINIMAX_CATALOG.text.map((m) => m.id)).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ]);
    expect(MINIMAX_CATALOG.image).toEqual([{ id: "image-01", name: "image-01" }]);
  });
});
