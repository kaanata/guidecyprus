import type { PluginDescriptor } from "emdash";

export const PLUGIN_ID = "ai-writer";

export function aiWriter(): PluginDescriptor {
  return {
    id: PLUGIN_ID,
    version: "0.1.0",
    format: "native",
    entrypoint: "@main-aff/plugin-ai-writer/sandbox",
    // The admin host loads React pages from this module; without it the
    // plugin's nav entries have nothing to render.
    adminEntry: "@main-aff/plugin-ai-writer/admin",
    options: {},
    capabilities: ["content:write", "media:write", "taxonomies:read"],
    // www.minimax.io serves the MiniMax plan-usage call on the dashboard widget.
    allowedHosts: ["openrouter.ai", "api.minimax.io", "www.minimax.io"],
    storage: {
      rules: { indexes: ["active", "nextRunAt"] },
      runs: { indexes: ["ruleId", "startedAt"] },
      linkJobs: { indexes: ["status", "queuedAt"] },
      slopJobs: { indexes: ["status", "queuedAt"] },
    },
    adminPages: [
      { path: "/express", label: "Express Mode", icon: "flask" },
      { path: "/rules", label: "Bulk Rules", icon: "history" },
      { path: "/bulk-edit", label: "Bulk Edit", icon: "pencil" },
      { path: "/settings", label: "AI Writer Settings", icon: "settings" },
    ],
    adminWidgets: [{ id: "recent-runs", title: "AI Writer — recent runs", size: "half" }],
  };
}

export default aiWriter;
