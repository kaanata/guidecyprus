import type { Catalog } from "./models";

export const PROVIDERS = ["openrouter", "minimax"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type ProviderChoice = { text: Provider; image: Provider };

export const PROVIDER_LABELS: Record<Provider, string> = { openrouter: "OpenRouter", minimax: "MiniMax" };

// Worker env var holding each provider's API key (.dev.vars locally, a secret in production).
export const PROVIDER_KEY_NAMES: Record<Provider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

export const DEFAULT_PROVIDERS: ProviderChoice = { text: "openrouter", image: "openrouter" };

// The models a provider switch resets to: the plugin's original OpenRouter
// defaults, and MiniMax's recommended text/image models from its API docs.
export const PROVIDER_DEFAULTS: Record<Provider, { defaultText: string; fallbackText: string; defaultImage: string }> = {
  openrouter: {
    defaultText: "meta/muse-spark-1.3-contributor",
    fallbackText: "qwen/qwen3.8-flash",
    defaultImage: "bytedance-seed/seedream-5-0-lite",
  },
  minimax: { defaultText: "MiniMax-M3", fallbackText: "MiniMax-M2.7", defaultImage: "image-01" },
};

// OpenRouter ids are always "vendor/model"; MiniMax ids never contain a
// slash. A blank id means "use the default" and belongs to every provider.
export function modelBelongsTo(provider: Provider, id: string | undefined): boolean {
  const value = (id ?? "").trim();
  if (value === "") return true;
  return provider === "openrouter" ? value.includes("/") : !value.includes("/");
}

const listed = (ids: string[]) => ids.map((id) => ({ id, name: id }));

// MiniMax's model list is short and fixed (from its API docs), so it ships
// with the plugin instead of being fetched.
export const MINIMAX_CATALOG: Catalog = {
  text: listed([
    "MiniMax-M3",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
  ]),
  image: listed(["image-01"]),
};
