import type { ContentHandlers } from "./content";
import { createGenerationClient } from "./generation";
import { LinkJobError, runLinkJob, type LinkJobResult, type ListPublished } from "./internal-links";
import type { Provider } from "./providers";
import { runId, type RunRecord, type StoredRun } from "./runs";
import { readSettings, type KvLike, type Settings } from "./settings";
import type { StoreLike } from "./store";

// Publishing only queues a job (content hooks run with a short budget after
// the response); the 15-minute cron tick does the AI work.

export type LinkJob = {
  collection: string;
  postId: string;
  title: string;
  status: "queued" | "done" | "error" | "skipped";
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  error?: string;
};

// A publish counts as new only if the entry went live recently: republishing
// an older post (including the plugin's own backlink edits) never queues.
export const FRESH_PUBLISH_MS = 60 * 60_000;
export const MAX_LINK_ATTEMPTS = 3;
export const LINK_JOBS_PER_TICK = 2;
const MAX_ERROR = 500;

export const linkMarkerKey = (collection: string, id: string) => `linked:${collection}:${id}`;
export const linkJobId = (collection: string, id: string) => `link-${collection}-${id}`;

export type PublishedItem = {
  id?: unknown;
  status?: unknown;
  publishedAt?: unknown;
  createdAt?: unknown;
  data?: unknown;
};

const within = (iso: unknown, now: Date) => {
  if (typeof iso !== "string") return undefined;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now.getTime() - at <= FRESH_PUBLISH_MS : undefined;
};

/** Why a publish event gets no link job, or null when it should get one. */
export function skipReason(item: PublishedItem, collection: string, settings: Settings, now: Date): string | null {
  const cfg = settings.internalLinks;
  if (!cfg.enabled) return "internal linking is off";
  if (!cfg.collections.includes(collection)) return `collection "${collection}" is not linked`;
  if (typeof item.id !== "string" || !item.id) return "no id";
  if (item.status !== "published") return "not published";
  // New if it went live recently or was created recently (a backdated post
  // has an old publish date but was just written).
  const published = within(item.publishedAt, now);
  const created = within(item.createdAt, now);
  if (published === false && created !== true) return "an older post was republished";
  return null;
}

export type EnqueueDeps = { kv: KvLike; jobs: StoreLike<LinkJob>; now?: () => Date };

/** Queues a link job for a newly published entry, at most once per entry. */
export async function enqueueLinkJob(
  deps: EnqueueDeps,
  item: PublishedItem,
  collection: string,
): Promise<{ queued: boolean; reason?: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const reason = skipReason(item, collection, await readSettings(deps.kv), now);
  if (reason) return { queued: false, reason };
  const id = item.id as string;
  if (await deps.kv.get(linkMarkerKey(collection, id))) return { queued: false, reason: "already linked once" };
  await deps.kv.set(linkMarkerKey(collection, id), now.toISOString());
  const data = (item.data && typeof item.data === "object" ? item.data : {}) as { title?: unknown };
  await deps.jobs.put(linkJobId(collection, id), {
    collection,
    postId: id,
    title: typeof data.title === "string" ? data.title : "",
    status: "queued",
    attempts: 0,
    queuedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { queued: true };
}

export type LinkQueueDeps = {
  kv: KvLike;
  jobs: StoreLike<LinkJob>;
  runs: StoreLike<RunRecord>;
  content: Pick<ContentHandlers, "get" | "update" | "publish">;
  listPublished: ListPublished;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
  /** Test seam; defaults to runLinkJob. */
  runJob?: typeof runLinkJob;
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function describeLinks(result: LinkJobResult): string {
  const list = (refs: LinkJobResult["outbound"]) => refs.map((r) => `“${r.title}”`).join(", ");
  return [
    result.outbound.length > 0 ? `Links to ${list(result.outbound)}` : "No outbound links",
    result.inbound.length > 0 ? `linked from ${list(result.inbound)}` : "no backlinks",
  ].join("; ");
}

/** Runs up to `limit` queued jobs, oldest first, while `hasTime()` allows. */
export async function processLinkQueue(
  deps: LinkQueueDeps,
  opts: { limit?: number; hasTime?: () => boolean } = {},
): Promise<StoredRun[]> {
  const now = deps.now ?? (() => new Date());
  const queued = await deps.jobs.query({
    where: { status: "queued" },
    orderBy: { queuedAt: "asc" },
    limit: opts.limit ?? LINK_JOBS_PER_TICK,
  });
  const ran: StoredRun[] = [];
  for (const { id: jobId, data: job } of queued.items) {
    if (opts.hasTime && !opts.hasTime()) break;
    const settings = await readSettings(deps.kv);
    if (!settings.internalLinks.enabled) {
      await deps.jobs.put(jobId, { ...job, status: "skipped", updatedAt: now().toISOString() });
      continue;
    }
    const startedAt = now();
    const base = {
      source: "links" as const,
      topic: `Internal links: ${job.title || job.postId}`,
      postId: job.postId,
      editUrl: `/_emdash/admin/content/${job.collection}/${job.postId}`,
      startedAt: startedAt.toISOString(),
    };
    let record: RunRecord;
    let nextJob: LinkJob;
    try {
      await deps.getApiKey(settings.providers.text);
      const client = createGenerationClient({
        providers: settings.providers,
        getApiKey: deps.getApiKey,
        fetchImpl: deps.fetchImpl,
      });
      const result = await (deps.runJob ?? runLinkJob)(
        { client, settings, content: deps.content, listPublished: deps.listPublished },
        job.collection,
        job.postId,
      );
      record = {
        ...base,
        topic: `Internal links: ${result.title}`,
        status: "ok",
        details: describeLinks(result),
        warnings: result.warnings,
        calls: result.calls,
        cost: result.cost,
        tokens: result.tokens,
        finishedAt: now().toISOString(),
      };
      nextJob = { ...job, title: result.title, status: "done", attempts: job.attempts + 1, updatedAt: now().toISOString() };
    } catch (err) {
      const attempts = job.attempts + 1;
      // A job that can never succeed (post gone or unpublished) stops at once.
      const final = err instanceof LinkJobError || attempts >= MAX_LINK_ATTEMPTS;
      record = { ...base, status: "error", error: messageOf(err), warnings: [], calls: 0, finishedAt: now().toISOString() };
      nextJob = {
        ...job,
        status: final ? "error" : "queued",
        attempts,
        error: messageOf(err).slice(0, MAX_ERROR),
        updatedAt: now().toISOString(),
      };
    }
    try {
      await deps.jobs.put(jobId, nextJob);
    } catch (err) {
      deps.log?.(`Link job state could not be saved: ${messageOf(err)}`);
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
