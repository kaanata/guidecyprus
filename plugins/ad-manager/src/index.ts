import type { PluginDescriptor } from "emdash";
import { PLUGIN_ID, STORAGE } from "./constants.js";

export function adManager(): PluginDescriptor {
  return {
    id: PLUGIN_ID,
    version: "0.1.0",
    format: "native",
    entrypoint: "@main-aff/plugin-ad-manager/sandbox",
    adminEntry: "@main-aff/plugin-ad-manager/admin",
    capabilities: ["hooks.page-fragments:register"],
    storage: STORAGE,
    adminPages: [
      { path: "/ads", label: "Ads", icon: "megaphone" },
      { path: "/performance", label: "Ad performance", icon: "chart" },
    ],
    adminWidgets: [{ id: "top-ads", title: "Top ads (7 days)", size: "half" }],
  };
}

export default adManager;
export { AD_SPACES, AD_SPACE_IDS, PAGE_TYPES } from "./spaces.js";
export type { AdSpace, AdSpaceId, PageType } from "./spaces.js";
