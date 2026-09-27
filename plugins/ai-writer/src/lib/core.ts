/**
 * Public surface for sibling plugins in this workspace.
 * Re-exports only; no logic lives here.
 */
export { createGenerationClient, type GenerationClient } from "./generation";
export { SLOP_GUIDE, deslopArticle, slopAskFor, lintSlop } from "./slop";
export { assemble } from "./assemble";
export { createPost, type ContentHandlers } from "./content";
export { readSettings, type KvLike, type Settings } from "./settings";
// A sibling plugin generating text needs the same provider choice and the
// same env var names for the provider keys, so the model id it sends belongs
// to the provider the key authenticates against.
export { PROVIDER_KEY_NAMES, type Provider, type ProviderChoice } from "./providers";
export type { PortableTextBlock } from "./types";
