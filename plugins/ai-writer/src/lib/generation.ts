import { createMiniMaxClient } from "./minimax";
import { createOpenRouterClient, type OpenRouterClient } from "./openrouter";
import type { Provider, ProviderChoice } from "./providers";

export type GenerationClient = Pick<OpenRouterClient, "generateText" | "generateImage">;

export type GenerationOptions = {
  providers: ProviderChoice;
  getApiKey(provider: Provider): Promise<string>;
  fetchImpl?: typeof fetch;
};

// Sends text calls to the Settings text provider and image calls to the
// image provider. Each provider's key is loaded on its first call (and kept),
// so a missing MiniMax key only fails the calls that need MiniMax. A failed
// key load is remembered for this client's lifetime (one client is built per
// request or rule run), so a later call in the same request fails the same
// way without re-reading the env.
export function createGenerationClient(opts: GenerationOptions): GenerationClient {
  const clients = new Map<Provider, Promise<GenerationClient>>();
  const clientFor = (provider: Provider): Promise<GenerationClient> => {
    let client = clients.get(provider);
    if (!client) {
      client = opts
        .getApiKey(provider)
        .then(
          (apiKey): GenerationClient =>
            provider === "minimax"
              ? createMiniMaxClient({ apiKey, fetchImpl: opts.fetchImpl })
              : createOpenRouterClient({ apiKey, fetchImpl: opts.fetchImpl }),
        );
      clients.set(provider, client);
    }
    return client;
  };
  return {
    generateText: async (input) => (await clientFor(opts.providers.text)).generateText(input),
    generateImage: async (input) => (await clientFor(opts.providers.image)).generateImage(input),
  };
}
