import { describe, expect, it } from "vitest";
import aiWriterDefault, { aiWriter, PLUGIN_ID } from "../src/index";

describe("aiWriter descriptor", () => {
  it("is exported as default and named", () => {
    expect(aiWriterDefault).toBe(aiWriter);
    expect(PLUGIN_ID).toBe("ai-writer");
  });

  it("declares identity, entrypoints, and capabilities", () => {
    expect(aiWriter()).toMatchObject({
      id: "ai-writer",
      version: "0.1.0",
      format: "native",
      entrypoint: "@main-aff/plugin-ai-writer/sandbox",
      adminEntry: "@main-aff/plugin-ai-writer/admin",
      capabilities: ["content:write", "media:write", "taxonomies:read"],
      allowedHosts: ["openrouter.ai", "api.minimax.io", "www.minimax.io"],
    });
  });

  it("declares the rules and runs storage collections", () => {
    const d = aiWriter() as unknown as { storage: Record<string, { indexes: string[] }> };
    expect(d.storage.rules.indexes).toEqual(["active", "nextRunAt"]);
    expect(d.storage.runs.indexes).toEqual(["ruleId", "startedAt"]);
  });

  it("declares the admin pages", () => {
    const d = aiWriter() as unknown as { adminPages: Array<{ path: string; label: string }> };
    expect(d.adminPages.map((p) => p.path)).toEqual(["/express", "/rules", "/bulk-edit", "/settings"]);
  });

  it("declares the recent-runs dashboard widget", () => {
    const d = aiWriter() as unknown as { adminWidgets: Array<{ id: string; size: string }> };
    expect(d.adminWidgets).toEqual([{ id: "recent-runs", title: "AI Writer — recent runs", size: "half" }]);
  });

  it("declares the link job storage used by internal linking", () => {
    const d = aiWriter() as unknown as { storage: Record<string, { indexes: string[] }> };
    expect(d.storage.linkJobs).toEqual({ indexes: ["status", "queuedAt"] });
    expect(d.storage.slopJobs).toEqual({ indexes: ["status", "queuedAt"] });
  });
});
