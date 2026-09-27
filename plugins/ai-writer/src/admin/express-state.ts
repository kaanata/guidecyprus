import { featuresOf, type CollectionFeatures } from "../lib/collections";
import { localeOf, type Locale } from "../lib/locale";
import type { ExpressCreateInput } from "../lib/routes";
import type { FaqItem, FeaturedImage } from "../lib/types";

// Section and intro/outro bodies are stored as raw text (paragraphs separated
// by a blank line) so textareas stay controlled without the cursor jumping;
// they are split into paragraphs only when the post is created.
export type DraftSection = { heading: string; text: string };

export type ExpressModelSlot =
  | "title"
  | "outline"
  | "section"
  | "intro"
  | "outro"
  | "faq"
  | "excerpt"
  | "tags"
  | "image";

export type ExpressState = {
  topic: string;
  title: string;
  sectionCount: number;
  paragraphsPerSection: number;
  headingsText: string;
  sections: DraftSection[];
  includeIntro: boolean;
  intro: string;
  includeOutro: boolean;
  outro: string;
  includeFaq: boolean;
  faq: FaqItem[];
  toc: boolean;
  headingLevel: "h2" | "h3";
  excerpt: string;
  featuredImage: FeaturedImage | null;
  /** Content locale of the post; also sets the writing language. */
  locale: Locale;
  /** Collection the post is created in. */
  collection: string;
  /** Blank = use the Settings default. */
  style: string;
  tone: string;
  status: "draft" | "published";
  categories: string[];
  tags: string[];
  autoTags: boolean;
  /** Per-button model picks; blank/missing = resolved default. */
  models: Partial<Record<ExpressModelSlot, string>>;
};

export const initialExpressState: ExpressState = {
  topic: "",
  title: "",
  sectionCount: 4,
  paragraphsPerSection: 2,
  headingsText: "",
  sections: [],
  includeIntro: true,
  intro: "",
  includeOutro: true,
  outro: "",
  includeFaq: false,
  faq: [],
  toc: false,
  headingLevel: "h2",
  excerpt: "",
  featuredImage: null,
  locale: "en",
  collection: "posts",
  style: "",
  tone: "",
  status: "draft",
  categories: [],
  tags: [],
  autoTags: false,
  models: {},
};

export function headingsFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function textToParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

export function paragraphsToText(paragraphs: string[]): string {
  return paragraphs.join("\n\n");
}

export function alignSections(headings: string[], previous: DraftSection[]): DraftSection[] {
  return headings.map((heading) => previous.find((s) => s.heading === heading) ?? { heading, text: "" });
}

export type PendingPart =
  | "title"
  | "outline"
  | "sections"
  | "intro"
  | "outro"
  | "faq"
  | "excerpt"
  | "tags"
  | "image";

/** Parts "Generate all" still has to fill, in pipeline order (only those the collection can hold). */
export function pendingParts(s: ExpressState, features: CollectionFeatures | null = null): PendingPart[] {
  const f = features ?? featuresOf(null);
  const out: PendingPart[] = [];
  const headings = headingsFromText(s.headingsText);
  if (!s.title.trim()) out.push("title");
  if (headings.length < 2) out.push("outline");
  if (headings.length < 2 || alignSections(headings, s.sections).some((x) => !x.text.trim())) {
    out.push("sections");
  }
  if (s.includeIntro && !s.intro.trim()) out.push("intro");
  if (s.includeOutro && !s.outro.trim()) out.push("outro");
  if (s.includeFaq && s.faq.length === 0) out.push("faq");
  if (f.excerpt && !s.excerpt.trim()) out.push("excerpt");
  if (f.tags && s.autoTags && s.tags.length === 0) out.push("tags");
  if (f.featuredImage && !s.featuredImage) out.push("image");
  return out;
}

export function contentParams(s: ExpressState): { locale: Locale; style?: string; tone?: string } {
  return {
    locale: s.locale,
    style: s.style.trim() || undefined,
    tone: s.tone.trim() || undefined,
  };
}

export function toCreatePayload(s: ExpressState, features: CollectionFeatures | null = null): ExpressCreateInput {
  const f = features ?? featuresOf(null);
  const sections = alignSections(headingsFromText(s.headingsText), s.sections)
    .map((x) => ({ heading: x.heading, paragraphs: textToParagraphs(x.text) }))
    .filter((x) => x.paragraphs.length > 0);
  return {
    title: s.title.trim(),
    intro: s.includeIntro ? textToParagraphs(s.intro) : [],
    sections,
    outro: s.includeOutro ? textToParagraphs(s.outro) : [],
    faq: s.includeFaq ? s.faq.filter((f) => f.q.trim() && f.a.trim()) : [],
    excerpt: f.excerpt ? s.excerpt.trim() : "",
    ...(s.featuredImage && f.featuredImage ? { featuredImage: s.featuredImage } : {}),
    structure: { headingLevel: s.headingLevel, toc: s.toc, outroHeader: "" },
    post: {
      collection: s.collection,
      status: s.status,
      locale: s.locale,
      categories: f.categories ? s.categories : [],
      tags: f.tags ? s.tags : [],
    },
  };
}

export function canCreate(s: ExpressState): boolean {
  const p = toCreatePayload(s);
  return p.title.length > 0 && p.sections.length > 0;
}

export const DRAFT_KEY = "ai-writer:express-draft";

export function loadDraft(storage: { getItem(key: string): string | null } | undefined): ExpressState {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    if (!raw) return initialExpressState;
    const draft = { ...initialExpressState, ...(JSON.parse(raw) as Partial<ExpressState>) };
    // Drafts saved before locales existed (or holding bad values) fall back to the defaults.
    draft.locale = localeOf(draft.locale);
    if (typeof draft.collection !== "string" || !/^[a-z][a-z0-9_]*$/.test(draft.collection)) {
      draft.collection = initialExpressState.collection;
    }
    return draft;
  } catch {
    return initialExpressState;
  }
}

export function saveDraft(storage: { setItem(key: string, value: string): void } | undefined, s: ExpressState): void {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify(s));
  } catch {
    // Storage can be unavailable (private mode, quota); autosave is best-effort.
  }
}
