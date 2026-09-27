export const PLUGIN_ID = "ad-manager";
export const API_BASE = "/_emdash/api/plugins/ad-manager";

export const ROLLUP_CRON = "stats-rollup";
export const ROLLUP_SCHEDULE = "*/5 * * * *";

export const KV_CODE_ADS = "settings:codeAdsEnabled";
export const KV_LAST_ROLLUP = "stats:lastRollupAt";

export const STORAGE: Record<string, { indexes: string[] }> = {
  ads: { indexes: ["status", "space"] },
  events: { indexes: ["createdAt"] },
  stats: { indexes: ["adId", "day"] },
};
