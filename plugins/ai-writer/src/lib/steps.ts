import { languageFor, type Locale } from "./locale";
import { resolveModel } from "./models";
import type { GenerateTextOutput, OpenRouterClient } from "./openrouter";
import { buildPrompt, type PromptVars } from "./prompts";
import type { Settings } from "./settings";
import type { ContentParams, FaqItem, Mode, ModelOverrides, TermRef, TextSlot } from "./types";

export type StepContext = {
  client: Pick<OpenRouterClient, "generateText">;
  settings: Settings;
  mode: Mode;
  /** Per-rule model overrides (slice 2). Express and the panel leave this unset. */
  ruleModels?: ModelOverrides;
  /** Per-request style/tone; blank values fall back to Settings. */
  params?: ContentParams;
  /** Content locale; sets the writing language (Settings' language is only the fallback). */
  locale?: Locale;
  instructions?: string;
};

export class StepError extends Error {
  constructor(
    public readonly step: TextSlot,
    message: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}

const MAX_TITLE = 120;
const MAX_EXCERPT = 280;
const MAX_META_TITLE = 60;
const MAX_META_DESCRIPTION = 160;
const LIST_PREFIX = /^\s*(?:[-*•]|\d+[.)]|#+)\s*/;
const WRAP_QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;
const HAS_LETTER = /\p{L}/u;

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max).trimEnd();
}

export function cleanLine(line: string): string {
  return line.replace(LIST_PREFIX, "").replace(/\*\*/g, "").replace(WRAP_QUOTES, "").trim();
}

export function cleanTitle(raw: string): string {
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return "";
  return clamp(cleanLine(first.replace(/^title\s*:\s*/i, "")), MAX_TITLE);
}

export function parseHeadings(out: GenerateTextOutput, max: number): string[] {
  let candidates: unknown[] = [];
  if (Array.isArray(out.json)) {
    candidates = out.json;
  } else if (out.json && typeof out.json === "object") {
    const h = (out.json as { headings?: unknown }).headings;
    if (Array.isArray(h)) candidates = h;
  }
  if (candidates.length === 0) candidates = out.raw.split(/\r?\n/);
  const seen = new Set<string>();
  const headings: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const h = cleanLine(c);
    const key = h.toLowerCase();
    if (!h || !HAS_LETTER.test(h) || seen.has(key)) continue;
    seen.add(key);
    headings.push(h);
  }
  return headings.slice(0, max);
}

export function splitParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join(" ")
        .replace(/\*\*/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p.length > 0);
}

function listFrom(out: GenerateTextOutput, key: string): unknown[] | undefined {
  if (Array.isArray(out.json)) return out.json;
  if (out.json && typeof out.json === "object") {
    const v = (out.json as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  return undefined;
}

export function parseFaq(out: GenerateTextOutput): FaqItem[] {
  const items: FaqItem[] = [];
  for (const it of listFrom(out, "items") ?? []) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const q = typeof r.q === "string" ? r.q : typeof r.question === "string" ? r.question : "";
    const a = typeof r.a === "string" ? r.a : typeof r.answer === "string" ? r.answer : "";
    if (q.trim() && a.trim()) items.push({ q: q.trim(), a: a.trim() });
  }
  return items.slice(0, 5);
}

export function matchTags(out: GenerateTextOutput, existing: TermRef[]): string[] {
  const list = listFrom(out, "tags");
  const wanted = list ? list.filter((t): t is string => typeof t === "string") : out.raw.split(/[,\n]/);
  const bySlug = new Map(existing.map((t) => [t.slug.toLowerCase(), t.slug]));
  const byLabel = new Map(existing.map((t) => [t.label.toLowerCase(), t.slug]));
  const result: string[] = [];
  for (const w of wanted) {
    const key = cleanLine(w).toLowerCase();
    const slug = bySlug.get(key) ?? byLabel.get(key);
    if (slug && !result.includes(slug)) result.push(slug);
  }
  return result.slice(0, 6);
}

function baseVars(ctx: StepContext): PromptVars {
  return {
    language: ctx.locale ? languageFor(ctx.locale) : ctx.settings.language,
    style: ctx.params?.style?.trim() || ctx.settings.style,
    tone: ctx.params?.tone?.trim() || ctx.settings.tone,
    instructions: ctx.instructions?.trim() || "",
  };
}

async function callText(
  ctx: StepContext,
  slot: TextSlot,
  vars: PromptVars,
  opts: { model?: string; json?: boolean } = {},
): Promise<GenerateTextOutput> {
  const { model, fallbacks } = resolveModel(slot, {
    request: opts.model,
    rule: ctx.ruleModels,
    settings: ctx.settings.models,
    provider: ctx.settings.providers.text,
  });
  const { system, prompt } = buildPrompt(slot, ctx.mode, { ...baseVars(ctx), ...vars }, ctx.settings);
  return ctx.client.generateText({
    model,
    fallbackModels: fallbacks,
    system,
    prompt,
    temperature: ctx.settings.temperature,
    ...(opts.json ? { responseFormat: { type: "json_object" as const } } : {}),
  });
}

export async function generateTitle(ctx: StepContext, input: { topic: string }, model?: string): Promise<string> {
  const out = await callText(ctx, "title", { topic: input.topic }, { model });
  const title = cleanTitle(out.raw);
  if (!title) throw new StepError("title", "The model returned an empty title");
  return title;
}

export async function generateOutline(
  ctx: StepContext,
  input: { title: string; count: number },
  model?: string,
): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callText(
      ctx,
      "outline",
      { title: input.title, sections_count: String(input.count) },
      { model, json: true },
    );
    const headings = parseHeadings(out, input.count);
    if (headings.length >= 2) return headings;
  }
  throw new StepError("outline", "The model returned fewer than 2 section headings");
}

async function writeSection(
  ctx: StepContext,
  slot: "section" | "rewrite",
  input: { title: string; heading: string; paragraphs: number },
  model?: string,
): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callText(
      ctx,
      slot,
      { title: input.title, section: input.heading, paragraphs: String(input.paragraphs) },
      { model },
    );
    const paragraphs = splitParagraphs(out.raw).slice(0, input.paragraphs);
    if (paragraphs.length > 0) return paragraphs;
  }
  throw new StepError(slot, `The model returned no paragraphs for "${input.heading}"`);
}

export function generateSection(
  ctx: StepContext,
  input: { title: string; heading: string; paragraphs: number },
  model?: string,
): Promise<string[]> {
  return writeSection(ctx, "section", input, model);
}

// Same writer as generateSection, but on the rewrite slot so the editor
// panel's rewrite model and prompt override apply.
export function generateRewrite(
  ctx: StepContext,
  input: { title: string; heading: string; paragraphs: number },
  model?: string,
): Promise<string[]> {
  return writeSection(ctx, "rewrite", input, model);
}

async function paragraphsStep(
  ctx: StepContext,
  slot: "intro" | "outro",
  input: { title: string; headings: string[] },
  model?: string,
): Promise<string[]> {
  const out = await callText(ctx, slot, { title: input.title, headings: input.headings.join("; ") }, { model });
  const paragraphs = splitParagraphs(out.raw).slice(0, 3);
  if (paragraphs.length === 0) throw new StepError(slot, `The model returned an empty ${slot}`);
  return paragraphs;
}

export function generateIntro(ctx: StepContext, input: { title: string; headings: string[] }, model?: string) {
  return paragraphsStep(ctx, "intro", input, model);
}

export function generateOutro(ctx: StepContext, input: { title: string; headings: string[] }, model?: string) {
  return paragraphsStep(ctx, "outro", input, model);
}

export async function generateFaq(ctx: StepContext, input: { title: string }, model?: string): Promise<FaqItem[]> {
  const out = await callText(ctx, "faq", { title: input.title }, { model, json: true });
  const items = parseFaq(out);
  if (items.length === 0) throw new StepError("faq", "The model returned no FAQ items");
  return items;
}

export async function generateExcerpt(
  ctx: StepContext,
  input: { title: string; headings: string[] },
  model?: string,
): Promise<string> {
  const out = await callText(ctx, "excerpt", { title: input.title, headings: input.headings.join("; ") }, { model });
  const excerpt = clamp(splitParagraphs(out.raw).join(" ").replace(WRAP_QUOTES, "").trim(), MAX_EXCERPT);
  if (!excerpt) throw new StepError("excerpt", "The model returned an empty excerpt");
  return excerpt;
}

export async function generateTags(
  ctx: StepContext,
  input: { title: string; existing: TermRef[] },
  model?: string,
): Promise<string[]> {
  if (input.existing.length === 0) return [];
  const out = await callText(
    ctx,
    "tags",
    { title: input.title, existing_tags: input.existing.map((t) => t.label).join(", ") },
    { model, json: true },
  );
  return matchTags(out, input.existing);
}

const MAX_IMAGE_PROMPT = 600;

/** A photographic description for the featured image, written by the text model. */
export async function generateImagePrompt(ctx: StepContext, input: { title: string }, model?: string): Promise<string> {
  const out = await callText(ctx, "imagePrompt", { title: input.title }, { model });
  const prompt = clamp(splitParagraphs(out.raw).join(" ").replace(WRAP_QUOTES, "").trim(), MAX_IMAGE_PROMPT);
  if (!prompt) throw new StepError("imagePrompt", "The model returned an empty image description");
  return prompt;
}

export type SeoMeta = { metaTitle: string; metaDescription: string };

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function parseSeo(out: GenerateTextOutput): SeoMeta {
  const obj =
    out.json && typeof out.json === "object" && !Array.isArray(out.json) ? (out.json as Record<string, unknown>) : {};
  return {
    metaTitle: clamp(cleanLine(firstString(obj, ["metaTitle", "meta_title", "title"])), MAX_META_TITLE),
    metaDescription: clamp(
      cleanLine(firstString(obj, ["metaDescription", "meta_description", "description"])),
      MAX_META_DESCRIPTION,
    ),
  };
}

export async function generateSeo(
  ctx: StepContext,
  input: { title: string; excerpt: string },
  model?: string,
): Promise<SeoMeta> {
  const out = await callText(ctx, "seo", { title: input.title, excerpt: input.excerpt }, { model, json: true });
  const seo = parseSeo(out);
  if (!seo.metaTitle || !seo.metaDescription) throw new StepError("seo", "The model returned incomplete SEO meta");
  return seo;
}
