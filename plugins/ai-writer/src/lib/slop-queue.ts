import { z } from "zod";
import type { ContentHandlers } from "./content";
import { createGenerationClient } from "./generation";
import { hasPendingDraft, type LinkEntry } from "./internal-links";
import { localeOf } from "./locale";
import type { Provider } from "./providers";
import { parse } from "./routes";
import { runId, type RunRecord, type StoredRun } from "./runs";
import { readSettings, type KvLike } from "./settings";
import { deslopArticle, describeSlop, SlopEditError, slopAskFor } from "./slop";
import type { StoreLike } from "./store";
import { addUsage, roundCost } from "./usage";

// No-AI-slop clean-up of posts that already exist: jobs are queued from the
// admin (or in bulk) and the 15-minute tick edits and republishes them.

export type SlopJob = {
  collection: string;
  postId: string;
  title: string;
  status: "queued" | "done" | "error" | "skipped";
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  error?: string;
};

export const MAX_SLOP_ATTEMPTS = 3;
export const SLOP_JOBS_PER_TICK = 4;
const MAX_ERROR = 500;

export const slopJobId = (collection: string, id: string) => `slop-${collection}-${id}`;

/** Queues (or re-queues) entries; an entry already waiting in the queue is left as it is. */
export async function enqueueSlopJobs(
  deps: { jobs: StoreLike<SlopJob>; now?: () => Date },
  collection: string,
  ids: string[],
): Promise<{ queued: number; alreadyQueued: number }> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let queued = 0;
  let alreadyQueued = 0;
  for (const postId of [...new Set(ids)]) {
    const id = slopJobId(collection, postId);
    const existing = await deps.jobs.get(id);
    if (existing?.status === "queued") {
      alreadyQueued++;
      continue;
    }
    await deps.jobs.put(id, {
      collection,
      postId,
      title: existing?.title ?? "",
      status: "queued",
      attempts: 0,
      queuedAt: now,
      updatedAt: now,
    });
    queued++;
  }
  return { queued, alreadyQueued };
}

export const slopQueueSchema = z.object({
  collection: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).default("posts"),
  ids: z.array(z.string().trim().min(1).max(100)).min(1).max(200),
});

/** Admin route: queue a no-AI-slop edit for the given entries. */
export async function queueSlopRoute(
  deps: { jobs: StoreLike<SlopJob>; now?: () => Date },
  input: unknown,
): Promise<{ queued: number; alreadyQueued: number }> {
  const req = parse(slopQueueSchema, input);
  return enqueueSlopJobs(deps, req.collection, req.ids);
}

export type SlopQueueDeps = {
  kv: KvLike;
  jobs: StoreLike<SlopJob>;
  runs: StoreLike<RunRecord>;
  content: Pick<ContentHandlers, "get" | "update" | "publish">;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A job that will not succeed on retry (e.g. the post is gone). */
class FinalSlopError extends Error {}

export async function processSlopQueue(
  deps: SlopQueueDeps,
  opts: { limit?: number; hasTime?: () => boolean } = {},
): Promise<StoredRun[]> {
  const now = deps.now ?? (() => new Date());
  const queued = await deps.jobs.query({
    where: { status: "queued" },
    orderBy: { queuedAt: "asc" },
    limit: opts.limit ?? SLOP_JOBS_PER_TICK,
  });
  const ran: StoredRun[] = [];
  for (const { id: jobId, data: job } of queued.items) {
    if (opts.hasTime && !opts.hasTime()) break;
    const startedAt = now();
    const base = {
      source: "slop" as const,
      postId: job.postId,
      editUrl: `/_emdash/admin/content/${job.collection}/${job.postId}`,
      startedAt: startedAt.toISOString(),
    };
    let record: RunRecord;
    let nextJob: SlopJob;
    let title = job.title;
    try {
      const got = await deps.content.get(job.collection, job.postId);
      if (got.success === false) throw new FinalSlopError(got.error?.message ?? "Post not found");
      const entry = got.data.item as LinkEntry;
      if (typeof entry.data?.title === "string") title = entry.data.title;
      if (hasPendingDraft(entry)) {
        record = {
          ...base,
          topic: `No AI slop: ${title}`,
          status: "skipped",
          error: "The post has unpublished editor changes",
          warnings: [],
          calls: 0,
          finishedAt: now().toISOString(),
        };
        nextJob = { ...job, title, status: "skipped", updatedAt: now().toISOString() };
      } else {
        const settings = await readSettings(deps.kv);
        await deps.getApiKey(settings.providers.text);
        let calls = 0;
        const spend = { cost: 0, tokens: 0 };
        const ask = slopAskFor(
          createGenerationClient({ providers: settings.providers, getApiKey: deps.getApiKey, fetchImpl: deps.fetchImpl }),
          settings,
        );
        const content = Array.isArray(entry.data?.content) ? (entry.data.content as unknown[]) : [];
        const excerpt = typeof entry.data?.excerpt === "string" ? entry.data.excerpt : "";
        const result = await deslopArticle(
          async (system, prompt) => {
            calls++;
            const out = await ask(system, prompt);
            addUsage(spend, out.usage);
            return out;
          },
          { title, excerpt, content, locale: localeOf(entry.locale) },
        );
        const warnings: string[] = result.partErrors.map((e) => `Part left as written: ${e}`);
        if (result.editedBlocks + result.removedBlocks > 0 || result.excerpt !== excerpt) {
          const updated = await deps.content.update(job.collection, entry.id, {
            data: { content: result.content, ...(result.excerpt ? { excerpt: result.excerpt } : {}) },
          });
          if (updated.success === false) throw new Error(updated.error?.message ?? "The post could not be updated");
          if (entry.status === "published") {
            const published = await deps.content.publish(job.collection, entry.id);
            if (published.success === false) {
              warnings.push(`Saved as a draft; publishing failed: ${published.error?.message ?? "unknown error"}`);
            }
          }
        }
        record = {
          ...base,
          topic: `No AI slop: ${title}`,
          status: "ok",
          details: describeSlop(result),
          warnings,
          calls,
          cost: roundCost(spend.cost),
          tokens: spend.tokens,
          finishedAt: now().toISOString(),
        };
        nextJob = { ...job, title, status: "done", attempts: job.attempts + 1, updatedAt: now().toISOString() };
      }
    } catch (err) {
      const attempts = job.attempts + 1;
      // A missing post, or an edit the safety checks refused, will not improve on retry.
      const final = err instanceof FinalSlopError || err instanceof SlopEditError || attempts >= MAX_SLOP_ATTEMPTS;
      record = {
        ...base,
        topic: `No AI slop: ${title || job.postId}`,
        status: "error",
        error: messageOf(err),
        warnings: [],
        calls: 0,
        finishedAt: now().toISOString(),
      };
      nextJob = {
        ...job,
        title,
        status: final ? "error" : "queued",
        attempts,
        error: messageOf(err).slice(0, MAX_ERROR),
        updatedAt: now().toISOString(),
      };
    }
    try {
      await deps.jobs.put(jobId, nextJob);
    } catch (err) {
      deps.log?.(`No-AI-slop job state could not be saved: ${messageOf(err)}`);
    }
    const id = runId(startedAt);
    try {
      await deps.runs.put(id, record);
    } catch (err) {
      deps.log?.(`Run history could not be recorded: ${messageOf(err)}`);
    }
    ran.push({ ...record, id });
  }
  return ran;
}
