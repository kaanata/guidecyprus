import { z } from "zod";
import { parse, RouteError } from "./routes";
import {
  createRule,
  newRuleId,
  RULE_ID_PATTERN,
  ruleConfigProblem,
  ruleInputSchema,
  setRuleActive,
  topicSourceOf,
  updateRule,
  type Rule,
} from "./rules";
import { listRuns, type RunRecord, type StoredRun } from "./runs";
import { listRules, RuleBusyError } from "./scheduler";
import type { StoreLike } from "./store";

export type RuleRouteDeps = {
  rules: StoreLike<Rule>;
  runs: StoreLike<RunRecord>;
  now?: () => Date;
  /**
   * Runs one manual ("Run now") attempt; see scheduler.runRuleManually.
   * Throws RuleBusyError while a tick runs; null when the queue emptied.
   */
  runRule(rule: Rule): Promise<StoredRun | null>;
  /** (Re)registers the cron tick; a failure becomes a warning, never an error. */
  ensureTick?: () => Promise<void>;
  /** Runs one scheduler tick now (see scheduler.cronTick). */
  tick?: () => Promise<{ locked: boolean; ran: StoredRun[] }>;
};

const idSchema = z.object({ id: z.string().regex(RULE_ID_PATTERN) });
const toggleSchema = z.object({ id: z.string().regex(RULE_ID_PATTERN), active: z.boolean() });
const saveSchema = ruleInputSchema.extend({ expectedUpdatedAt: z.string().max(40).optional() });
const runsQuerySchema = z.object({
  ruleId: z.string().regex(RULE_ID_PATTERN).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function createRuleHandlers(deps: RuleRouteDeps) {
  const now = deps.now ?? (() => new Date());

  async function load(id: string): Promise<Rule> {
    const rule = await deps.rules.get(id);
    if (!rule) throw new RouteError("not_found", `Rule ${id} does not exist`);
    return { ...rule, id };
  }

  async function registerTick(): Promise<string[]> {
    if (!deps.ensureTick) return [];
    try {
      await deps.ensureTick();
      return [];
    } catch (err) {
      return [`The schedule could not be registered: ${(err as Error).message}`];
    }
  }

  return {
    async list(): Promise<{ rules: Rule[] }> {
      const rules = await listRules(deps.rules);
      rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { rules };
    },

    async save(input: unknown): Promise<{ rule: Rule; warnings: string[] }> {
      // expectedUpdatedAt is a concurrency check only; it is never stored.
      const { expectedUpdatedAt, ...config } = parse(saveSchema, input);
      const problem = ruleConfigProblem(config);
      if (problem) throw new RouteError("invalid_input", problem);
      let rule: Rule;
      if (config.id) {
        const current = await load(config.id);
        if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
          throw new RouteError(
            "conflict",
            "This rule changed after you opened it (a run used a topic, or it was edited elsewhere). Reload the page and try again.",
          );
        }
        rule = updateRule(current, config, now());
      } else {
        rule = createRule(config, newRuleId(now()), now());
      }
      await deps.rules.put(rule.id, rule);
      return { rule, warnings: await registerTick() };
    },

    // Flips only the active flag on the stored rule, so a stale page cannot
    // overwrite its queue or run state.
    async toggle(input: unknown): Promise<{ rule: Rule; warnings: string[] }> {
      const { id, active } = parse(toggleSchema, input);
      const rule = setRuleActive(await load(id), active, now());
      await deps.rules.put(rule.id, rule);
      return { rule, warnings: await registerTick() };
    },

    async remove(input: unknown): Promise<{ ok: true }> {
      const { id } = parse(idSchema, input);
      if (!(await deps.rules.delete(id))) throw new RouteError("not_found", `Rule ${id} does not exist`);
      return { ok: true };
    },

    async run(input: unknown): Promise<{ run: StoredRun }> {
      const { id } = parse(idSchema, input);
      const rule = await load(id);
      const automatic = topicSourceOf(rule) !== "list";
      const emptyMessage = automatic ? "No new topics were found for this rule" : "This rule has no topics left";
      if (rule.topics.length === 0 && !automatic) throw new RouteError("empty_queue", emptyMessage);
      let run: StoredRun | null;
      try {
        run = await deps.runRule(rule);
      } catch (err) {
        if (err instanceof RuleBusyError) throw new RouteError("busy", err.message);
        throw err;
      }
      // A tick that held the lock may have used the last topic meanwhile.
      if (run === null) throw new RouteError("empty_queue", emptyMessage);
      return { run };
    },

    // "Run due rules now" from the dashboard widget: exactly what the
    // 15-minute cron tick does, on demand.
    async tick(): Promise<{ ran: StoredRun[] }> {
      if (!deps.tick) throw new RouteError("unavailable", "The scheduler is unavailable");
      const { locked, ran } = await deps.tick();
      if (locked) throw new RouteError("busy", new RuleBusyError().message);
      return { ran };
    },

    async runs(query: unknown): Promise<{ runs: StoredRun[] }> {
      const q = parse(runsQuerySchema, query);
      return { runs: await listRuns(deps.runs, { ruleId: q.ruleId, limit: q.limit }) };
    },
  };
}

export type RuleHandlers = ReturnType<typeof createRuleHandlers>;
