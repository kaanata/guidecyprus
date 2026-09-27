import type { PluginRoute } from "emdash";
import { ensureRollupSafely } from "./hooks";
import { deleteAd, getAd, listAds, saveAd } from "./lib/ads";
import { serveAds, trackEvents } from "./lib/serving";
import { readCodeAdsEnabled, saveSettings } from "./lib/settings";
import { statsSummary } from "./lib/stats";
import { visitorCountry } from "./lib/targeting";
import { storesOf } from "./lib/store";

const newId = () => crypto.randomUUID();

// Native plugins registered from astro.config.mjs never fire plugin:install/plugin:activate,
// so the rollup cron never gets scheduled unless an admin route backfills it.
const ensureRollup = (ctx: Parameters<PluginRoute["handler"]>[0]) => ensureRollupSafely(ctx);

// Public: called by the loader on every page view. Everything else defaults to admins only.
const serve: PluginRoute = {
  public: true,
  handler: async (ctx) =>
    serveAds(storesOf(ctx), ctx.input, new Date(), { country: visitorCountry(ctx.requestMeta?.geo?.country) }),
};
const track: PluginRoute = { public: true, handler: async (ctx) => trackEvents(storesOf(ctx), ctx.input, new Date(), newId) };

const adsList: PluginRoute = {
  handler: async (ctx) => {
    const stores = storesOf(ctx);
    const result = { ok: true, ads: await listAds(stores, new Date()), codeAdsEnabled: await readCodeAdsEnabled(stores.kv) };
    await ensureRollup(ctx);
    return result;
  },
};
const adsGet: PluginRoute = { handler: async (ctx) => getAd(storesOf(ctx), ctx.input) };
const adsSave: PluginRoute = {
  handler: async (ctx) => {
    const result = await saveAd(storesOf(ctx), ctx.input, new Date(), newId);
    await ensureRollup(ctx);
    return result;
  },
};
const adsDelete: PluginRoute = { handler: async (ctx) => deleteAd(storesOf(ctx), ctx.input) };
const statsRoute: PluginRoute = { handler: async (ctx) => statsSummary(storesOf(ctx), ctx.input, new Date()) };

const settings: PluginRoute = {
  handler: async (ctx) => {
    const { kv } = storesOf(ctx);
    const result =
      ctx.request.method.toUpperCase() === "POST"
        ? await saveSettings(kv, ctx.input)
        : { ok: true, codeAdsEnabled: await readCodeAdsEnabled(kv) };
    await ensureRollup(ctx);
    return result;
  },
};

export const routes: Record<string, PluginRoute> = {
  serve,
  track,
  "ads/list": adsList,
  "ads/get": adsGet,
  "ads/save": adsSave,
  "ads/delete": adsDelete,
  "stats/summary": statsRoute,
  settings,
};
