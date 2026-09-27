import type { GenerationClient } from "./generation";
import { DEFAULT_LOCALE, type Locale } from "./locale";
import { resolveModel } from "./models";
import type { GenerateTextOutput } from "./openrouter";
import type { Settings } from "./settings";

// No-AI-slop, adapted from "no-ai-slop" by Peter Yang (MIT License,
// https://github.com/petergyang/no-ai-slop). The full rule set goes into every
// writing prompt so articles are written clean; a deterministic lint names the
// patterns it can see, and one edit pass per article removes what slipped
// through while keeping the meaning, the headings and every internal link.

const BANNED_WORDS = [
  "delve",
  "foster",
  "leverage",
  "utilize",
  "facilitate",
  "empower",
  "streamline",
  "robust",
  "cutting-edge",
  "paradigm shift",
  "game changer",
  "game-changer",
  "this is huge",
  "this changes everything",
  "tapestry",
  "realm",
  "beacon",
  "multifaceted",
  "meticulous",
  "intricate",
  "paramount",
  "transformative",
  "elevate",
  "embark",
  "supercharge",
  "harness",
  "ever-evolving",
];

const EMPTY_PHRASES = [
  "it's worth noting",
  "it is worth noting",
  "it's important to note",
  "it is important to note",
  "at the end of the day",
  "when it comes to",
  "at its core",
  "in today's world",
  "in the age of",
  "in the world of",
  "the reality is",
  "the truth is",
  "in terms of",
  "with regard to",
  "in order to",
  "going forward",
  "in this article",
  "let's dive in",
];

// Often empty, but fine when they carry real emphasis or uncertainty, so they
// are rules for the writer and editor rather than lint hits.
const EMPTY_ADVERBS = [
  "just",
  "literally",
  "honestly",
  "simply",
  "actually",
  "truly",
  "fundamentally",
  "importantly",
  "crucially",
  "inherently",
  "inevitably",
];

// Every pattern upstream names, with the fix. Shared by the writing guide and the edit pass.
const PATTERN_RULES = [
  `Binary contrasts ("It's not X, it's Y", "not just X but Y"): state Y directly.`,
  `Negative listing ("Not X. Not Y. Z."): just say Z.`,
  `Throat-clearing openers ("Here's the thing", "Let me be clear", "I'll be honest", "The uncomfortable truth is"): start with the point.`,
  `Faux-insight setups ("Here's what nobody tells you", "What most people miss"): let the claim stand alone.`,
  `Rhetorical setups ("What if I told you", "Think about it", "Plot twist") and self-answered questions.`,
  `Colon reveals ("The best part: it learns."): write a plain sentence; use colons only for lists, labels and quotes.`,
  `Superficial analysis: trailing "-ing" clauses that fake meaning ("highlighting...", "underscoring...").`,
  `Importance puffery ("plays a vital role", "marks a pivotal moment", "a testament to"): state the plain fact.`,
  `Weasel attribution ("experts agree", "studies show"): name the source or drop the attribution; never invent one.`,
  `Interpretive metadiscourse ("The key point is", "As you can see", "This distinction matters").`,
  `Fake-strong verbs ("serves as a hub for"): say what it actually does.`,
  `Synonym cycling: repeat the right word instead of rotating synonyms.`,
  `Dramatic fragments ("That's it. That's the whole thing.", "X. And Y. And Z.").`,
  `Robotic rhythm: vary sentence shape; no repeated structures or stacked punchy fragments.`,
  `Fake-profound kickers: no closing line that turns the point into a cute metaphor; end on the last concrete sentence.`,
  `Summary-recap endings ("In conclusion", "Ultimately", "Overall"): end on the last concrete point.`,
  `Formatting slop: no emoji, no decorative bold, no bullet lists where prose works, no headings over tiny sections.`,
  `Em dashes: do not use them; a comma, period or parentheses does the job.`,
];

const WORD_RULES = [
  `Never use these words: ${BANNED_WORDS.join(", ")}.`,
  `Cut these phrases, which only delay the point: ${EMPTY_PHRASES.join("; ")}.`,
  `Cut these adverbs unless they carry real emphasis or uncertainty: ${EMPTY_ADVERBS.join(", ")}.`,
];

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "binary contrast",
    re: /\b(?:it's|this is|that's) not (?:just |only |about )?[^.!?]{1,60}[,.;]\s*(?:it's|but)\b/gi,
  },
  { name: "binary contrast", re: /\bnot (?:just|only|merely) [^.!?]{1,60}\bbut\b/gi },
  { name: "throat-clearing opener", re: /\b(?:here's the thing|let me be clear|the uncomfortable truth is|i'll be honest)\b/gi },
  {
    name: "faux-insight setup",
    re: /\b(?:what most people (?:get wrong|miss)|here's what nobody tells you|the part (?:everyone|most people) (?:misses|skip))\b/gi,
  },
  { name: "superficial -ing analysis", re: /,\s*(?:highlighting|underscoring|showcasing|reflecting|emphasizing|emphasising)\b/gi },
  {
    name: "importance puffery",
    re: /\b(?:stands as a testament|a testament to|marks a pivotal moment|plays? an? (?:vital|crucial|pivotal|key) role|solidif(?:y|ies) (?:its|their) position|underscores? (?:its|the|their) (?:significance|importance))\b/gi,
  },
  { name: "weasel attribution", re: /\b(?:experts agree|studies show|many argue|widely regarded as|industry reports suggest)\b/gi },
  { name: "rhetorical setup", re: /\b(?:what if i told you|think about it:|plot twist:)/gi },
  { name: "summary-recap ending", re: /(?:^|[.!?]\s+|\n\s*)(?:in conclusion|ultimately|overall|in summary|to sum up),/gi },
  { name: "negative listing", re: /\bnot [^.!?\n]{1,40}\.\s+not [^.!?\n]{1,40}\./gi },
];

const bullets = (lines: string[]) => lines.map((line) => `- ${line}`).join("\n");

/** The full no-AI-slop rule set, added to every writing prompt when no-AI-slop is on. */
export const SLOP_GUIDE = `Write like a sharp human writer, not like an AI:
- Lead with the point; cut generic setup.
- Be concrete and specific: numbers, names, actions and consequences beat abstractions. Keep every fact exact; never invent claims, statistics, quotes or sources.
- Use active voice with real subjects and strong verbs ("decided", not "made a decision"; "can", not "has the ability to").
- Show, don't tell: let facts carry the emphasis instead of labels like "surprisingly" or "importantly".
- Every sentence earns its place. Portability test: a sentence that would fit any other article unchanged is filler; replace it with something specific to this subject or cut it.
- Keep sentences easy to follow without flattening them into one rhythm.
${bullets(WORD_RULES)}
Never write these patterns:
${bullets(PATTERN_RULES)}`;

const EDIT_RULES = `You are a sharp human editor removing AI-writing patterns ("AI slop") from an article. Make the minimum effective edit: keep the meaning, facts, structure and voice, and leave strong sentences alone. Never add claims, examples, statistics, quotes, names or opinions. Keep the article in its original language: never translate it; apply the rules below to their equivalents in that language.
Remove or fix:
${bullets(WORD_RULES)}
${bullets(PATTERN_RULES)}
- Sentences that could be moved unchanged to any other article (portability test): cut them.`;

const JSON_CONTRACT = `Input and output are JSON: {"excerpt": string, "blocks": [{"i": number, "style": string, "text": string}]}.
Return every block by its "i", in order. Edit "text" in place. A normal paragraph that is pure filler may be returned with "text": "" to delete it; never delete a heading. Links are written as [anchor text](href): keep every link exactly as given, with the same anchor words and the same href. Reply with strict JSON only.`;

// ---------------------------------------------------------------------------
// Deterministic lint

const escapeRe = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

/** Named slop patterns found in plain text (each listed once, with a count when repeated). */
export function lintSlop(text: string): string[] {
  const counts = new Map<string, number>();
  const bump = (name: string, n: number) => counts.set(name, (counts.get(name) ?? 0) + n);
  const plain = text.replace(/[’‘]/g, "'");
  const lower = plain.toLowerCase();
  for (const word of BANNED_WORDS) {
    // Inflections too: delve → delves/delved/delving, robust → robustly.
    const stem = word.endsWith("e") ? escapeRe(word.slice(0, -1)) : escapeRe(word);
    const forms = `(?:${escapeRe(word)}(?:s|d|ly)?|${stem}(?:es|ed|ing|ly)?)`;
    const n = (lower.match(new RegExp(`(?<![a-z-])${forms}(?![a-z-])`, "g")) ?? []).length;
    if (n > 0) bump(`banned word "${word}"`, n);
  }
  for (const phrase of EMPTY_PHRASES) {
    const n = lower.split(phrase).length - 1;
    if (n > 0) bump(`empty phrase "${phrase}"`, n);
  }
  for (const { name, re } of PATTERNS) {
    const n = (plain.match(new RegExp(re.source, re.flags)) ?? []).length;
    if (n > 0) bump(name, n);
  }
  const dashes = (plain.match(/—|\s--\s/g) ?? []).length;
  if (dashes > 2) bump("em dashes", dashes);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

// ---------------------------------------------------------------------------
// Portable Text <-> editable text (links kept as [anchor](href))

type Span = { _type?: unknown; _key?: unknown; text?: unknown; marks?: unknown };
type MarkDef = { _type?: unknown; _key?: unknown; href?: unknown };
type Block = {
  _type?: unknown;
  _key?: unknown;
  style?: unknown;
  listItem?: unknown;
  markDefs?: MarkDef[];
  children?: Span[];
};

const EDITABLE_STYLES = new Set(["normal", "h2", "h3", "h4"]);
const HEADING_STYLES = new Set(["h2", "h3", "h4"]);
const LINK_RE = /\[([^\]\n]{1,120})\]\(([^)\s]{1,500})\)/g;

export type Editable = { index: number; style: string; text: string; links: string[] };

const linkSignature = (anchor: string, href: string) => `${href} ${anchor.trim().toLowerCase()}`;

/** The block as editable text, or null when it holds anything besides plain and linked text. */
export function toEditable(block: unknown, index: number): Editable | null {
  const b = (block ?? {}) as Block;
  if (b._type !== "block" || !EDITABLE_STYLES.has(String(b.style ?? "normal"))) return null;
  const links = new Map<string, string>();
  for (const def of b.markDefs ?? []) {
    if (def?._type === "link" && typeof def._key === "string" && typeof def.href === "string") links.set(def._key, def.href);
  }
  let text = "";
  const sigs: string[] = [];
  for (const span of Array.isArray(b.children) ? b.children : []) {
    if (span?._type !== "span" || typeof span.text !== "string") return null;
    const marks = Array.isArray(span.marks) ? (span.marks as unknown[]) : [];
    const linkMarks = marks.filter((m): m is string => typeof m === "string" && links.has(m));
    // Bold, italics, code and other annotations are an editor's choice: leave those blocks alone.
    if (marks.length !== linkMarks.length || linkMarks.length > 1) return null;
    if (linkMarks.length === 1) {
      const href = links.get(linkMarks[0]) as string;
      if (/[[\]()]/.test(span.text) || /\s/.test(href)) return null;
      text += `[${span.text}](${href})`;
      sigs.push(linkSignature(span.text, href));
    } else {
      text += span.text;
    }
  }
  if (!text.trim()) return null;
  return { index, style: String(b.style ?? "normal"), text, links: sigs.sort() };
}

/** Rebuilds a block from edited text; null when its links differ from the original in any way. */
export function fromEditable(original: unknown, edited: string, links: string[]): Block | null {
  const b = original as Block;
  const allowed = new Set(links.map((sig) => sig.slice(0, sig.indexOf(" "))));
  const blockKey = typeof b._key === "string" ? b._key : "b";
  const children: Span[] = [];
  const markDefs: MarkDef[] = [];
  const found: string[] = [];
  let last = 0;
  let n = 0;
  const pushText = (t: string) => {
    if (t) children.push({ _type: "span", _key: `${blockKey}-e${n++}`, text: t, marks: [] });
  };
  for (const m of edited.matchAll(LINK_RE)) {
    const [whole, anchor, href] = m;
    if (!allowed.has(href)) continue;
    pushText(edited.slice(last, m.index));
    const key = `${blockKey}-l${n}`;
    markDefs.push({ _type: "link", _key: key, href });
    children.push({ _type: "span", _key: `${blockKey}-e${n++}`, text: anchor, marks: [key] });
    found.push(linkSignature(anchor, href));
    last = (m.index ?? 0) + whole.length;
  }
  pushText(edited.slice(last));
  if (found.sort().join("\n") !== links.join("\n")) return null;
  // Leftover link syntax means the model invented or mangled a link.
  if (/\[[^\]]*\]\([^)]*\)/.test(children.map((c) => c.text).join(""))) return null;
  return { ...b, markDefs, children };
}

// ---------------------------------------------------------------------------
// The edit pass

export type SlopAsk = (system: string, prompt: string) => Promise<GenerateTextOutput>;

export class SlopEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlopEditError";
  }
}

export type SlopResult = {
  content: unknown[];
  excerpt: string;
  editedBlocks: number;
  removedBlocks: number;
  /** Blocks whose edit was rejected (e.g. a link went missing) and kept as they were. */
  keptBlocks: number;
  /** Chunks whose edit call failed and were left as written. */
  failedParts: number;
  /** Why those chunks failed. */
  partErrors: string[];
  before: string[];
  after: string[];
};

const MIN_KEPT_RATIO = 0.55;
// Small parts keep each reply well inside the 45-second chat timeout.
const CHUNK_BLOCKS = 6;
const CHUNK_CHARS = 2200;
// A rewritten part is a long reply; give it more time than a short step.
const EDIT_TIMEOUT_MS = 120_000;
const PART_ATTEMPTS = 2;
const MAX_HEADING = 200;
const MAX_EXCERPT = 400;

const plainOf = (text: string) => text.replace(LINK_RE, "$1");

function editablesOf(content: unknown[]): Editable[] {
  return content.map((b, i) => toEditable(b, i)).filter((e): e is Editable => e !== null);
}

export async function deslopArticle(
  ask: SlopAsk,
  input: { title: string; excerpt: string; content: unknown[]; locale?: Locale },
): Promise<SlopResult> {
  const editable = editablesOf(input.content);
  // The lint's word and pattern lists are English; other languages rely on the edit rules alone.
  const lint = (input.locale ?? DEFAULT_LOCALE) === "en" ? lintSlop : () => [];
  const before = lint([input.excerpt, ...editable.map((e) => plainOf(e.text))].join("\n\n"));
  if (editable.length === 0) {
    return {
      content: input.content,
      excerpt: input.excerpt,
      editedBlocks: 0,
      removedBlocks: 0,
      keptBlocks: 0,
      failedParts: 0,
      partErrors: [],
      before,
      after: before,
    };
  }

  // Long articles are edited in chunks so each reply stays small and fast;
  // a chunk that fails is simply left as written.
  const chunks: Editable[][] = [];
  let current: Editable[] = [];
  let size = 0;
  for (const e of editable) {
    if (current.length > 0 && (current.length >= CHUNK_BLOCKS || size + e.text.length > CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += e.text.length;
  }
  if (current.length > 0) chunks.push(current);

  const returned = new Map<number, string>();
  let excerptRaw = "";
  const failures: unknown[] = [];
  for (const [n, chunk] of chunks.entries()) {
    // One retry per part: models occasionally return an empty or malformed reply.
    let lastError: unknown;
    for (let attempt = 0; attempt < PART_ATTEMPTS; attempt++) {
      try {
        const out = await ask(
          `${EDIT_RULES}\n\n${JSON_CONTRACT}`,
          [
            `ARTICLE TITLE: ${input.title}`,
            chunks.length > 1 ? `PART ${n + 1} OF ${chunks.length} of the article.` : "",
            before.length > 0 ? `PATTERNS FOUND BY A CHECKER IN THE ARTICLE (fix these): ${before.join("; ")}` : "",
            `ARTICLE JSON:\n${JSON.stringify({
              excerpt: n === 0 ? input.excerpt : "",
              blocks: chunk.map((e) => ({ i: e.index, style: e.style, text: e.text })),
            })}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        // Accept the common reply shapes: {blocks: [...]}, a bare array, or "i" as a string.
        const json = (out.json && typeof out.json === "object" ? out.json : {}) as { excerpt?: unknown; blocks?: unknown };
        const list = Array.isArray(json) ? json : Array.isArray(json.blocks) ? json.blocks : [];
        const wanted = new Set(chunk.map((e) => e.index));
        let got = 0;
        for (const raw of list) {
          const r = (raw ?? {}) as { i?: unknown; index?: unknown; text?: unknown };
          const i = Number(r.i ?? r.index);
          if (Number.isInteger(i) && wanted.has(i) && typeof r.text === "string") {
            returned.set(i, r.text);
            got++;
          }
        }
        if (got === 0) {
          const start = out.raw.trim().slice(0, 80).replace(/\s+/g, " ");
          throw new SlopEditError(`The model returned no blocks${start ? ` (reply began: "${start}")` : " (empty reply)"}`);
        }
        if (n === 0 && !Array.isArray(json) && typeof json.excerpt === "string") excerptRaw = json.excerpt.trim();
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError !== undefined) failures.push(lastError);
  }
  if (returned.size === 0) {
    // A transport failure (timeout, network) is worth retrying later; a bad reply is not.
    const transient = failures.find((f) => !(f instanceof SlopEditError));
    if (transient) throw transient;
    throw failures[0] instanceof SlopEditError ? failures[0] : new SlopEditError("The model returned no blocks");
  }

  const next: Array<unknown | null> = [...input.content];
  let editedBlocks = 0;
  let removedBlocks = 0;
  let keptBlocks = 0;
  let beforeChars = 0;
  let afterChars = 0;
  for (const e of editable) {
    const originalChars = plainOf(e.text).length;
    beforeChars += originalChars;
    const trimmed = returned.get(e.index)?.trim();
    if (trimmed === undefined || trimmed === e.text.trim()) {
      afterChars += originalChars;
      continue;
    }
    const heading = HEADING_STYLES.has(e.style);
    if (!trimmed) {
      if (heading || e.links.length > 0) {
        keptBlocks++;
        afterChars += originalChars;
      } else {
        next[e.index] = null;
        removedBlocks++;
      }
      continue;
    }
    const rebuilt =
      heading && plainOf(trimmed).length > MAX_HEADING ? null : fromEditable(input.content[e.index], trimmed, e.links);
    if (!rebuilt) {
      keptBlocks++;
      afterChars += originalChars;
      continue;
    }
    next[e.index] = rebuilt;
    editedBlocks++;
    afterChars += plainOf(trimmed).length;
  }
  if (beforeChars > 0 && afterChars / beforeChars < MIN_KEPT_RATIO) {
    throw new SlopEditError("The edit removed too much of the article; the original was kept");
  }

  const content = next.filter((b) => b !== null);
  const excerpt = excerptRaw && excerptRaw.length <= MAX_EXCERPT ? excerptRaw : input.excerpt;
  const after = lint([excerpt, ...editablesOf(content).map((x) => plainOf(x.text))].join("\n\n"));
  return {
    content,
    excerpt,
    editedBlocks,
    removedBlocks,
    keptBlocks,
    failedParts: failures.length,
    partErrors: failures.map((f) => (f instanceof Error ? f.message : String(f)).slice(0, 200)),
    before,
    after,
  };
}

/** An ask function on the Settings text provider, using the no-AI-slop model or the default text model. */
export function slopAskFor(client: Pick<GenerationClient, "generateText">, settings: Settings): SlopAsk {
  const { model, fallbacks } = resolveModel("rewrite", {
    request: settings.noAiSlop.model,
    settings: { ...settings.models, steps: {} },
    provider: settings.providers.text,
  });
  return (system, prompt) =>
    client.generateText({
      model,
      fallbackModels: fallbacks,
      system: [settings.promptPrefix.trim(), system].filter(Boolean).join("\n\n"),
      prompt,
      temperature: 0.3,
      responseFormat: { type: "json_object" },
      timeoutMs: EDIT_TIMEOUT_MS,
    });
}

export function describeSlop(result: SlopResult): string {
  const parts = [`Edited ${result.editedBlocks} block(s)`];
  if (result.removedBlocks > 0) parts.push(`removed ${result.removedBlocks} filler paragraph(s)`);
  if (result.keptBlocks > 0) parts.push(`kept ${result.keptBlocks} block(s) as they were to protect links or headings`);
  if (result.failedParts > 0) parts.push(`${result.failedParts} part(s) could not be edited and were left as written`);
  parts.push(result.before.length > 0 ? `patterns before: ${result.before.join(", ")}` : "no patterns found before");
  if (result.after.length > 0) parts.push(`still present: ${result.after.join(", ")}`);
  return parts.join("; ");
}
