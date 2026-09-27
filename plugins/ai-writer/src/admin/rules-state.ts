import {
  MAX_FAIL_STREAK,
  ruleInputSchema,
  ruleOptionsSchema,
  topicSourceOf,
  type Rule,
  type RuleInput,
  type RuleOptions,
  type TopicSource,
} from "../lib/rules";

// Editable shape of a rule in the admin; topics are edited one per line.
export type RuleForm = {
  id?: string;
  // The stored rule's updatedAt when the form was opened (edit conflict check).
  updatedAt?: string;
  name: string;
  topicMode: "topic" | "title";
  topicSource: TopicSource;
  topicsText: string;
  feedsText: string;
  intervalHours: number;
  postsPerRun: number;
  active: boolean;
  options: RuleOptions;
};

export function emptyRuleForm(): RuleForm {
  const defaults = ruleInputSchema.omit({ id: true, name: true }).parse({});
  return {
    name: "",
    topicMode: defaults.topicMode,
    topicSource: defaults.topicSource,
    topicsText: "",
    feedsText: "",
    intervalHours: defaults.intervalHours,
    postsPerRun: defaults.postsPerRun,
    active: defaults.active,
    options: defaults.options,
  };
}

export function formFromRule(rule: Rule): RuleForm {
  return {
    id: rule.id,
    updatedAt: rule.updatedAt,
    name: rule.name,
    topicMode: rule.topicMode,
    // Rules stored with the retired sports schedule open as typed lists.
    topicSource: topicSourceOf(rule),
    topicsText: rule.topics.join("\n"),
    feedsText: (rule.feeds ?? []).join("\n"),
    intervalHours: rule.intervalHours,
    postsPerRun: rule.postsPerRun,
    active: rule.active,
    // Rules saved before instructions/byline/locale existed get their defaults.
    options: { ...ruleOptionsSchema.parse({}), ...structuredClone(rule.options) },
  };
}

// The server schema trims, dedupes and validates; the form sends raw lines.
// Edits carry expectedUpdatedAt so the server refuses to overwrite a rule
// that changed after the form was opened.
export function ruleInputFromForm(form: RuleForm): RuleInput & { expectedUpdatedAt?: string } {
  return {
    ...(form.id ? { id: form.id, expectedUpdatedAt: form.updatedAt } : {}),
    name: form.name.trim(),
    mode: "article",
    topicMode: form.topicMode,
    topicSource: form.topicSource,
    topics: form.topicsText.split(/\r?\n/),
    feeds: form.feedsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    intervalHours: form.intervalHours,
    postsPerRun: form.postsPerRun,
    active: form.active,
    options: form.options,
  };
}

export function topicCount(text: string): number {
  const lines = text.split(/\r?\n/);
  const parsed = ruleInputSchema.shape.topics.safeParse(lines);
  return parsed.success ? parsed.data.length : lines.filter((l) => l.trim()).length;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatWhen(iso: string | undefined, now: Date): string {
  if (!iso) return "—";
  const diff = Date.parse(iso) - now.getTime();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff >= 0 ? "now" : "just now";
  const unit =
    abs < HOUR ? `${Math.round(abs / MINUTE)}m` : abs < DAY ? `${Math.round(abs / HOUR)}h` : `${Math.round(abs / DAY)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function ruleStatus(rule: Rule): string {
  if (!rule.active) {
    return rule.failStreak >= MAX_FAIL_STREAK ? `Paused after ${rule.failStreak} failures` : "Paused";
  }
  if (rule.topics.length === 0) {
    return topicSourceOf(rule) === "list" ? "Queue empty" : "Waiting for new topics";
  }
  if (rule.pendingInRun > 0) return `Running (${rule.pendingInRun} left)`;
  return "Scheduled";
}
