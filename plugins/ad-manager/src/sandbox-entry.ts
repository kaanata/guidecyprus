import { definePlugin } from "emdash";
import { PLUGIN_ID, STORAGE } from "./constants";
import { cronHook, ensureRollupSafely, fragmentsHook } from "./hooks";
import { adManager } from "./index";
import { routes } from "./routes";

export function createPlugin(): ReturnType<typeof definePlugin> {
  const descriptor = adManager();
  return definePlugin({
    id: PLUGIN_ID,
    version: descriptor.version,
    capabilities: ["hooks.page-fragments:register"],
    storage: STORAGE,
    // Native plugins drop the descriptor's top-level admin fields; repeat them here.
    admin: { entry: descriptor.adminEntry, pages: descriptor.adminPages, widgets: descriptor.adminWidgets },
    hooks: {
      // A cron scheduling failure here must not crash plugin install/activation: log and move on.
      "plugin:install": async (_event, ctx) => ensureRollupSafely(ctx),
      "plugin:activate": async (_event, ctx) => ensureRollupSafely(ctx),
      cron: cronHook,
      "page:fragments": async (_event, ctx) => fragmentsHook(ctx),
    },
    routes,
  });
}

export default createPlugin;
