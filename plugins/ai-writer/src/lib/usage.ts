import type { GenerateImageInput, GenerateImageOutput, GenerateTextInput, GenerateTextOutput } from "./openrouter";
import type { RunRecord } from "./runs";
import type { KvLike } from "./settings";
import type { StoreLike } from "./store";

// AI usage and cost. OpenRouter reports the exact cost (USD) of every call
// in its reply; each run records the sum, and the admin shows run totals next
// to the OpenRouter key's own usage and limit. MiniMax reports no cost.

export type Usage = { cost?: number; promptTokens?: number; completionTokens?: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function parseOpenRouterUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const usage: Usage = {
    cost: num(u.cost),
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
  };
  return usage.cost === undefined && usage.promptTokens === undefined && usage.completionTokens === undefined
    ? undefined
    : usage;
}

export type UsageTotals = { calls: number; cost: number; tokens: number };

export function emptyTotals(): UsageTotals {
  return { calls: 0, cost: 0, tokens: 0 };
}

export function addUsage(totals: { cost: number; tokens: number }, usage: Usage | undefined): void {
  if (!usage) return;
  totals.cost += usage.cost ?? 0;
  totals.tokens += (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

/** Rounds to a millionth of a dollar so stored costs stay readable. */
export const roundCost = (cost: number) => Math.round(cost * 1_000_000) / 1_000_000;

export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.0001) return "<$0.0001";
  return cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

type TextClient = { generateText(input: GenerateTextInput): Promise<GenerateTextOutput> };
type ImageClient = { generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> };

/**
 * Wraps a client so every call is counted and its reported usage summed.
 * A fallback retry inside one call counts once; a failed call adds no cost.
 */
export function meter<C extends TextClient & ImageClient>(client: C) {
  const state = emptyTotals();
  /** Last reported cost per image model, to show image prices in the pickers. */
  const imageCosts: Record<string, number> = {};
  return {
    state,
    imageCosts,
    client: {
      generateText: async (input: GenerateTextInput) => {
        state.calls++;
        const out = await client.generateText(input);
        addUsage(state, out.usage);
        return out;
      },
      generateImage: async (input: GenerateImageInput) => {
        state.calls++;
        const out = await client.generateImage(input);
        addUsage(state, out.usage);
        if (out.usage?.cost !== undefined && out.bytes.byteLength > 0) imageCosts[input.model] = out.usage.cost;
        return out;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Totals from run history

type SourceTotals = { cost: number; runs: number };

export type PeriodSummary = {
  cost: number;
  calls: number;
  tokens: number;
  runs: number;
  bySource: Partial<Record<RunRecord["source"], SourceTotals>>;
  /** New posts written (successful Bulk Rules and Express Mode runs). */
  posts: number;
  /** New posts whose run recorded a cost (runs before cost logging have none). */
  costedPosts: number;
  /** Writing cost of those costed posts. */
  costedPostsCost: number;
  /** Average writing cost per costed post (USD), null when there are none. */
  avgPostCost: number | null;
};

export type UsageSummary = { today: PeriodSummary; week: PeriodSummary; month: PeriodSummary; allTime: PeriodSummary };

const DAY_MS = 86_400_000;
const PAGE = 100;
const MAX_PAGES = 30;

function emptyPeriod(): PeriodSummary {
  return { cost: 0, calls: 0, tokens: 0, runs: 0, bySource: {}, posts: 0, costedPosts: 0, costedPostsCost: 0, avgPostCost: null };
}

function addRun(p: PeriodSummary, run: RunRecord): void {
  p.cost += run.cost ?? 0;
  p.calls += run.calls ?? 0;
  p.tokens += run.tokens ?? 0;
  p.runs++;
  const s = (p.bySource[run.source] ??= { cost: 0, runs: 0 });
  s.cost += run.cost ?? 0;
  s.runs++;
  if ((run.source === "rule" || run.source === "express") && run.status === "ok" && run.postId) {
    p.posts++;
    if (run.cost !== undefined) {
      p.costedPosts++;
      p.costedPostsCost += run.cost;
    }
  }
}

/** Sums recorded runs for today (UTC), the last 7 days, the last 30 days and all time. */
export async function summarizeRuns(store: StoreLike<RunRecord>, now: Date): Promise<UsageSummary> {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = now.getTime() - 7 * DAY_MS;
  const monthStart = now.getTime() - 30 * DAY_MS;
  const summary: UsageSummary = { today: emptyPeriod(), week: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await store.query({ orderBy: { startedAt: "desc" }, limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const { data: run } of res.items) {
      const at = Date.parse(run.startedAt);
      if (!Number.isFinite(at)) continue;
      addRun(summary.allTime, run);
      if (at < monthStart) continue;
      addRun(summary.month, run);
      if (at >= weekStart) addRun(summary.week, run);
      if (at >= todayStart) addRun(summary.today, run);
    }
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  for (const p of [summary.today, summary.week, summary.month, summary.allTime]) {
    p.cost = roundCost(p.cost);
    p.costedPostsCost = roundCost(p.costedPostsCost);
    p.avgPostCost = p.costedPosts > 0 ? roundCost(p.costedPostsCost / p.costedPosts) : null;
    for (const s of Object.values(p.bySource)) if (s) s.cost = roundCost(s.cost);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// OpenRouter key usage (account-wide, includes calls outside run history)

export type KeyUsage = {
  usage: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  limit: number | null;
  remaining: number | null;
};

export async function getOpenRouterKeyUsage(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<KeyUsage> {
  const res = await fetchImpl("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  const d = body.data ?? {};
  return {
    usage: num(d.usage) ?? 0,
    daily: num(d.usage_daily),
    weekly: num(d.usage_weekly),
    monthly: num(d.usage_monthly),
    limit: num(d.limit) ?? null,
    remaining: num(d.limit_remaining) ?? null,
  };
}

// ---------------------------------------------------------------------------
// MiniMax Token Plan (subscription) quota

export type PlanWindow = { remainingPercent: number; resetsAt: string };
export type MiniMaxPlan = { interval: PlanWindow; weekly: PlanWindow };

/** Remaining "general" (text, image and speech) quota of a MiniMax Token Plan key; null for a pay-as-you-go key. */
export async function getMiniMaxPlanRemains(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<MiniMaxPlan | null> {
  const res = await fetchImpl("https://www.minimax.io/v1/token_plan/remains", {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`MiniMax ${res.status}`);
  const body = (await res.json()) as { model_remains?: Array<Record<string, unknown>> };
  const general = (body.model_remains ?? []).find((m) => m.model_name === "general");
  if (!general) return null;
  const pct = (v: unknown) => Math.max(0, Math.min(100, num(v) ?? 0));
  const at = (v: unknown) => new Date(num(v) ?? 0).toISOString();
  return {
    interval: { remainingPercent: pct(general.current_interval_remaining_percent), resetsAt: at(general.end_time) },
    weekly: { remainingPercent: pct(general.current_weekly_remaining_percent), resetsAt: at(general.weekly_end_time) },
  };
}

/** Warn when either Token Plan window has less than this share left. */
export const LOW_PLAN_PERCENT = 10;

export type UsageResponse = {
  summary: UsageSummary;
  openrouter: KeyUsage | null;
  openrouterError?: string;
  /** MiniMax Token Plan quota (null when no MiniMax key, or a pay-as-you-go key). */
  minimax: MiniMaxPlan | null;
  minimaxError?: string;
  lowPlan: boolean;
  /** Low-credit warning: threshold from Settings (0 = off) and whether credit is below it. */
  lowCredit: { threshold: number; low: boolean };
};

/** Admin route: run-history totals plus the OpenRouter key's usage and limit. */
export async function usageRoute(deps: {
  runs: StoreLike<RunRecord>;
  getOpenRouterKey(): Promise<string>;
  /** Present when a MiniMax key is bound. */
  getMiniMaxKey?(): Promise<string>;
  /** Low-credit threshold in USD from Settings (0 = off). */
  lowCreditThreshold: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<UsageResponse> {
  const summary = await summarizeRuns(deps.runs, (deps.now ?? (() => new Date()))());
  const threshold = deps.lowCreditThreshold;
  const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const [openrouter, minimax] = await Promise.all([
    deps
      .getOpenRouterKey()
      .then((key) => getOpenRouterKeyUsage(key, deps.fetchImpl))
      .then((value) => ({ value }), (error: unknown) => ({ error: messageOf(error) })),
    deps.getMiniMaxKey
      ? deps
          .getMiniMaxKey()
          .then((key) => getMiniMaxPlanRemains(key, deps.fetchImpl))
          .then((value) => ({ value }), (error: unknown) => ({ error: messageOf(error) }))
      : Promise.resolve({ value: null }),
  ]);
  const key = "value" in openrouter ? openrouter.value : null;
  const plan = "value" in minimax ? minimax.value : null;
  return {
    summary,
    openrouter: key,
    ...("error" in openrouter ? { openrouterError: openrouter.error } : {}),
    minimax: plan,
    ...("error" in minimax ? { minimaxError: minimax.error } : {}),
    lowPlan: !!plan && (plan.interval.remainingPercent < LOW_PLAN_PERCENT || plan.weekly.remainingPercent < LOW_PLAN_PERCENT),
    lowCredit: { threshold, low: !!key && threshold > 0 && key.remaining !== null && key.remaining < threshold },
  };
}

// ---------------------------------------------------------------------------
// Observed image prices

export const IMAGE_PRICES_KEY = "observed-image-prices";

export async function readImagePrices(kv: KvLike): Promise<Record<string, number>> {
  const stored = await kv.get<Record<string, unknown>>(IMAGE_PRICES_KEY);
  const out: Record<string, number> = {};
  for (const [model, cost] of Object.entries(stored ?? {})) {
    if (typeof cost === "number" && Number.isFinite(cost)) out[model] = cost;
  }
  return out;
}

/** Remembers the latest cost per image model; best-effort, never throws. */
export async function recordImagePrices(kv: KvLike, costs: Record<string, number>): Promise<void> {
  if (Object.keys(costs).length === 0) return;
  try {
    await kv.set(IMAGE_PRICES_KEY, { ...(await readImagePrices(kv)), ...costs });
  } catch {
    // Prices are a display nicety; a failed write must not fail the job.
  }
}

/** "$0.75 / $3.75 per 1M tokens" from per-token prices. */
export function formatTokenPrices(prompt?: number, completion?: number): string {
  if (prompt === undefined && completion === undefined) return "";
  const perM = (p?: number) => {
    if (p === undefined) return "?";
    const v = p * 1_000_000;
    return `$${v.toFixed(v > 0 && v < 0.1 ? 3 : 2)}`;
  };
  return `${perM(prompt)} in / ${perM(completion)} out per 1M tokens`;
}

