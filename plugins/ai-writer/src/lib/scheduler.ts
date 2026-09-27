import type { GetCollectionInfo } from "./collections";
import { DuplicateTopicError, type ContentHandlers } from "./content";
import { createGenerationClient } from "./generation";
import type { MediaUploader } from "./image";
import { runPipeline } from "./pipeline";
import type { Provider } from "./providers";
import {
  applyOutcome,
  applyRefill,
  beginRun,
  isDue,
  needsRefill,
  pickDueRules,
  pipelineOptionsFor,
  topicSourceOf,
  type Rule,
  type RuleOutcome,
} from "./rules";
import { runId, type RunRecord, type StoredRun } from "./runs";
import { readSettings, type KvLike } from "./settings";
import { listAll, type StoreLike } from "./store";
import { findTopics } from "./topic-sources";
import { recordImagePrices } from "./usage";
import { processLinkQueue, type LinkQueueDeps } from "./link-queue";
import { processSlopQueue, type SlopQueueDeps } from "./slop-queue";
import type { TermRef } from "./types";

export const TICK_LOCK_KEY = "tick-lock";
export const LOCK_STALE_MS = 10 * 60_000;
export const RULES_PER_TICK = 4;
// Rules and link jobs start only within this budget; a started post may run
// past it, still well inside the 9-minute cron timeout.
export const TICK_BUDGET_MS = 5 * 60_000;

export type LockKv = KvLike & { delete(key: string): Promise<boolean> };
type TickLock = { at: string; token: string };

export type SchedulerDeps = {
  kv: LockKv;
  rules: StoreLike<Rule>;
  runs: StoreLike<RunRecord>;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  media?: MediaUploader;
  content: ContentHandlers;
  getTerms(taxonomy: "category" | "tag", locale?: string): Promise<TermRef[]>;
  getCollectionInfo?: GetCollectionInfo;
  getBylineId?(slug: string): Promise<string | null>;
  now?: () => Date;
  /** Test seam; defaults to runPipeline. */
  pipeline?: typeof runPipeline;
  /** Test seam; defaults to findTopics. */
  findTopics?: typeof findTopics;
  /** Internal-linking queue, processed after the rules when there is time left. */
  links?: Pick<LinkQueueDeps, "jobs" | "listPublished" | "runJob">;
  /** No-AI-slop clean-up queue for existing posts, processed after the link jobs. */
  slop?: Pick<SlopQueueDeps, "jobs">;
  log?: (message: string) => void;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Best-effort: plugin KV has no compare-and-set, so re-reading the token only
// narrows the race. EmDash's cron executor never runs one task twice at once;
// this also covers a tick that overlaps stale-lock recovery.
export async function acquireTickLock(kv: LockKv, now: Date, token: string): Promise<boolean> {
  const held = await kv.get<TickLock>(TICK_LOCK_KEY);
  if (held && now.getTime() - Date.parse(held.at) < LOCK_STALE_MS) return false;
  await kv.set(TICK_LOCK_KEY, { at: now.toISOString(), token } satisfies TickLock);
  const check = await kv.get<TickLock>(TICK_LOCK_KEY);
  return check?.token === token;
}

export async function releaseTickLock(kv: LockKv, token: string): Promise<void> {
  const held = await kv.get<TickLock>(TICK_LOCK_KEY);
  if (held?.token === token) await kv.delete(TICK_LOCK_KEY);
}

export async function listRules(store: StoreLike<Rule>): Promise<Rule[]> {
  return (await listAll(store)).map((item) => ({ ...item.data, id: item.id }));
}

// Generates one post from the head of the rule's queue, then records the
// outcome on the rule (re-read first so concurrent edits survive) and in
// the run history. Never throws for generation failures.
export async function runRuleOnce(deps: SchedulerDeps, rule: Rule, manual: boolean): Promise<StoredRun> {
  const now = deps.now ?? (() => new Date());
  const topic = rule.topics[0];
  if (topic === undefined) throw new Error(`Rule ${rule.id} has no topics left`);
  const startedAt = now();
  const base = {
    source: "rule" as const,
    ruleId: rule.id,
    ruleName: rule.name,
    topic,
    startedAt: startedAt.toISOString(),
  };

  let outcome: RuleOutcome;
  let record: RunRecord;
  try {
    const settings = await readSettings(deps.kv);
    // Every rule run needs text, so a missing text key fails the attempt up front.
    await deps.getApiKey(settings.providers.text);
    const client = createGenerationClient({
      providers: settings.providers,
      getApiKey: deps.getApiKey,
      fetchImpl: deps.fetchImpl,
    });
    const result = await (deps.pipeline ?? runPipeline)(
      {
        client,
        settings,
        media: deps.media,
        content: deps.content,
        getTerms: deps.getTerms,
        getCollectionInfo: deps.getCollectionInfo,
        getBylineId: deps.getBylineId,
      },
      topic,
      pipelineOptionsFor(rule),
    );
    outcome = { kind: "ok" };
    await recordImagePrices(deps.kv, result.imageCosts ?? {});
    record = {
      ...base,
      status: "ok",
      postId: result.postId,
      editUrl: `/_emdash/admin/content/${rule.options.collection}/${result.postId}`,
      warnings: result.warnings,
      calls: result.calls,
      cost: result.cost,
      tokens: result.tokens,
      finishedAt: now().toISOString(),
    };
  } catch (err) {
    const skipped = err instanceof DuplicateTopicError;
    outcome = skipped ? { kind: "skipped" } : { kind: "error", message: messageOf(err) };
    record = {
      ...base,
      status: skipped ? "skipped" : "error",
      error: messageOf(err),
      warnings: [],
      calls: 0,
      finishedAt: now().toISOString(),
    };
  }

  // The post already exists at this point; a failed rule write must not
  // lose its run record.
  try {
    const fresh = await deps.rules.get(rule.id);
    if (fresh) {
      await deps.rules.put(rule.id, applyOutcome({ ...fresh, id: rule.id }, topic, outcome, now(), manual));
    }
  } catch (err) {
    deps.log?.(`Rule state could not be saved: ${messageOf(err)}`);
  }

  const id = runId(startedAt);
  try {
    await deps.runs.put(id, record);
  } catch (err) {
    deps.log?.(`Run history could not be recorded: ${messageOf(err)}`);
  }
  return { ...record, id };
}

// Fills an automatic-source rule's empty queue from its source and stores the
// result (re-read first so concurrent edits survive). Never throws for source
// failures; they land on the rule's lastError.
export async function refillRule(deps: SchedulerDeps, rule: Rule): Promise<Rule> {
  const now = deps.now ?? (() => new Date());
  let found: Awaited<ReturnType<typeof findTopics>>;
  try {
    found = await (deps.findTopics ?? findTopics)(rule, { now: now(), fetchImpl: deps.fetchImpl });
  } catch (err) {
    found = { found: [], error: messageOf(err) };
  }
  const fresh = await deps.rules.get(rule.id);
  if (!fresh) return rule;
  const next = applyRefill({ ...fresh, id: rule.id }, found.found, now(), found.error);
  await deps.rules.put(rule.id, next);
  return next;
}

export class RuleBusyError extends Error {
  constructor() {
    super("A scheduled run is in progress. Try again in a few minutes.");
    this.name = "RuleBusyError";
  }
}

const lockToken = (at: Date) => `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Manual "Run now": takes the same KV lock as the cron tick so the two can
// never generate from the same queue head at once. Re-reads the rule after
// acquiring the lock (a tick may have consumed topics). Returns null when the
// rule is gone or its queue is empty by then.
export async function runRuleManually(deps: SchedulerDeps, ruleId: string): Promise<StoredRun | null> {
  const now = deps.now ?? (() => new Date());
  const token = lockToken(now());
  if (!(await acquireTickLock(deps.kv, now(), token))) throw new RuleBusyError();
  try {
    const stored = await deps.rules.get(ruleId);
    if (!stored) return null;
    let rule: Rule = { ...stored, id: ruleId };
    // "Run now" on an automatic source fetches topics without waiting for the schedule.
    if (rule.topics.length === 0 && topicSourceOf(rule) !== "list") rule = await refillRule(deps, rule);
    if (rule.topics.length === 0) return null;
    return await runRuleOnce(deps, rule, true);
  } finally {
    await releaseTickLock(deps.kv, token);
  }
}

export async function cronTick(deps: SchedulerDeps): Promise<{ locked: boolean; ran: StoredRun[] }> {
  const now = deps.now ?? (() => new Date());
  const token = lockToken(now());
  if (!(await acquireTickLock(deps.kv, now(), token))) return { locked: true, ran: [] };

  const ran: StoredRun[] = [];
  try {
    const started = now().getTime();
    let listedRules = await listRules(deps.rules);
    const refills = listedRules.filter((rule) => needsRefill(rule, now()));
    for (const rule of refills) {
      try {
        await refillRule(deps, rule);
      } catch (err) {
        deps.log?.(`Topics for rule ${rule.id} could not be refilled: ${messageOf(err)}`);
      }
    }
    if (refills.length > 0) listedRules = await listRules(deps.rules);
    const due = pickDueRules(listedRules, now(), RULES_PER_TICK);
    for (const listed of due) {
      if (ran.length > 0 && now().getTime() - started > TICK_BUDGET_MS) break;
      // Re-read: an earlier rule's run takes minutes, during which this rule
      // may have been deleted, paused or had its queue edited.
      const stored = await deps.rules.get(listed.id);
      if (!stored) continue;
      const rule: Rule = { ...stored, id: listed.id };
      if (!isDue(rule, now())) continue;
      const inRun = beginRun(rule);
      // Persist the run counter first: runRuleOnce re-reads the stored rule.
      if (inRun !== rule) await deps.rules.put(rule.id, inRun);
      ran.push(await runRuleOnce(deps, inRun, false));
    }
    if (deps.links && now().getTime() - started <= TICK_BUDGET_MS) {
      try {
        ran.push(
          ...(await processLinkQueue(
            {
              ...deps.links,
              kv: deps.kv,
              runs: deps.runs,
              content: deps.content,
              getApiKey: deps.getApiKey,
              fetchImpl: deps.fetchImpl,
              now: deps.now,
              log: deps.log,
            },
            { hasTime: () => now().getTime() - started <= TICK_BUDGET_MS },
          )),
        );
      } catch (err) {
        deps.log?.(`Internal links could not be processed: ${messageOf(err)}`);
      }
    }
    if (deps.slop && now().getTime() - started <= TICK_BUDGET_MS) {
      try {
        ran.push(
          ...(await processSlopQueue(
            {
              jobs: deps.slop.jobs,
              kv: deps.kv,
              runs: deps.runs,
              content: deps.content,
              getApiKey: deps.getApiKey,
              fetchImpl: deps.fetchImpl,
              now: deps.now,
              log: deps.log,
            },
            { hasTime: () => now().getTime() - started <= TICK_BUDGET_MS },
          )),
        );
      } catch (err) {
        deps.log?.(`No-AI-slop jobs could not be processed: ${messageOf(err)}`);
      }
    }
  } finally {
    await releaseTickLock(deps.kv, token);
  }
  return { locked: false, ran };
}
