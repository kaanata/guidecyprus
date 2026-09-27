import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings, readSettings, SETTINGS_KEY, settingsSchema, writeSettings } from "../src/lib/settings";
import { memoryKv } from "./helpers";

describe("settings", () => {
  it("documents the default models and generation params", () => {
    expect(defaultSettings.models).toEqual({
      defaultText: "meta/muse-spark-1.3-contributor",
      fallbackText: "qwen/qwen3.8-flash",
      defaultImage: "bytedance-seed/seedream-5-0-lite",
      steps: {},
    });
    expect(defaultSettings.imageSize).toEqual({ width: 1200, height: 800 });
    expect(defaultSettings.temperature).toBe(0.7);
    expect(defaultSettings.language).toBe("English");
  });

  it("readSettings returns defaults when KV is empty", async () => {
    expect(await readSettings(memoryKv())).toEqual(defaultSettings);
  });

  it("merges a partial stored models object over defaults", async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: { models: { defaultText: "x/y" } } });
    const s = await readSettings(kv);
    expect(s.models.defaultText).toBe("x/y");
    expect(s.models.defaultImage).toBe(defaultSettings.models.defaultImage);
    expect(s.language).toBe("English");
  });

  it("falls back to defaults when the stored payload is invalid", () => {
    expect(mergeSettings({ temperature: 9 })).toEqual(defaultSettings);
    expect(mergeSettings("garbage")).toEqual(defaultSettings);
  });

  it("writeSettings validates, persists, and returns the parsed value", async () => {
    const kv = memoryKv();
    const next = {
      ...defaultSettings,
      tone: "Playful",
      models: { ...defaultSettings.models, steps: { title: "a/b" } },
    };
    const saved = await writeSettings(kv, next);
    expect(saved.tone).toBe("Playful");
    expect(saved.models.steps.title).toBe("a/b");
    expect(kv.map.get(SETTINGS_KEY)).toEqual(saved);
  });

  it("writeSettings rejects out-of-range values", async () => {
    await expect(writeSettings(memoryKv(), { ...defaultSettings, temperature: 5 })).rejects.toThrow();
  });

  it("mergeSettings returns a copy, never the shared defaults object", () => {
    const a = mergeSettings(null);
    a.models.steps.title = "mutated";
    expect(defaultSettings.models.steps.title).toBeUndefined();
  });
});

describe("settings providers", () => {
  const minimaxText = {
    ...defaultSettings,
    providers: { text: "minimax" as const, image: "openrouter" as const },
    models: { ...defaultSettings.models, defaultText: "MiniMax-M3", fallbackText: "", steps: { title: "" } },
  };

  it("defaults both providers to OpenRouter", () => {
    expect(defaultSettings.providers).toEqual({ text: "openrouter", image: "openrouter" });
  });

  it("reads a payload saved before providers existed as OpenRouter", () => {
    const s = mergeSettings({ models: { defaultText: "x/y" } });
    expect(s.providers).toEqual({ text: "openrouter", image: "openrouter" });
    expect(s.models.defaultText).toBe("x/y");
  });

  it("merges a partial providers object over the defaults", () => {
    const s = mergeSettings({ providers: { image: "minimax" }, models: { defaultImage: "image-01" } });
    expect(s.providers).toEqual({ text: "openrouter", image: "minimax" });
    expect(s.models.defaultImage).toBe("image-01");
  });

  it("accepts MiniMax model ids when MiniMax is the text provider", async () => {
    const saved = await writeSettings(memoryKv(), minimaxText);
    expect(saved.providers.text).toBe("minimax");
    expect(saved.models.defaultText).toBe("MiniMax-M3");
  });

  it("rejects a text model that belongs to the other provider", () => {
    const r = settingsSchema.safeParse({
      ...minimaxText,
      models: { ...minimaxText.models, defaultText: "meta/muse-spark-1.3-contributor" },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({
      path: ["models", "defaultText"],
      message: '"meta/muse-spark-1.3-contributor" is not a MiniMax model',
    });
  });

  it("rejects a per-step model and an image model from the other provider", () => {
    const step = settingsSchema.safeParse({
      ...minimaxText,
      models: { ...minimaxText.models, steps: { outline: "google/gemini-3.8-flash" } },
    });
    expect(step.error?.issues[0]).toMatchObject({ path: ["models", "steps", "outline"] });
    const image = settingsSchema.safeParse({
      ...defaultSettings,
      providers: { text: "openrouter", image: "minimax" },
    });
    expect(image.error?.issues[0]).toMatchObject({
      path: ["models", "defaultImage"],
      message: '"bytedance-seed/seedream-5-0-lite" is not a MiniMax model',
    });
  });

  it("accepts a POST without providers (older admin) as OpenRouter", async () => {
    const legacy: Record<string, unknown> = { ...defaultSettings };
    delete legacy.providers;
    const saved = await writeSettings(memoryKv(), legacy);
    expect(saved.providers).toEqual({ text: "openrouter", image: "openrouter" });
  });

  it("repairs a per-step id left over from OpenRouter instead of wiping the whole payload", () => {
    const s = mergeSettings({
      models: { defaultText: "x/y", steps: { title: "gpt-4o", outline: "a/b" } },
      language: "Turkish",
      promptOverrides: { article: { title: "Custom %%topic%%" } },
    });
    expect(s.language).toBe("Turkish");
    expect(s.promptOverrides.article.title).toBe("Custom %%topic%%");
    expect(s.models.defaultText).toBe("x/y");
    expect(s.models.steps).toEqual({ outline: "a/b" });
  });

  it("repairs every OpenRouter-shaped id after switching both providers to MiniMax", () => {
    const s = mergeSettings({
      providers: { text: "minimax", image: "minimax" },
      models: {
        defaultText: "meta/muse-spark-1.3-contributor",
        fallbackText: "qwen/qwen3.8-flash",
        defaultImage: "bytedance-seed/seedream-5-0-lite",
        steps: { tags: "a/b" },
      },
      tone: "Playful",
    });
    expect(s.providers).toEqual({ text: "minimax", image: "minimax" });
    expect(s.models.defaultText).toBe("MiniMax-M3");
    expect(s.models.fallbackText).toBe("");
    expect(s.models.defaultImage).toBe("image-01");
    expect(s.models.steps).toEqual({});
    expect(s.tone).toBe("Playful");
  });

  it("does not mutate the stored payload while repairing ids", () => {
    const stored = { models: { defaultText: "x/y", steps: { title: "gpt-4o" } } };
    mergeSettings(stored);
    expect(stored.models.steps).toEqual({ title: "gpt-4o" });
  });

  it("writeSettings still rejects a mismatched id (unaffected by mergeSettings repair)", () => {
    const r = settingsSchema.safeParse({
      ...minimaxText,
      models: { ...minimaxText.models, defaultText: "meta/muse-spark-1.3-contributor" },
    });
    expect(r.success).toBe(false);
  });
});

describe("internal link settings", () => {
  it("defaults to on, five links each way, posts only", () => {
    expect(defaultSettings.internalLinks).toEqual({
      enabled: true,
      maxOutbound: 5,
      maxInbound: 5,
      collections: ["posts"],
      pathPattern: "{localePrefix}/{slug}",
      model: "",
    });
  });

  it("accepts locale-prefixed and plain path patterns", async () => {
    const kv = memoryKv();
    for (const pathPattern of ["{localePrefix}/{slug}", "{localePrefix}/guide/{slug}", "/{collection}/{slug}/"]) {
      const s = await writeSettings(kv, { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, pathPattern } });
      expect(s.internalLinks.pathPattern).toBe(pathPattern);
    }
    await expect(
      writeSettings(kv, { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, pathPattern: "{slug}" } }),
    ).rejects.toThrow();
  });

  it("moves the old /{collection}/{slug} default to the locale-aware one", () => {
    expect(mergeSettings({ internalLinks: { pathPattern: "/{collection}/{slug}" } }).internalLinks.pathPattern).toBe(
      "{localePrefix}/{slug}",
    );
    expect(mergeSettings({ internalLinks: { pathPattern: "/blog/{slug}" } }).internalLinks.pathPattern).toBe("/blog/{slug}");
  });

  it("fills internal links into payloads saved before the feature and merges partial objects", () => {
    expect(mergeSettings({ language: "Turkish" }).internalLinks).toEqual(defaultSettings.internalLinks);
    expect(mergeSettings({ internalLinks: { maxInbound: 2 } }).internalLinks).toMatchObject({ maxInbound: 2, maxOutbound: 5 });
  });

  it("rejects a path without {slug} and a linking model from the other provider", async () => {
    const kv = memoryKv();
    await expect(
      writeSettings(kv, { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, pathPattern: "/posts/" } }),
    ).rejects.toThrow();
    await expect(
      writeSettings(kv, { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, model: "MiniMax-M3" } }),
    ).rejects.toThrow();
  });

  it("repairs a stored linking model left over from another provider", () => {
    const merged = mergeSettings({
      providers: { text: "minimax", image: "openrouter" },
      models: { defaultText: "MiniMax-M3", fallbackText: "", defaultImage: "bytedance-seed/seedream-5-0-lite", steps: {} },
      internalLinks: { model: "vendor/old" },
    });
    expect(merged.providers.text).toBe("minimax");
    expect(merged.internalLinks.model).toBe("");
  });
});
