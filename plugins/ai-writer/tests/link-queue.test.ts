import { describe, expect, it, vi } from "vitest";
import { LinkJobError, type LinkJobResult } from "../src/lib/internal-links";
import {
  describeLinks,
  enqueueLinkJob,
  linkJobId,
  linkMarkerKey,
  MAX_LINK_ATTEMPTS,
  processLinkQueue,
  skipReason,
  type LinkJob,
  type LinkQueueDeps,
} from "../src/lib/link-queue";
import type { RunRecord } from "../src/lib/runs";
import { defaultSettings, SETTINGS_KEY } from "../src/lib/settings";
import { memoryKv, memoryStore } from "./helpers";

const NOW = new Date("2026-09-14T20:00:00.000Z");
const item = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  status: "published",
  publishedAt: "2026-09-14T19:59:00.000Z",
  data: { title: "Kyrenia Day Trip" },
  ...overrides,
});

describe("skipReason", () => {
  it("queues fresh publishes in linked collections only", () => {
    expect(skipReason(item(), "posts", defaultSettings, NOW)).toBeNull();
    expect(skipReason(item(), "pages", defaultSettings, NOW)).toMatch(/not linked/);
    expect(skipReason(item({ status: "draft" }), "posts", defaultSettings, NOW)).toBe("not published");
    expect(skipReason(item({ publishedAt: "2026-09-01T00:00:00.000Z" }), "posts", defaultSettings, NOW)).toMatch(/republished/);
    expect(
      skipReason(item({ publishedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z" }), "posts", defaultSettings, NOW),
    ).toMatch(/republished/);
    // A backdated post that was just written still gets links.
    expect(
      skipReason(item({ publishedAt: "2026-08-03T09:30:00.000Z", createdAt: "2026-09-14T19:58:00.000Z" }), "posts", defaultSettings, NOW),
    ).toBeNull();
    const off = { ...defaultSettings, internalLinks: { ...defaultSettings.internalLinks, enabled: false } };
    expect(skipReason(item(), "posts", off, NOW)).toMatch(/off/);
  });
});

describe("enqueueLinkJob", () => {
  it("queues a job once per post and remembers it", async () => {
    const kv = memoryKv();
    const jobs = memoryStore<LinkJob>();
    expect(await enqueueLinkJob({ kv, jobs, now: () => NOW }, item(), "posts")).toEqual({ queued: true });
    expect(jobs.map.get(linkJobId("posts", "p1"))).toMatchObject({ postId: "p1", title: "Kyrenia Day Trip", status: "queued", attempts: 0 });
    expect(kv.map.has(linkMarkerKey("posts", "p1"))).toBe(true);
    // The plugin's own republish of the post after adding links does not queue again.
    jobs.map.clear();
    expect(await enqueueLinkJob({ kv, jobs, now: () => NOW }, item(), "posts")).toEqual({ queued: false, reason: "already linked once" });
    expect(jobs.map.size).toBe(0);
  });

  it("does not queue when linking is disabled in stored settings", async () => {
    const kv = memoryKv({ [SETTINGS_KEY]: { internalLinks: { enabled: false } } });
    const jobs = memoryStore<LinkJob>();
    expect((await enqueueLinkJob({ kv, jobs, now: () => NOW }, item(), "posts")).queued).toBe(false);
  });
});

const RESULT: LinkJobResult = {
  title: "Kyrenia Day Trip",
  outbound: [{ id: "a", title: "Kyrenia Harbour", anchor: "old harbour" }],
  inbound: [{ id: "b", title: "Bellapais Abbey", anchor: "day trip" }],
  warnings: ["one warning"],
  calls: 4,
  cost: 0.0123,
  tokens: 900,
};

describe("processLinkQueue", () => {
  function setup(runJob: LinkQueueDeps["runJob"], jobs: Record<string, LinkJob>, kvInit: Record<string, unknown> = {}) {
    const jobsStore = memoryStore<LinkJob>(jobs);
    const runs = memoryStore<RunRecord>();
    const deps: LinkQueueDeps = {
      kv: memoryKv(kvInit),
      jobs: jobsStore,
      runs,
      content: {} as never,
      listPublished: vi.fn(),
      getApiKey: async () => "k",
      now: () => NOW,
      runJob,
    };
    return { deps, jobsStore, runs };
  }
  const job = (postId: string, queuedAt: string, overrides: Partial<LinkJob> = {}): LinkJob => ({
    collection: "posts",
    postId,
    title: postId,
    status: "queued",
    attempts: 0,
    queuedAt,
    updatedAt: queuedAt,
    ...overrides,
  });

  it("runs the oldest queued jobs, records runs and marks jobs done", async () => {
    const runJob = vi.fn(async (_deps: unknown, _collection: string, _id: string) => RESULT);
    const { deps, jobsStore, runs } = setup(runJob, {
      "link-posts-new": job("new", "2026-09-14T19:50:00.000Z"),
      "link-posts-old": job("old", "2026-09-14T19:00:00.000Z"),
      "link-posts-3": job("third", "2026-09-14T19:55:00.000Z"),
      "link-posts-done": job("done", "2026-09-14T18:00:00.000Z", { status: "done" }),
    });
    const ran = await processLinkQueue(deps, { limit: 2 });
    expect(runJob.mock.calls.map((c) => c[2])).toEqual(["old", "new"]);
    expect(ran).toHaveLength(2);
    expect(ran[0]).toMatchObject({
      source: "links",
      status: "ok",
      topic: "Internal links: Kyrenia Day Trip",
      details: "Links to “Kyrenia Harbour”; linked from “Bellapais Abbey”",
      warnings: ["one warning"],
      calls: 4,
    });
    expect(jobsStore.map.get("link-posts-old")?.status).toBe("done");
    expect(jobsStore.map.get("link-posts-3")?.status).toBe("queued");
    expect(runs.map.size).toBe(2);
  });

  it("retries transient failures and stops for good after the last attempt", async () => {
    const { deps, jobsStore } = setup(
      vi.fn(async () => {
        throw new Error("OpenRouter 503");
      }),
      { j: job("p", "2026-09-14T19:00:00.000Z", { attempts: MAX_LINK_ATTEMPTS - 2 }) },
    );
    await processLinkQueue(deps);
    expect(jobsStore.map.get("j")).toMatchObject({ status: "queued", attempts: MAX_LINK_ATTEMPTS - 1, error: "OpenRouter 503" });
    await processLinkQueue(deps);
    expect(jobsStore.map.get("j")).toMatchObject({ status: "error", attempts: MAX_LINK_ATTEMPTS });
  });

  it("gives up immediately when the post itself cannot be linked", async () => {
    const { deps, jobsStore, runs } = setup(
      vi.fn(async () => {
        throw new LinkJobError("The post is no longer published");
      }),
      { j: job("p", "2026-09-14T19:00:00.000Z") },
    );
    const ran = await processLinkQueue(deps);
    expect(ran[0]).toMatchObject({ status: "error", error: "The post is no longer published" });
    expect(jobsStore.map.get("j")?.status).toBe("error");
    expect(runs.map.size).toBe(1);
  });

  it("skips queued jobs once linking is turned off, and stops when time runs out", async () => {
    const runJob = vi.fn(async () => RESULT);
    const off = setup(runJob, { j: job("p", "2026-09-14T19:00:00.000Z") }, { [SETTINGS_KEY]: { internalLinks: { enabled: false } } });
    expect(await processLinkQueue(off.deps)).toEqual([]);
    expect(off.jobsStore.map.get("j")?.status).toBe("skipped");

    const late = setup(runJob, { j: job("p", "2026-09-14T19:00:00.000Z") });
    expect(await processLinkQueue(late.deps, { hasTime: () => false })).toEqual([]);
    expect(runJob).not.toHaveBeenCalled();
  });
});

describe("describeLinks", () => {
  it("summarises empty results", () => {
    expect(describeLinks({ ...RESULT, outbound: [], inbound: [] })).toBe("No outbound links; no backlinks");
  });
});
