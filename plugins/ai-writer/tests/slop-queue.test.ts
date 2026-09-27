import { describe, expect, it, vi } from "vitest";
import type { ContentHandlers, UpdateBody } from "../src/lib/content";
import { insertLink, linkedHrefs, type LinkEntry } from "../src/lib/internal-links";
import type { RunRecord } from "../src/lib/runs";
import { enqueueSlopJobs, MAX_SLOP_ATTEMPTS, processSlopQueue, queueSlopRoute, slopJobId, type SlopJob, type SlopQueueDeps } from "../src/lib/slop-queue";
import { chatResponse, memoryKv, memoryStore } from "./helpers";

const NOW = new Date("2026-09-15T15:00:00.000Z");
const block = (key: string, text: string, style = "normal") => ({
  _type: "block",
  _key: key,
  style,
  markDefs: [] as Array<Record<string, unknown>>,
  children: [{ _type: "span", _key: `${key}s`, text, marks: [] as string[] }],
});

const POST: LinkEntry = {
  id: "p1",
  slug: "kyrenia-harbour",
  status: "published",
  liveRevisionId: "r1",
  draftRevisionId: null,
  data: {
    title: "Kyrenia Harbour",
    excerpt: "A robust look.",
    content: [
      block("h", "Why visit", "h2"),
      ...(insertLink([block("a", "Visitors delve into the old town to find the harbour.")], 0, "find the harbour", "/harbour-walk") as unknown[]),
    ],
  },
};

const job = (overrides: Partial<SlopJob> = {}): SlopJob => ({
  collection: "posts",
  postId: "p1",
  title: "",
  status: "queued",
  attempts: 0,
  queuedAt: "2026-09-15T14:00:00.000Z",
  updatedAt: "2026-09-15T14:00:00.000Z",
  ...overrides,
});

function setup(opts: { entry?: LinkEntry | null; reply?: unknown; jobs?: Record<string, SlopJob>; fetchFails?: boolean } = {}) {
  const entry = opts.entry === undefined ? structuredClone(POST) : opts.entry;
  const updates: Array<{ id: string; body: UpdateBody }> = [];
  const published: string[] = [];
  const content: Pick<ContentHandlers, "get" | "update" | "publish"> = {
    get: vi.fn(async () =>
      entry ? { success: true as const, data: { item: entry } } : { success: false as const, error: { message: "Content item not found" } },
    ),
    update: vi.fn(async (_c: string, id: string, body: UpdateBody) => {
      updates.push({ id, body });
      return { success: true as const, data: { item: { id } } };
    }),
    publish: vi.fn(async (_c: string, id: string) => {
      published.push(id);
      return { success: true as const, data: {} };
    }),
  };
  const reply =
    opts.reply ??
    ({
      excerpt: "A clear look at the harbour.",
      blocks: [{ i: 0, text: "Why visit" }, { i: 1, text: "Visitors walk through the old town to [find the harbour](/harbour-walk)." }],
    } as unknown);
  const fetchImpl = vi.fn(async () => {
    if (opts.fetchFails) throw new Error("network down");
    return chatResponse(JSON.stringify(reply));
  }) as unknown as typeof fetch;
  const jobs = memoryStore<SlopJob>(opts.jobs ?? { [slopJobId("posts", "p1")]: job() });
  const runs = memoryStore<RunRecord>();
  const deps: SlopQueueDeps = { kv: memoryKv(), jobs, runs, content, getApiKey: async () => "k", fetchImpl, now: () => NOW };
  return { deps, jobs, runs, updates, published };
}

describe("enqueueSlopJobs / slop/queue route", () => {
  it("queues each post once and leaves already-queued posts alone", async () => {
    const jobs = memoryStore<SlopJob>({ [slopJobId("posts", "b")]: job({ postId: "b" }) });
    const done = job({ postId: "c", status: "done", title: "Old" });
    await jobs.put(slopJobId("posts", "c"), done);
    expect(await enqueueSlopJobs({ jobs, now: () => NOW }, "posts", ["a", "a", "b", "c"])).toEqual({ queued: 2, alreadyQueued: 1 });
    expect(jobs.map.get(slopJobId("posts", "c"))).toMatchObject({ status: "queued", attempts: 0, title: "Old" });
  });

  it("validates route input", async () => {
    const jobs = memoryStore<SlopJob>();
    await expect(queueSlopRoute({ jobs }, { ids: [] })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await queueSlopRoute({ jobs }, { ids: ["x"] })).toEqual({ queued: 1, alreadyQueued: 0 });
  });
});

describe("processSlopQueue", () => {
  it("edits the post, keeps its links, republishes it and records the run", async () => {
    const { deps, jobs, runs, updates, published } = setup();
    const ran = await processSlopQueue(deps);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ source: "slop", status: "ok", topic: "No AI slop: Kyrenia Harbour", calls: 1 });
    expect(ran[0].details).toMatch(/^Edited 1 block\(s\); patterns before: banned word "delve", banned word "robust"/);
    expect(updates).toHaveLength(1);
    expect(linkedHrefs(updates[0].body.data?.content)).toEqual(new Set(["/harbour-walk"]));
    expect(updates[0].body.data?.excerpt).toBe("A clear look at the harbour.");
    expect(published).toEqual(["p1"]);
    expect(jobs.map.get(slopJobId("posts", "p1"))).toMatchObject({ status: "done", title: "Kyrenia Harbour" });
    expect(runs.map.size).toBe(1);
  });

  it("does not update a post the edit left unchanged", async () => {
    const same = { excerpt: "A robust look.", blocks: [{ i: 0, text: "Why visit" }] };
    const { deps, updates, published } = setup({ reply: same });
    const ran = await processSlopQueue(deps);
    expect(ran[0].status).toBe("ok");
    expect(updates).toEqual([]);
    expect(published).toEqual([]);
  });

  it("edits a Turkish post without the English-only pattern checker", async () => {
    const { deps } = setup({ entry: { ...structuredClone(POST), locale: "tr" } });
    const ran = await processSlopQueue(deps);
    expect(ran[0].details).toMatch(/no patterns found before/);
    const body = JSON.parse(((deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).content).not.toContain("PATTERNS FOUND BY A CHECKER");
  });

  it("skips posts with unpublished editor changes without calling the model", async () => {
    const { deps, jobs, updates } = setup({ entry: { ...structuredClone(POST), draftRevisionId: "r2" } });
    const ran = await processSlopQueue(deps);
    expect(ran[0]).toMatchObject({ status: "skipped", error: "The post has unpublished editor changes" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(jobs.map.get(slopJobId("posts", "p1"))?.status).toBe("skipped");
  });

  it("stops for good on a missing post or a refused edit, and retries transient failures", async () => {
    const missing = setup({ entry: null });
    await processSlopQueue(missing.deps);
    expect(missing.jobs.map.get(slopJobId("posts", "p1"))?.status).toBe("error");

    const refused = setup({ reply: { nope: true } });
    await processSlopQueue(refused.deps);
    expect(refused.jobs.map.get(slopJobId("posts", "p1"))).toMatchObject({ status: "error" });
    expect(refused.jobs.map.get(slopJobId("posts", "p1"))?.error).toMatch(/^The model returned no blocks \(reply began: /);

    const flaky = setup({ fetchFails: true, jobs: { [slopJobId("posts", "p1")]: job({ attempts: MAX_SLOP_ATTEMPTS - 2 }) } });
    await processSlopQueue(flaky.deps);
    expect(flaky.jobs.map.get(slopJobId("posts", "p1"))).toMatchObject({ status: "queued", attempts: MAX_SLOP_ATTEMPTS - 1 });
    await processSlopQueue(flaky.deps);
    expect(flaky.jobs.map.get(slopJobId("posts", "p1"))).toMatchObject({ status: "error", attempts: MAX_SLOP_ATTEMPTS });
  }, 30_000);

  it("stops when the tick has no time left", async () => {
    const { deps, updates } = setup();
    expect(await processSlopQueue(deps, { hasTime: () => false })).toEqual([]);
    expect(updates).toEqual([]);
  });
});
