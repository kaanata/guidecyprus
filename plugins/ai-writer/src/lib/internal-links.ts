import type { ApiResult, ContentEntry, ContentHandlers } from "./content";
import type { GenerationClient } from "./generation";
import { localeOf, localePrefix } from "./locale";
import { resolveModel } from "./models";
import type { GenerateTextOutput } from "./openrouter";
import type { InternalLinkSettings, Settings } from "./settings";
import { addUsage, roundCost } from "./usage";

// Internal linking. When a post is published, the AI picks phrases that
// already exist in its paragraphs and links them to related older posts
// (outbound), then picks a phrase in each related older post and links it to
// the new post (inbound). Only text is marked up; no sentence is rewritten.

// ---------------------------------------------------------------------------
// Portable Text helpers

type Span = { _type?: unknown; _key?: unknown; text?: unknown; marks?: unknown };
type MarkDef = { _type?: unknown; _key?: unknown; href?: unknown };
type TextBlock = {
  _type: "block";
  _key?: string;
  style?: unknown;
  listItem?: unknown;
  markDefs?: MarkDef[];
  children?: Span[];
};

const NON_BODY_STYLES = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);
const MAX_ANCHOR_CHARS = 80;
const MAX_ANCHOR_WORDS = 10;

function isTextBlock(value: unknown): value is TextBlock {
  return !!value && typeof value === "object" && (value as TextBlock)._type === "block";
}

function spansOf(block: TextBlock): Span[] {
  return Array.isArray(block.children) ? block.children : [];
}

function spanText(span: Span): string {
  return typeof span.text === "string" ? span.text : "";
}

/** Body paragraphs (normal text and list items, never headings or quotes) with their block index. */
export function paragraphsOf(content: unknown): Array<{ block: number; text: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ block: number; text: string }> = [];
  content.forEach((raw, block) => {
    if (!isTextBlock(raw) || NON_BODY_STYLES.has(String(raw.style ?? "normal"))) return;
    const text = spansOf(raw).map(spanText).join("").trim();
    if (text) out.push({ block, text });
  });
  return out;
}

/** Every link href already in the body. */
export function linkedHrefs(content: unknown): Set<string> {
  const hrefs = new Set<string>();
  if (!Array.isArray(content)) return hrefs;
  for (const raw of content) {
    if (!isTextBlock(raw) || !Array.isArray(raw.markDefs)) continue;
    for (const def of raw.markDefs) if (def?._type === "link" && typeof def.href === "string") hrefs.add(def.href);
  }
  return hrefs;
}

export function anchorProblem(anchor: string): string | null {
  const a = anchor.trim();
  if (!a) return "empty anchor";
  if (a.length > MAX_ANCHOR_CHARS) return "anchor too long";
  if (a.split(/\s+/).length > MAX_ANCHOR_WORDS) return "anchor has too many words";
  return null;
}

/**
 * Wraps the first unlinked occurrence of `anchor` (case-insensitive, inside a
 * single span) in block `blockIndex` with a link to `href`. Returns new
 * content, or null when the phrase is not there (or only inside a link).
 */
export function insertLink(content: unknown[], blockIndex: number, anchor: string, href: string): unknown[] | null {
  const block = content[blockIndex];
  const needle = anchor.trim().toLowerCase();
  if (!isTextBlock(block) || anchorProblem(anchor)) return null;
  if (NON_BODY_STYLES.has(String(block.style ?? "normal"))) return null;
  const linkMarks = new Set(
    (block.markDefs ?? []).filter((d) => d?._type === "link" && typeof d._key === "string").map((d) => d._key as string),
  );
  const spans = spansOf(block);
  const blockKey = typeof block._key === "string" ? block._key : `b${blockIndex}`;
  const used = new Set(
    [...spans.map((s) => s._key), ...(block.markDefs ?? []).map((d) => d._key)].filter(
      (k): k is string => typeof k === "string",
    ),
  );
  const freshKey = (base: string) => {
    let n = 0;
    while (used.has(`${base}${n}`)) n++;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const text = spanText(span);
    const marks = Array.isArray(span.marks) ? (span.marks as string[]) : [];
    if (marks.some((m) => linkMarks.has(m))) continue;
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    const linkKey = freshKey(`${blockKey}-link`);
    const piece = (t: string, extra: string[]) => ({
      ...span,
      _type: "span",
      _key: freshKey(`${blockKey}-s`),
      text: t,
      marks: [...marks, ...extra],
    });
    const before = text.slice(0, at);
    const after = text.slice(at + needle.length);
    const replacement = [
      ...(before ? [piece(before, [])] : []),
      piece(text.slice(at, at + needle.length), [linkKey]),
      ...(after ? [piece(after, [])] : []),
    ];
    const nextBlock: TextBlock = {
      ...block,
      markDefs: [...(block.markDefs ?? []), { _type: "link", _key: linkKey, href }],
      children: [...spans.slice(0, i), ...replacement, ...spans.slice(i + 1)],
    };
    return content.map((b, idx) => (idx === blockIndex ? nextBlock : b));
  }
  return null;
}

/**
 * An entry's public URL from the Settings pattern. {localePrefix} is "" for
 * the default locale and "/tr" for Turkish, so "{localePrefix}/{slug}" gives
 * /{slug} and /tr/{slug}.
 */
export function hrefFor(pattern: string, collection: string, slug: string, locale?: string | null): string {
  return pattern
    .replaceAll("{localePrefix}", localePrefix(locale))
    .replaceAll("{collection}", collection)
    .replaceAll("{slug}", encodeURIComponent(slug));
}

export type LinkEntry = ContentEntry & { draftRevisionId?: string | null; liveRevisionId?: string | null };

/** True when the entry has editor changes that are not live yet. */
export function hasPendingDraft(entry: LinkEntry): boolean {
  return !!entry.draftRevisionId && entry.draftRevisionId !== entry.liveRevisionId;
}

// ---------------------------------------------------------------------------
// AI choices

export type Candidate = { id: string; slug: string; title: string; excerpt: string };

const SYSTEM =
  "You add internal links to articles on a website. Reply with strict JSON only. Anchor phrases must be copied exactly, character for character, from the given paragraph: never invent, translate or rephrase them.";
const MAX_CANDIDATES_SHOWN = 100;
const MAX_RELATED = 10;
const MAX_PARAGRAPH_CHARS = 700;
const MAX_PARAGRAPHS = 40;

export type Ask = (prompt: string) => Promise<GenerateTextOutput>;

function jsonObject(out: GenerateTextOutput): Record<string, unknown> {
  return out.json && typeof out.json === "object" && !Array.isArray(out.json)
    ? (out.json as Record<string, unknown>)
    : {};
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`);

function numberedParagraphs(paragraphs: Array<{ text: string }>): string {
  return paragraphs
    .slice(0, MAX_PARAGRAPHS)
    .map((p, i) => `[${i + 1}] ${clip(p.text, MAX_PARAGRAPH_CHARS)}`)
    .join("\n");
}

function containsPhrase(paragraph: { text: string } | undefined, anchor: string): boolean {
  return !!paragraph && paragraph.text.toLowerCase().includes(anchor.toLowerCase());
}

/** Candidates genuinely related to the article, best first (at most 10). */
export async function rankRelated(
  ask: Ask,
  article: { title: string; excerpt: string },
  candidates: Candidate[],
): Promise<Candidate[]> {
  const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN);
  if (shown.length === 0) return [];
  const list = shown.map((c, i) => `${i + 1}. ${c.title}${c.excerpt ? ` — ${clip(c.excerpt, 140)}` : ""}`).join("\n");
  const out = await ask(
    [
      `ARTICLE: ${article.title}${article.excerpt ? `\nSUMMARY: ${clip(article.excerpt, 400)}` : ""}`,
      `OTHER ARTICLES:\n${list}`,
      `Which other articles are genuinely related to the article (same place, region, category, activity or theme)? Best first, at most ${MAX_RELATED}. Leave out anything only loosely related. Return JSON: {"related": [numbers]}`,
    ].join("\n\n"),
  );
  const raw = jsonObject(out).related;
  const picked: Candidate[] = [];
  for (const n of Array.isArray(raw) ? raw : []) {
    const c = typeof n === "number" ? shown[n - 1] : undefined;
    if (c && !picked.includes(c)) picked.push(c);
    if (picked.length >= MAX_RELATED) break;
  }
  return picked;
}

export type AnchorChoice = { target: Candidate; paragraph: number; anchor: string };

/** Phrases in the article's paragraphs to link to related articles (one per paragraph, one per target). */
export async function chooseOutbound(
  ask: Ask,
  paragraphs: Array<{ text: string }>,
  related: Candidate[],
  max: number,
): Promise<AnchorChoice[]> {
  if (max <= 0 || related.length === 0 || paragraphs.length === 0) return [];
  const list = related.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
  const out = await ask(
    [
      `PARAGRAPHS:\n${numberedParagraphs(paragraphs)}`,
      `RELATED ARTICLES:\n${list}`,
      `Choose up to ${max} links. For each, copy a short phrase (2-6 words) exactly from one paragraph that naturally describes what the related article is about. Use each paragraph and each related article at most once. Skip an article when no phrase fits naturally. Return JSON: {"links": [{"article": number, "paragraph": number, "anchor": "exact phrase"}]}`,
    ].join("\n\n"),
  );
  const raw = jsonObject(out).links;
  const choices: AnchorChoice[] = [];
  const usedParagraphs = new Set<number>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = (item ?? {}) as { article?: unknown; paragraph?: unknown; anchor?: unknown };
    const target = typeof r.article === "number" ? related[r.article - 1] : undefined;
    const paragraph = typeof r.paragraph === "number" ? r.paragraph - 1 : -1;
    const anchor = typeof r.anchor === "string" ? r.anchor.trim() : "";
    if (!target || anchorProblem(anchor) || !containsPhrase(paragraphs[paragraph], anchor)) continue;
    if (usedParagraphs.has(paragraph) || choices.some((c) => c.target.id === target.id)) continue;
    usedParagraphs.add(paragraph);
    choices.push({ target, paragraph, anchor });
    if (choices.length >= max) break;
  }
  return choices;
}

/** One phrase in an older article's paragraphs to link to the new article, or null. */
export async function chooseInbound(
  ask: Ask,
  paragraphs: Array<{ text: string }>,
  article: { title: string; excerpt: string },
): Promise<{ paragraph: number; anchor: string } | null> {
  if (paragraphs.length === 0) return null;
  const out = await ask(
    [
      `PARAGRAPHS:\n${numberedParagraphs(paragraphs)}`,
      `NEW ARTICLE: ${article.title}${article.excerpt ? `\nSUMMARY: ${clip(article.excerpt, 400)}` : ""}`,
      `Copy one short phrase (2-6 words) exactly from one paragraph that naturally refers to what the new article is about, so it can link there. If nothing fits naturally, use null. Return JSON: {"paragraph": number | null, "anchor": "exact phrase" | null}`,
    ].join("\n\n"),
  );
  const r = jsonObject(out);
  const paragraph = typeof r.paragraph === "number" ? r.paragraph - 1 : -1;
  const anchor = typeof r.anchor === "string" ? r.anchor.trim() : "";
  if (anchorProblem(anchor) || !containsPhrase(paragraphs[paragraph], anchor)) return null;
  return { paragraph, anchor };
}

// ---------------------------------------------------------------------------
// One job: link a newly published entry both ways

/** Published entries of a collection in one locale, newest first. */
export type ListPublished = (collection: string, locale?: string) => Promise<ApiResult<{ items: LinkEntry[] }>>;

export type LinkJobDeps = {
  client: Pick<GenerationClient, "generateText">;
  settings: Settings;
  content: Pick<ContentHandlers, "get" | "update" | "publish">;
  listPublished: ListPublished;
};

export type LinkRef = { id: string; title: string; anchor: string };

export type LinkJobResult = {
  title: string;
  outbound: LinkRef[];
  inbound: LinkRef[];
  warnings: string[];
  calls: number;
  cost: number;
  tokens: number;
};

export class LinkJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkJobError";
  }
}

const titleOf = (e: ContentEntry) => (typeof e.data?.title === "string" ? e.data.title.trim() : "");
const excerptOf = (e: ContentEntry) => (typeof e.data?.excerpt === "string" ? e.data.excerpt.trim() : "");
const bodyOf = (e: ContentEntry) => (Array.isArray(e.data?.content) ? (e.data.content as unknown[]) : []);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

type SaveOutcome = { saved: boolean; warning?: string };

// Update the body, then publish so the change goes live (on collections with
// revisions the update alone becomes a draft revision).
async function saveLive(deps: LinkJobDeps, collection: string, entry: LinkEntry, content: unknown[]): Promise<SaveOutcome> {
  const updated = await deps.content.update(collection, entry.id, { data: { content } });
  if (updated.success === false) return { saved: false, warning: updated.error?.message ?? "update failed" };
  try {
    const published = await deps.content.publish(collection, entry.id);
    if (published.success === false) {
      return { saved: true, warning: `saved as a draft; publishing failed: ${published.error?.message ?? "unknown error"}` };
    }
  } catch (err) {
    return { saved: true, warning: `saved as a draft; publishing failed: ${messageOf(err)}` };
  }
  return { saved: true };
}

export async function runLinkJob(deps: LinkJobDeps, collection: string, id: string): Promise<LinkJobResult> {
  const cfg: InternalLinkSettings = deps.settings.internalLinks;
  let calls = 0;
  const spend = { cost: 0, tokens: 0 };
  // Per-step overrides belong to article writing; linking uses its own model or the default.
  const { model, fallbacks } = resolveModel("rewrite", {
    request: cfg.model,
    settings: { ...deps.settings.models, steps: {} },
    provider: deps.settings.providers.text,
  });
  const ask: Ask = async (prompt) => {
    calls++;
    const out = await deps.client.generateText({
      model,
      fallbackModels: fallbacks,
      system: SYSTEM,
      prompt,
      temperature: 0.2,
      responseFormat: { type: "json_object" },
    });
    addUsage(spend, out.usage);
    return out;
  };

  const got = await deps.content.get(collection, id);
  if (got.success === false) throw new LinkJobError(got.error?.message ?? "Post not found");
  const entry = got.data.item as LinkEntry;
  if (entry.status !== "published") throw new LinkJobError("The post is no longer published");
  const title = titleOf(entry);
  const slug = entry.slug ?? "";
  if (!title || !slug) throw new LinkJobError("The post needs a title and a slug");
  const article = { title, excerpt: excerptOf(entry) };
  // Links never cross languages: candidates, hrefs and backlinks all stay in the post's locale.
  const locale = localeOf(entry.locale);
  const href = (targetSlug: string) => hrefFor(cfg.pathPattern, collection, targetSlug, locale);
  const selfHref = href(slug);
  const result: LinkJobResult = { title, outbound: [], inbound: [], warnings: [], calls: 0, cost: 0, tokens: 0 };
  const done = () => ({ ...result, calls, cost: roundCost(spend.cost), tokens: spend.tokens });

  const listed = await deps.listPublished(collection, locale);
  if (listed.success === false) throw new LinkJobError(listed.error?.message ?? "Published posts could not be listed");
  const candidates: Candidate[] = listed.data.items
    .filter((item) => item.id !== entry.id && item.slug && titleOf(item) && localeOf(item.locale) === locale)
    .map((item) => ({ id: item.id, slug: item.slug as string, title: titleOf(item), excerpt: excerptOf(item) }));
  if (candidates.length === 0) {
    result.warnings.push("No other published posts to link with");
    return done();
  }

  const related = await rankRelated(ask, article, candidates);
  if (related.length === 0) {
    result.warnings.push("No related posts found");
    return done();
  }

  // Outbound: this post → related older posts.
  if (cfg.maxOutbound > 0) {
    if (hasPendingDraft(entry)) {
      result.warnings.push("Outbound links skipped: the post has unpublished editor changes");
    } else {
      const body = bodyOf(entry);
      const already = linkedHrefs(body);
      const targets = related.filter((c) => !already.has(href(c.slug)));
      const paragraphs = paragraphsOf(body);
      let next = body;
      const added: LinkRef[] = [];
      for (const choice of await chooseOutbound(ask, paragraphs, targets, cfg.maxOutbound)) {
        const linked = insertLink(next, paragraphs[choice.paragraph].block, choice.anchor, href(choice.target.slug));
        if (!linked) continue;
        next = linked;
        added.push({ id: choice.target.id, title: choice.target.title, anchor: choice.anchor });
      }
      if (added.length > 0) {
        const outcome = await saveLive(deps, collection, entry, next);
        if (outcome.warning) result.warnings.push(`Outbound links: ${outcome.warning}`);
        if (outcome.saved) result.outbound = added;
      }
    }
  }

  // Inbound: related older posts → this post. A few spare attempts cover
  // posts that are skipped or have no natural phrase.
  for (const candidate of related.slice(0, cfg.maxInbound + 3)) {
    if (result.inbound.length >= cfg.maxInbound) break;
    try {
      const older = await deps.content.get(collection, candidate.id);
      if (older.success === false) continue;
      const item = older.data.item as LinkEntry;
      if (item.status !== "published" || localeOf(item.locale) !== locale) continue;
      if (hasPendingDraft(item)) {
        result.warnings.push(`"${candidate.title}" skipped: it has unpublished editor changes`);
        continue;
      }
      const body = bodyOf(item);
      if (linkedHrefs(body).has(selfHref)) continue;
      const paragraphs = paragraphsOf(body);
      const choice = await chooseInbound(ask, paragraphs, article);
      if (!choice) continue;
      const next = insertLink(body, paragraphs[choice.paragraph].block, choice.anchor, selfHref);
      if (!next) continue;
      const outcome = await saveLive(deps, collection, item, next);
      if (outcome.warning) result.warnings.push(`"${candidate.title}": ${outcome.warning}`);
      if (outcome.saved) result.inbound.push({ id: candidate.id, title: candidate.title, anchor: choice.anchor });
    } catch (err) {
      result.warnings.push(`"${candidate.title}": ${messageOf(err)}`);
    }
  }

  return done();
}
