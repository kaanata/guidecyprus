import { PROVIDER_DEFAULTS, PROVIDER_KEY_NAMES, type Provider, type ProviderChoice } from "../lib/providers";
import type { Settings } from "../lib/settings";

// Model ids from one provider mean nothing to the other, so switching a
// provider resets that kind's models to the new provider's defaults.
export function switchProvider(settings: Settings, kind: "text" | "image", provider: Provider): Settings {
  if (settings.providers[kind] === provider) return settings;
  const d = PROVIDER_DEFAULTS[provider];
  const models =
    kind === "text"
      ? { ...settings.models, defaultText: d.defaultText, fallbackText: d.fallbackText, steps: {} }
      : { ...settings.models, defaultImage: d.defaultImage };
  const providers: ProviderChoice = { ...settings.providers, [kind]: provider };
  // The internal-linking model is a text model too.
  const internalLinks = kind === "text" ? { ...settings.internalLinks, model: "" } : settings.internalLinks;
  const noAiSlop = kind === "text" ? { ...settings.noAiSlop, model: "" } : settings.noAiSlop;
  return { ...settings, providers, models, internalLinks, noAiSlop };
}

// Key variables to warn about: each selected provider whose key is not
// bound, listed once. Unknown key state (catalog not loaded) warns nothing.
export function missingKeyNames(providers: ProviderChoice, keys: Record<Provider, boolean> | null): string[] {
  if (!keys) return [];
  const selected = [...new Set<Provider>([providers.text, providers.image])];
  return selected.filter((p) => keys[p] === false).map((p) => PROVIDER_KEY_NAMES[p]);
}
