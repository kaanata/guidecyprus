import { ROLLUP_CRON } from "../src/constants";
import { ensureRollupScheduled } from "../src/hooks";

describe("ensureRollupScheduled", () => {
  it("schedules the rollup exactly once when list() returns no matching task", async () => {
    const list = vi.fn(async () => []);
    const schedule = vi.fn(async () => undefined);

    await ensureRollupScheduled({ cron: { list, schedule } });

    expect(list).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("stats-rollup", { schedule: "*/5 * * * *" });
  });

  it("does not schedule when list() already has the rollup task", async () => {
    const list = vi.fn(async () => [{ name: "stats-rollup", schedule: "*/5 * * * *", nextRunAt: "x", lastRunAt: null }]);
    const schedule = vi.fn(async () => undefined);

    await ensureRollupScheduled({ cron: { list, schedule } });

    expect(list).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("is a no-op when ctx.cron is undefined", async () => {
    await expect(ensureRollupScheduled({})).resolves.toBeUndefined();
  });
});

describe("ROLLUP_CRON", () => {
  // EmDash's CronAccess.schedule() rejects any task name that doesn't match this pattern
  // (validateTaskName in node_modules/emdash/dist/cron-Y9aLtgrA.mjs) -- e.g. a colon, like the
  // old "ad-manager:rollup" name, throws "Invalid task name" and the rollup is silently never
  // scheduled. Guard against regressing to an invalid name.
  it("matches EmDash's cron task name pattern", () => {
    expect(ROLLUP_CRON).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});
