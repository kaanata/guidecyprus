import { z } from "zod";
import { localeOf, localeSchema } from "./locale";
import type { PipelineOptions } from "./pipeline";
import { MODES, TEXT_SLOTS } from "./types";

export const SLOT_KEYS = [...TEXT_SLOTS, "image"] as const;
export const MAX_FAIL_STREAK = 3;
export const RULE_ID_PATTERN = /^rule-[a-z0-9-]{1,60}$/;
const HOUR_MS = 3_600_000;
const MAX_ERROR = 500;

const modelId = z.string().trim().max(200);
const termList = (max: number) => z.array(z.string().trim().min(1).max(100)).max(max);

export const ruleOptionsSchema = z.object({
  sections: z.number().int().min(2).max(12).default(5),
  headingLevel: z.enum(["h2", "h3"]).default("h2"),
  paragraphsPerSection: z.number().int().min(1).max(6).default(2),
  intro: z.boolean().default(true),
  outro: z.boolean().default(true),
  outroHeader: z.string().trim().max(80).default(""),
  toc: z.boolean().default(false),
  faq: z.boolean().default(false),
  featuredImage: z.boolean().default(true),
  collection: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).default("posts"),
  status: z.enum(["draft", "published"]).default("draft"),
  categories: termList(20).default([]),
  tags: termList(30).default([]),
  autoTags: z.boolean().default(false),
  // Content locale of created posts; also sets the writing language.
  locale: localeSchema.default("en"),
  // Blank = use the Settings value.
  style: z.string().trim().max(60).default(""),
  tone: z.string().trim().max(60).default(""),
  // Blank model = use Settings (the form sends blanks).
  models: z.partialRecord(z.enum(SLOT_KEYS), modelId).default({}),
  // Extra guidance sent with every step of this rule's posts.
  instructions: z.string().max(500).default(""),
  // Byline slug credited on created posts; blank = none.
  byline: z.string().trim().max(100).default(""),
});

// Where a rule's topics come from: the typed queue or new items in RSS/Atom
// feeds. Automatic sources refill the queue when it is empty and the rule is
// due. Rules stored with a retired source load as typed lists.
export const TOPIC_SOURCES = ["list", "rss"] as const;
export type TopicSource = (typeof TOPIC_SOURCES)[number];
export const MAX_FEEDS = 20;
// How many feed URLs a rule remembers to avoid repeats.
export const MAX_SOURCE_SEEN = 300;

const feedUrl = z
  .string()
  .trim()
  .max(500)
  .refine((s) => /^https:\/\/[^\s]+$/i.test(s), "Use a full https:// feed URL");

// Trimmed, blanks dropped, case-insensitive duplicates removed (first kept).
const topicsSchema = z
  .array(z.string().max(300))
  .max(500)
  .transform((list) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
      const topic = raw.trim();
      const key = topic.toLowerCase();
      if (!topic || seen.has(key)) continue;
      seen.add(key);
      out.push(topic);
    }
    return out;
  });

export const ruleInputSchema = z.object({
  id: z.string().regex(RULE_ID_PATTERN).optional(),
  name: z.string().trim().min(1).max(120),
  mode: z.enum(MODES).default("article"),
  topicMode: z.enum(["topic", "title"]).default("topic"),
  topics: topicsSchema.default([]),
  topicSource: z.enum(TOPIC_SOURCES).default("list"),
  feeds: z.array(feedUrl).max(MAX_FEEDS).default([]),
  intervalHours: z.number().int().min(1).max(168).default(24),
  postsPerRun: z.number().int().min(1).max(5).default(1),
  active: z.boolean().default(true),
  // prefault parses {} through the schema so nested defaults apply.
  options: ruleOptionsSchema.prefault({}),
});

export type RuleOptions = z.output<typeof ruleOptionsSchema>;
export type RuleInput = z.input<typeof ruleInputSchema>;
export type RuleConfig = z.output<typeof ruleInputSchema>;

export type Rule = Omit<RuleConfig, "id"> & {
  id: string;
  nextRunAt: string;
  lastRunAt?: string;
  pendingInRun: number;
  failStreak: number;
  /** Feed item URLs already queued (automatic sources only). */
  sourceSeen?: string[];
  /** Problems from the last topic fetch (e.g. a broken feed); kept apart from lastError, which a successful post clears. */
  sourceError?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type RuleOutcome = { kind: "ok" } | { kind: "skipped" } | { kind: "error"; message: string };

const iso = (d: Date) => d.toISOString();
const addHours = (d: Date, hours: number) => new Date(d.getTime() + hours * HOUR_MS);

// Rules stored before topic sources existed have no topicSource/feeds, and
// rules stored with the retired sports schedule keep "sports".
export function topicSourceOf(rule: Pick<Rule, "topicSource">): TopicSource {
  return TOPIC_SOURCES.includes(rule.topicSource) ? rule.topicSource : "list";
}

/** Cross-field checks the object schema cannot express (it must stay extendable). */
export function ruleConfigProblem(config: RuleConfig): string | null {
  if (config.topicSource === "rss" && config.feeds.length === 0) return "feeds: Add at least one RSS feed URL";
  return null;
}

// An automatic-source rule whose queue ran dry fetches new topics once it is due.
export function needsRefill(rule: Rule, now: Date): boolean {
  return (
    rule.active &&
    topicSourceOf(rule) !== "list" &&
    rule.topics.length === 0 &&
    rule.pendingInRun === 0 &&
    Date.parse(rule.nextRunAt) <= now.getTime()
  );
}

/** Queues refilled topics and remembers their keys; `found` empty = nothing new, so wait an interval. The fetch's error (or its absence) replaces sourceError. */
export function applyRefill(rule: Rule, found: Array<{ key: string; topic: string }>, now: Date, error?: string): Rule {
  const next: Rule = { ...rule, updatedAt: iso(now) };
  const known = new Set(rule.topics.map((t) => t.toLowerCase()));
  const added: string[] = [];
  for (const item of found) {
    const topic = item.topic.trim();
    if (!topic || known.has(topic.toLowerCase())) continue;
    known.add(topic.toLowerCase());
    added.push(topic);
  }
  next.topics = [...rule.topics, ...added];
  next.sourceSeen = [...(rule.sourceSeen ?? []), ...found.map((f) => f.key)].slice(-MAX_SOURCE_SEEN);
  if (error) next.sourceError = error.slice(0, MAX_ERROR);
  else delete next.sourceError;
  if (next.topics.length === 0) {
    next.lastRunAt = iso(now);
    next.nextRunAt = iso(addHours(now, rule.intervalHours));
  }
  return next;
}

export function newRuleId(now: Date, rand: () => number = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `rule-${now.getTime().toString(36)}-${suffix}`;
}

// A new rule is due immediately; its first post is written on the next tick.
export function createRule(config: RuleConfig, id: string, now: Date): Rule {
  const { id: _ignored, ...fields } = config;
  return {
    ...fields,
    id,
    nextRunAt: iso(now),
    pendingInRun: 0,
    failStreak: 0,
    createdAt: iso(now),
    updatedAt: iso(now),
  };
}

// Flip only the active flag, with the same side effects as updateRule:
// re-activation clears the failure streak; deactivation ends a run.
export function setRuleActive(rule: Rule, active: boolean, now: Date): Rule {
  const next: Rule = { ...rule, active, updatedAt: iso(now) };
  if (active && !rule.active) {
    next.failStreak = 0;
    delete next.lastError;
  }
  if (!active) next.pendingInRun = 0;
  return next;
}

// Edits keep the schedule and run state. Re-activating a rule clears its
// failure streak, so a rule paused after 3 failures gets a fresh start.
export function updateRule(existing: Rule, config: RuleConfig, now: Date): Rule {
  const { id: _ignored, active, ...fields } = config;
  const next = setRuleActive({ ...existing, ...fields, id: existing.id }, active, now);
  // A run in progress cannot outlast the edited queue or postsPerRun.
  next.pendingInRun = next.topics.length === 0 ? 0 : Math.min(next.pendingInRun, next.postsPerRun);
  if (existing.lastRunAt && fields.intervalHours !== existing.intervalHours) {
    next.nextRunAt = iso(addHours(new Date(existing.lastRunAt), fields.intervalHours));
  }
  return next;
}

export function isDue(rule: Rule, now: Date): boolean {
  if (!rule.active || rule.topics.length === 0) return false;
  return rule.pendingInRun > 0 || Date.parse(rule.nextRunAt) <= now.getTime();
}

// Rules with a run in progress first, then the longest overdue.
export function pickDueRules(rules: Rule[], now: Date, limit: number): Rule[] {
  const inProgress = (r: Rule) => (r.pendingInRun > 0 ? 1 : 0);
  return rules
    .filter((r) => isDue(r, now))
    .sort((a, b) => inProgress(b) - inProgress(a) || Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    .slice(0, limit);
}

// A scheduled run spans postsPerRun ticks (one post per rule per tick).
export function beginRun(rule: Rule): Rule {
  return rule.pendingInRun > 0 ? rule : { ...rule, pendingInRun: rule.postsPerRun };
}

function withoutTopic(topics: string[], topic: string): string[] {
  const i = topics.indexOf(topic);
  return i === -1 ? topics : [...topics.slice(0, i), ...topics.slice(i + 1)];
}

// Applies one post attempt's outcome. Manual runs ("Run now") consume the
// topic and record errors, but never touch the schedule, the run counter,
// the failure streak (except clearing it on success) or the active flag.
export function applyOutcome(rule: Rule, topic: string, outcome: RuleOutcome, now: Date, manual = false): Rule {
  const next: Rule = { ...rule, updatedAt: iso(now) };

  if (outcome.kind === "error") {
    next.lastError = outcome.message.slice(0, MAX_ERROR);
    if (manual) return next;
    next.failStreak = rule.failStreak + 1;
    if (next.failStreak >= MAX_FAIL_STREAK) {
      next.active = false;
      next.pendingInRun = 0;
    }
    return next;
  }

  next.topics = withoutTopic(rule.topics, topic);
  if (outcome.kind === "ok") {
    next.failStreak = 0;
    delete next.lastError;
  }
  if (manual) return next;

  if (outcome.kind === "ok") next.pendingInRun = Math.max(0, rule.pendingInRun - 1);
  if (next.pendingInRun === 0 || next.topics.length === 0) {
    next.pendingInRun = 0;
    next.lastRunAt = iso(now);
    next.nextRunAt = iso(addHours(now, rule.intervalHours));
  }
  return next;
}

export function pipelineOptionsFor(rule: Rule): PipelineOptions {
  const o = rule.options;
  return {
    mode: rule.mode,
    topicMode: rule.topicMode,
    sections: o.sections,
    headingLevel: o.headingLevel,
    paragraphsPerSection: o.paragraphsPerSection,
    intro: o.intro,
    outro: o.outro,
    outroHeader: o.outroHeader,
    toc: o.toc,
    faq: o.faq,
    featuredImage: o.featuredImage,
    collection: o.collection,
    status: o.status,
    categories: o.categories,
    tags: o.tags,
    autoTags: o.autoTags,
    // Rules stored before locales existed write in the default locale.
    locale: localeOf(o.locale),
    params: { style: o.style, tone: o.tone },
    models: o.models,
    instructions: o.instructions ?? "",
    byline: o.byline ?? "",
  };
}
