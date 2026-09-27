import { z } from "zod";
import {
  DEFAULT_PROVIDERS,
  modelBelongsTo,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  PROVIDERS,
  type Provider,
} from "./providers";
import { TEXT_SLOTS } from "./types";

const modelId = z.string().trim().max(200);
const provider = z.enum(PROVIDERS);

export const MAX_LINKS = 10;

// Internal linking: when a post is published, it links to related older
// posts and related older posts link back to it (see lib/internal-links.ts).
export const internalLinksSchema = z.object({
  enabled: z.boolean(),
  maxOutbound: z.number().int().min(0).max(MAX_LINKS),
  maxInbound: z.number().int().min(0).max(MAX_LINKS),
  collections: z
    .array(z.string().trim().regex(/^[a-z][a-z0-9_]*$/))
    .min(1)
    .max(10),
  // Public URL of an entry; {localePrefix} ("" for English, "/tr" for
  // Turkish), {collection} and {slug} are replaced.
  pathPattern: z
    .string()
    .trim()
    .max(200)
    .refine(
      (p) => (p.startsWith("/") || p.startsWith("{localePrefix}/")) && p.includes("{slug}"),
      "Start with / or {localePrefix}/ and include {slug}",
    ),
  // Blank = the default text model.
  model: modelId,
});
export type InternalLinkSettings = z.infer<typeof internalLinksSchema>;

// No-AI-slop: rules in every writing prompt plus one edit pass per article
// (see lib/slop.ts).
export const noAiSlopSchema = z.object({
  enabled: z.boolean(),
  // Blank = the default text model.
  model: modelId,
});
export type NoAiSlopSettings = z.infer<typeof noAiSlopSchema>;
export const DEFAULT_NO_AI_SLOP: NoAiSlopSettings = { enabled: true, model: "" };

// Warn in the admin when OpenRouter credit drops below this many USD (0 = off).
export const usageAlertsSchema = z.object({ lowCredit: z.number().min(0).max(10_000) });
export const DEFAULT_USAGE_ALERTS = { lowCredit: 2 };

// The inherited default, which gives /posts/{slug}: this site serves posts at /{slug}.
const LEGACY_PATH_PATTERN = "/{collection}/{slug}";

export const DEFAULT_INTERNAL_LINKS: InternalLinkSettings = {
  enabled: true,
  maxOutbound: 5,
  maxInbound: 5,
  collections: ["posts"],
  // English posts at /{slug}, Turkish posts at /tr/{slug}.
  pathPattern: "{localePrefix}/{slug}",
  model: "",
};

export const settingsSchema = z
  .object({
    // Which provider generates text and which generates images. Payloads
    // saved before providers existed read as OpenRouter for both.
    providers: z.object({ text: provider, image: provider }).default(() => ({ ...DEFAULT_PROVIDERS })),
    models: z.object({
      defaultText: modelId.min(1),
      fallbackText: modelId,
      defaultImage: modelId.min(1),
      // Empty string = "use the default" (the Settings form sends blanks).
      steps: z.partialRecord(z.enum(TEXT_SLOTS), modelId),
    }),
    imageSize: z.object({
      width: z.number().int().min(256).max(4096),
      height: z.number().int().min(256).max(4096),
    }),
    language: z.string().trim().min(1).max(40),
    style: z.string().trim().min(1).max(60),
    tone: z.string().trim().min(1).max(60),
    temperature: z.number().min(0).max(2),
    promptPrefix: z.string().max(2000),
    promptOverrides: z.object({
      article: z.partialRecord(z.enum(TEXT_SLOTS), z.string().max(4000)),
    }),
    internalLinks: internalLinksSchema.default(() => structuredClone(DEFAULT_INTERNAL_LINKS)),
    noAiSlop: noAiSlopSchema.default(() => ({ ...DEFAULT_NO_AI_SLOP })),
    usageAlerts: usageAlertsSchema.default(() => ({ ...DEFAULT_USAGE_ALERTS })),
  })
  // A model id must belong to the provider it is sent to; blanks ("use the
  // default") always pass.
  .superRefine((s, ctx) => {
    const check = (p: Provider, path: string[], id: string | undefined) => {
      if (!modelBelongsTo(p, id)) {
        ctx.addIssue({ code: "custom", path, message: `"${id}" is not a ${PROVIDER_LABELS[p]} model` });
      }
    };
    check(s.providers.text, ["models", "defaultText"], s.models.defaultText);
    check(s.providers.text, ["models", "fallbackText"], s.models.fallbackText);
    for (const [slot, id] of Object.entries(s.models.steps)) {
      check(s.providers.text, ["models", "steps", slot], id);
    }
    check(s.providers.image, ["models", "defaultImage"], s.models.defaultImage);
    check(s.providers.text, ["internalLinks", "model"], s.internalLinks.model);
    check(s.providers.text, ["noAiSlop", "model"], s.noAiSlop.model);
  });

export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS_KEY = "settings";

export const defaultSettings: Settings = {
  providers: { ...DEFAULT_PROVIDERS },
  models: { ...PROVIDER_DEFAULTS.openrouter, steps: {} },
  imageSize: { width: 1200, height: 800 },
  language: "English",
  style: "Informative",
  tone: "Neutral",
  temperature: 0.7,
  promptPrefix: "",
  promptOverrides: { article: {} },
  internalLinks: structuredClone(DEFAULT_INTERNAL_LINKS),
  noAiSlop: { ...DEFAULT_NO_AI_SLOP },
  usageAlerts: { ...DEFAULT_USAGE_ALERTS },
};

export type KvLike = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Stored values are merged over defaults one level deep (providers, models,
// imageSize, promptOverrides) so a field added in a later version picks up its
// default instead of failing validation for older stored payloads.
export function mergeSettings(stored: unknown): Settings {
  const base = structuredClone(defaultSettings);
  if (!isObject(stored)) return base;
  const merged = {
    ...base,
    ...stored,
    providers: { ...base.providers, ...(isObject(stored.providers) ? stored.providers : {}) },
    models: { ...base.models, ...(isObject(stored.models) ? stored.models : {}) },
    imageSize: { ...base.imageSize, ...(isObject(stored.imageSize) ? stored.imageSize : {}) },
    promptOverrides: {
      ...base.promptOverrides,
      ...(isObject(stored.promptOverrides) ? stored.promptOverrides : {}),
    },
    internalLinks: { ...base.internalLinks, ...(isObject(stored.internalLinks) ? stored.internalLinks : {}) },
    noAiSlop: { ...base.noAiSlop, ...(isObject(stored.noAiSlop) ? stored.noAiSlop : {}) },
    usageAlerts: { ...base.usageAlerts, ...(isObject(stored.usageAlerts) ? stored.usageAlerts : {}) },
  };
  if (merged.internalLinks.pathPattern === LEGACY_PATH_PATTERN) {
    merged.internalLinks.pathPattern = DEFAULT_INTERNAL_LINKS.pathPattern;
  }
  // Repair (rather than reject) a stored model id that doesn't belong to its
  // provider — e.g. an OpenRouter-era id left over after switching to MiniMax
  // — so the cross-field check below doesn't fail safeParse and wipe every
  // other field back to defaults. Writes still reject mismatched ids via the
  // schema; this only smooths over what's already on disk.
  const providersField: unknown = merged.providers;
  const modelsField: unknown = merged.models;
  if (
    isObject(providersField) &&
    PROVIDERS.includes(providersField.text as Provider) &&
    PROVIDERS.includes(providersField.image as Provider) &&
    isObject(modelsField)
  ) {
    const text = providersField.text as Provider;
    const image = providersField.image as Provider;
    const models = modelsField;
    if (isObject(models.steps)) {
      const steps = { ...models.steps };
      for (const slot of Object.keys(steps)) {
        if (typeof steps[slot] === "string" && !modelBelongsTo(text, steps[slot] as string)) delete steps[slot];
      }
      models.steps = steps;
    }
    if (typeof models.fallbackText === "string" && !modelBelongsTo(text, models.fallbackText)) {
      models.fallbackText = "";
    }
    if (typeof models.defaultText === "string" && !modelBelongsTo(text, models.defaultText)) {
      models.defaultText = PROVIDER_DEFAULTS[text].defaultText;
    }
    if (typeof models.defaultImage === "string" && !modelBelongsTo(image, models.defaultImage)) {
      models.defaultImage = PROVIDER_DEFAULTS[image].defaultImage;
    }
    const links = merged.internalLinks;
    if (typeof links.model === "string" && !modelBelongsTo(text, links.model)) links.model = "";
    const slop = merged.noAiSlop;
    if (typeof slop.model === "string" && !modelBelongsTo(text, slop.model)) slop.model = "";
  }
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

export async function readSettings(kv: KvLike): Promise<Settings> {
  return mergeSettings(await kv.get<unknown>(SETTINGS_KEY));
}

export async function writeSettings(kv: KvLike, input: unknown): Promise<Settings> {
  const settings = settingsSchema.parse(input);
  await kv.set(SETTINGS_KEY, settings);
  return settings;
}
