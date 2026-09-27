import { listImageModels, listModels, type ListedModel } from "./openrouter";
import { MINIMAX_CATALOG, modelBelongsTo, type Provider, type ProviderChoice } from "./providers";
import type { KvLike, Settings } from "./settings";
import type { ModelOverrides, Slot } from "./types";
import { readImagePrices } from "./usage";

export type ResolvedModel = { model: string; fallbacks: string[] };

// First set wins: per-request → rule override → Settings per-step → Settings default.
// Ids that belong to the other provider (e.g. a rule override saved before a
// provider switch) are skipped as if blank. Text calls get the Settings
// fallback model appended (when it differs and fits the provider); image
// calls never fall back to a different model.
export function resolveModel(
  slot: Slot,
  sources: { request?: string; rule?: ModelOverrides; settings: Settings["models"]; provider: Provider },
): ResolvedModel {
  const { request, rule, settings, provider } = sources;
  const pick = (v: string | undefined): string | undefined => {
    const value = v ? v.trim() : "";
    return value && modelBelongsTo(provider, value) ? value : undefined;
  };
  if (slot === "image") {
    return { model: pick(request) ?? pick(rule?.image) ?? settings.defaultImage, fallbacks: [] };
  }
  const model = pick(request) ?? pick(rule?.[slot]) ?? pick(settings.steps[slot]) ?? settings.defaultText;
  const fallback = pick(settings.fallbackText);
  return { model, fallbacks: fallback && fallback !== model ? [fallback] : [] };
}

// v2 adds prices; the new key refreshes catalogs cached before prices existed.
export const CATALOG_KEY = "catalog-v2";
export const CATALOG_TTL_MS = 60 * 60 * 1000;

export type Catalog = { text: ListedModel[]; image: ListedModel[] };
type CachedCatalog = Catalog & { fetchedAt: number };

export async function getCatalog(
  kv: KvLike,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<Catalog> {
  const now = opts.now ?? Date.now();
  const cached = await kv.get<CachedCatalog>(CATALOG_KEY);
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) {
    return { text: cached.text, image: cached.image };
  }
  const f = opts.fetchImpl ?? fetch;
  const [text, image] = await Promise.all([listModels(apiKey, f), listImageModels(apiKey, f)]);
  const entry: CachedCatalog = { text, image, fetchedAt: now };
  await kv.set(CATALOG_KEY, entry);
  return { text, image };
}

// What the admin's model pickers need: every provider's catalog (so the
// Settings page can show a provider before it is saved), the saved
// providers, and which API keys are bound. Never fails for a missing key.
export type ModelsResponse = {
  providers: ProviderChoice;
  catalogs: Record<Provider, Catalog>;
  keys: Record<Provider, boolean>;
  errors: Partial<Record<Provider, string>>;
  /** Last cost seen per image model (OpenRouter does not list image prices). */
  imagePrices: Record<string, number>;
};

async function keyOrNull(getApiKey: (p: Provider) => Promise<string>, provider: Provider): Promise<string | null> {
  try {
    return await getApiKey(provider);
  } catch {
    return null;
  }
}

export async function getModelsResponse(opts: {
  kv: KvLike;
  providers: ProviderChoice;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ModelsResponse> {
  const [openrouterKey, minimaxKey] = await Promise.all([
    keyOrNull(opts.getApiKey, "openrouter"),
    keyOrNull(opts.getApiKey, "minimax"),
  ]);
  const errors: ModelsResponse["errors"] = {};
  let openrouter: Catalog = { text: [], image: [] };
  if (openrouterKey !== null) {
    try {
      openrouter = await getCatalog(opts.kv, openrouterKey, { fetchImpl: opts.fetchImpl, now: opts.now });
    } catch (err) {
      errors.openrouter = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }
  return {
    providers: opts.providers,
    catalogs: { openrouter, minimax: MINIMAX_CATALOG },
    keys: { openrouter: openrouterKey !== null, minimax: minimaxKey !== null },
    errors,
    imagePrices: await readImagePrices(opts.kv),
  };
}
