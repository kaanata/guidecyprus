import type { StoreLike } from "./store";

export type RunRecord = {
  source: "rule" | "express" | "panel" | "bulk" | "links" | "slop";
  ruleId?: string;
  ruleName?: string;
  topic?: string;
  postId?: string;
  editUrl?: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  /** Human-readable outcome summary (e.g. which posts were linked). */
  details?: string;
  /** Exact AI cost in USD reported by the provider (absent when it reports none). */
  cost?: number;
  tokens?: number;
  warnings: string[];
  calls: number;
  startedAt: string;
  finishedAt: string;
};

export type StoredRun = RunRecord & { id: string };

export function runId(now: Date, rand: () => number = Math.random): string {
  const suffix = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `run-${now.getTime().toString(36)}-${suffix}`;
}

// Newest first; `startedAt` and `ruleId` are the runs collection's indexes.
export async function listRuns(
  store: StoreLike<RunRecord>,
  opts: { ruleId?: string; limit: number },
): Promise<StoredRun[]> {
  const res = await store.query({
    ...(opts.ruleId ? { where: { ruleId: opts.ruleId } } : {}),
    orderBy: { startedAt: "desc" },
    limit: opts.limit,
  });
  return res.items.map((item) => ({ ...item.data, id: item.id }));
}
