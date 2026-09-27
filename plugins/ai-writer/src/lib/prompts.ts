import type { Settings } from "./settings";
import { SLOP_GUIDE } from "./slop";
import type { Mode, TextSlot } from "./types";

export const PROMPT_VARS = [
  "topic",
  "title",
  "section",
  "sections_count",
  "paragraphs",
  "headings",
  "excerpt",
  "existing_tags",
  "language",
  "style",
  "tone",
  "instructions",
] as const;
export type PromptVar = (typeof PROMPT_VARS)[number];
export type PromptVars = Partial<Record<PromptVar, string>>;

export const SYSTEM_BASE =
  "You are a professional writer. Return only the content you are asked for: no preamble, no explanations, no markdown syntax, and no quotation marks around the answer.";

const SECTION_PROMPT =
  'Write the body of the section "%%section%%" for an article titled "%%title%%" in %%language%%. Write exactly %%paragraphs%% paragraphs separated by a blank line. Style: %%style%%. Tone: %%tone%%. Do not repeat the heading and do not write an introduction or conclusion for the whole article. %%instructions%%';

export const DEFAULT_PROMPTS: Record<Mode, Record<TextSlot, string>> = {
  article: {
    title:
      'Write one compelling, SEO-friendly title for an article about "%%topic%%" in %%language%%. Style: %%style%%. Tone: %%tone%%. Maximum 12 words. %%instructions%% Return only the title.',
    outline:
      'Create %%sections_count%% section headings for an article titled "%%title%%" in %%language%%. Each heading is short (3-8 words), covers a distinct subtopic, and follows a logical order. Do not include an introduction or conclusion heading. %%instructions%% Return JSON: {"headings": ["..."]}',
    section: SECTION_PROMPT,
    intro:
      'Write a 2-paragraph introduction for an article titled "%%title%%" in %%language%% that covers: %%headings%%. Style: %%style%%. Tone: %%tone%%. Separate paragraphs with a blank line. No heading. %%instructions%%',
    outro:
      'Write a short 1-2 paragraph conclusion for an article titled "%%title%%" in %%language%% that covered: %%headings%%. Style: %%style%%. Tone: %%tone%%. No new information and no heading. Separate paragraphs with a blank line. %%instructions%%',
    faq:
      'Write 3 frequently asked questions with concise answers (2-3 sentences each) for an article titled "%%title%%" in %%language%%. Tone: %%tone%%. %%instructions%% Return JSON: {"items": [{"q": "...", "a": "..."}]}',
    excerpt:
      'Write a one or two sentence excerpt (maximum 280 characters) in %%language%% for an article titled "%%title%%" covering: %%headings%%. Tone: %%tone%%. %%instructions%% Return only the excerpt.',
    tags:
      'Choose up to 6 tags for an article titled "%%title%%" from this list of existing tags: %%existing_tags%%. Only use tags from the list, spelled exactly as listed. %%instructions%% Return JSON: {"tags": ["..."]}',
    seo:
      'Write an SEO meta title (maximum 60 characters) and meta description (maximum 160 characters) in %%language%% for an article titled "%%title%%". Summary: %%excerpt%%. %%instructions%% Return JSON: {"metaTitle": "...", "metaDescription": "..."}',
    rewrite: SECTION_PROMPT,
    imagePrompt:
      'Describe the featured image for an article titled "%%title%%" in one or two vivid sentences, in English. Picture a realistic photographic scene that fits the subject, with concrete details (setting, light, composition). No text, lettering, logos, watermarks or recognisable real people. %%instructions%% Return only the description.',
  },
};

// Unknown or missing variables render as empty strings; runs of spaces left
// behind are collapsed so prompts never contain literal "%%name%%" markers.
export function renderTemplate(template: string, vars: PromptVars): string {
  const values = vars as Record<string, string | undefined>;
  return template
    .replace(/%%([a-z_]+)%%/g, (_match, name: string) => values[name] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function buildPrompt(
  slot: TextSlot,
  mode: Mode,
  vars: PromptVars,
  settings: Settings,
): { system: string; prompt: string } {
  const override = settings.promptOverrides[mode]?.[slot];
  const template = override && override.trim() ? override : DEFAULT_PROMPTS[mode][slot];
  // The image description is not prose for readers; slop rules would only add noise there.
  const slop = settings.noAiSlop.enabled && slot !== "imagePrompt" ? SLOP_GUIDE : "";
  const system = [settings.promptPrefix.trim(), SYSTEM_BASE, slop].filter(Boolean).join("\n\n");
  return { system, prompt: renderTemplate(template, vars) };
}
