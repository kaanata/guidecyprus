import { describe, expect, it, vi } from "vitest";
import { createGenerationClient } from "../src/lib/generation";
import type { Provider } from "../src/lib/providers";
import { chatResponse, jsonResponse } from "./helpers";

const JPEG_B64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0));

function fetchByEndpoint() {
  return vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/chat/completions")) return chatResponse('{"title":"OK"}');
    if (url.endsWith("/image_generation")) {
      return jsonResponse({ data: { image_base64: [JPEG_B64] }, base_resp: { status_code: 0, status_msg: "success" } });
    }
    if (url.endsWith("/images")) return jsonResponse({ data: [{ b64_json: btoa("png"), media_type: "image/png" }] });
    return jsonResponse({});
  });
}

const urlsOf = (f: ReturnType<typeof fetchByEndpoint>) => f.mock.calls.map((c) => c[0]);
const authOf = (f: ReturnType<typeof fetchByEndpoint>, i: number) =>
  (f.mock.calls[i][1]?.headers as Record<string, string>).Authorization;

describe("createGenerationClient", () => {
  it("sends text to MiniMax and images to OpenRouter when chosen", async () => {
    const fetchImpl = fetchByEndpoint();
    const getApiKey = vi.fn(async (p: Provider) => `key-${p}`);
    const client = createGenerationClient({
      providers: { text: "minimax", image: "openrouter" },
      getApiKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await client.generateText({ model: "MiniMax-M3", prompt: "p" })).json).toEqual({ title: "OK" });
    expect((await client.generateImage({ model: "a/b", prompt: "p", width: 1200, height: 800 })).contentType).toBe(
      "image/png",
    );
    expect(urlsOf(fetchImpl)).toEqual([
      "https://api.minimax.io/v1/chat/completions",
      "https://openrouter.ai/api/v1/images",
    ]);
    expect(authOf(fetchImpl, 0)).toBe("Bearer key-minimax");
    expect(authOf(fetchImpl, 1)).toBe("Bearer key-openrouter");
  });

  it("sends images to MiniMax when chosen", async () => {
    const fetchImpl = fetchByEndpoint();
    const client = createGenerationClient({
      providers: { text: "openrouter", image: "minimax" },
      getApiKey: async (p: Provider) => `key-${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out.contentType).toBe("image/jpeg");
    expect(urlsOf(fetchImpl)).toEqual(["https://api.minimax.io/v1/image_generation"]);
  });

  it("loads no key until a call needs it, then loads each provider's key once", async () => {
    const getApiKey = vi.fn(async (p: Provider) => `key-${p}`);
    const client = createGenerationClient({
      providers: { text: "minimax", image: "minimax" },
      getApiKey,
      fetchImpl: fetchByEndpoint() as unknown as typeof fetch,
    });
    expect(getApiKey).not.toHaveBeenCalled();
    await client.generateText({ model: "MiniMax-M3", prompt: "p" });
    await client.generateText({ model: "MiniMax-M3", prompt: "p" });
    await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(getApiKey).toHaveBeenCalledTimes(1);
    expect(getApiKey).toHaveBeenCalledWith("minimax");
  });

  it("a missing image key does not break text", async () => {
    const client = createGenerationClient({
      providers: { text: "openrouter", image: "minimax" },
      getApiKey: async (p: Provider) => {
        if (p === "minimax") throw new Error("MINIMAX_API_KEY is not bound");
        return "k";
      },
      fetchImpl: fetchByEndpoint() as unknown as typeof fetch,
    });
    expect((await client.generateText({ model: "a/b", prompt: "p" })).json).toEqual({ title: "OK" });
    await expect(client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 })).rejects.toThrow(
      "MINIMAX_API_KEY is not bound",
    );
  });
});
