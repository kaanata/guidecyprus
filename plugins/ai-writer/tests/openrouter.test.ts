import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOpenRouterClient, listImageModels, listModels } from "../src/lib/openrouter";

const OK_TEXT = {
  id: "gen-1",
  choices: [
    {
      message: { role: "assistant", content: '{"title":"OK"}' },
      finish_reason: "stop",
    },
  ],
};

const OK_IMAGE = {
  id: "img-1",
  data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" }],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouterClient.generateText", () => {
  it("POSTs to /api/v1/chat/completions and returns parsed JSON content", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TEXT), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateText({
      model: "meta/muse-spark-1.3-contributor",
      system: "sys",
      prompt: "hi",
      responseFormat: { type: "json_object" },
    });

    expect(result.json).toEqual({ title: "OK" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
  });

  it("parses JSON wrapped in a markdown code fence", async () => {
    const fenced = { choices: [{ message: { role: "assistant", content: '```json\n{"title":"Fenced"}\n```' } }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fenced), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await client.generateText({ model: "a/b", prompt: "hi", responseFormat: { type: "json_object" } });
    expect(result.json).toEqual({ title: "Fenced" });
  });

  it("passes a per-call timeout through to the request signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TEXT), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    await client.generateText({ model: "a/b", prompt: "hi", timeoutMs: 120_000 });
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("returns the tokens and cost OpenRouter reports", async () => {
    const withUsage = { ...OK_TEXT, usage: { prompt_tokens: 12, completion_tokens: 30, cost: 0.00042 } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(withUsage), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await client.generateText({ model: "a/b", prompt: "hi" });
    expect(result.usage).toEqual({ cost: 0.00042, promptTokens: 12, completionTokens: 30 });
  });

  it("retries once on 5xx then throws", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return new Response("boom", { status: 502 });
    });
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.generateText({ model: "x", prompt: "p" })).rejects.toThrow(/502/);
    expect(calls).toBe(2);
  });

  it("does not retry on 4xx", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return new Response("bad", { status: 400 });
    });
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.generateText({ model: "x", prompt: "p" })).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });
});

describe("OpenRouterClient.generateImage", () => {
  it("POSTs to /api/v1/images and returns image bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_IMAGE), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "abstract stadium",
      width: 1200,
      height: 800,
    });

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toBe("abstract stadium");
    expect(body.size).toBe("1200x800");
  });

  it("returns the cost reported for an image", async () => {
    const withUsage = { ...OK_IMAGE, usage: { completion_tokens: 718, cost: 0.01 } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(withUsage), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    const out = await client.generateImage({ model: "meta/muse-image", prompt: "p", width: 512, height: 512 });
    expect(out.usage).toEqual({ cost: 0.01, promptTokens: undefined, completionTokens: 718 });
  });

  it("returns null bytes (not throw) when the API refuses", async () => {
    const fetchMock = vi.fn(async () => new Response("refused", { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "anything",
      width: 1200,
      height: 800,
    });

    // Empty response — caller treats null as "skip image" rather than throwing.
    expect(result.bytes.byteLength).toBe(0);
  });

  it("retries without size after a 4xx and returns the image", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_IMAGE), { status: 200 }));
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "requires at least 3,686,400 output pixels", code: 400 },
          }),
          { status: 400 },
        ),
    );
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "abstract stadium",
      width: 1200,
      height: 800,
    });

    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(firstInit.body as string).size).toBe("1200x800");
    expect("size" in JSON.parse(secondInit.body as string)).toBe(false);
  });

  it("returns the provider error when the sizeless retry also fails", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "requires at least 3,686,400 output pixels", code: 400 } }),
          { status: 400 },
        ),
    );
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "abstract stadium",
      width: 1200,
      height: 800,
    });

    expect(result.bytes.byteLength).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("400");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry without size when no size was sent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "google/gemini-3.1-flash-lite-image",
      prompt: "abstract stadium",
      width: NaN,
      height: NaN,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("400");
  });
});

describe("listModels", () => {
  it("returns a sorted {id,name}[] from the OpenRouter catalog", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "meta/muse-spark-1.3-contributor", name: "GPT-4o mini" },
            { id: "bytedance-seed/seedream-5-0-lite", name: "Gemini Flash Image" },
            { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
          ],
        }),
        { status: 200 },
      ),
    );
    const models = await listModels("k", fetchMock as unknown as typeof fetch);
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "bytedance-seed/seedream-5-0-lite",
      "meta/muse-spark-1.3-contributor",
    ]);
    expect(models.map((m) => m.name)).toEqual([
      "Claude Sonnet 4.5",
      "Gemini Flash Image",
      "GPT-4o mini",
    ]);
  });

  it("falls back to id when name is missing", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "meta/muse-spark-1.3-contributor" }] }), { status: 200 }),
    );
    const models = await listModels("k", fetchMock as unknown as typeof fetch);
    expect(models).toEqual([{ id: "meta/muse-spark-1.3-contributor", name: "meta/muse-spark-1.3-contributor" }]);
  });

  it("throws on non-OK responses", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream timeout", { status: 504 }));
    await expect(listModels("k", fetchMock as unknown as typeof fetch)).rejects.toThrow(/OpenRouter models 504/);
  });

  it("drops entries that have no id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: "ok/a" }, { name: "no-id" }, { id: "ok/b", name: "B" }] }),
        { status: 200 },
      ),
    );
    const models = await listModels("k", fetchMock as unknown as typeof fetch);
    // Sorted by name: "B" wins on ASCII so "ok/b" precedes "ok/a" (whose
    // name fell back to its id).
    expect(models.map((m) => m.id)).toEqual(["ok/b", "ok/a"]);
  });
});

describe("ai-writer additions", () => {
  it("sends temperature when provided", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TEXT), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    await client.generateText({ model: "m/x", prompt: "p", temperature: 0.3 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).temperature).toBe(0.3);
  });

  it("omits temperature when not provided", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TEXT), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
    await client.generateText({ model: "m/x", prompt: "p" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect("temperature" in JSON.parse(init.body as string)).toBe(false);
  });

  it("listImageModels reads /images/models and sorts by name", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "z/img", name: "Zed" }, { id: "a/img" }] }), { status: 200 }),
    );
    const models = await listImageModels("k", fetchMock as unknown as typeof fetch);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://openrouter.ai/api/v1/images/models");
    expect(models).toEqual([
      { id: "a/img", name: "a/img" },
      { id: "z/img", name: "Zed" },
    ]);
  });

  it("listImageModels throws on non-OK responses", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(listImageModels("k", fetchMock as unknown as typeof fetch)).rejects.toThrow(/image models 503/);
  });
});

describe("readable fallback errors (A1)", () => {
  it("names both models and surfaces each provider message, without leaking other body fields", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { message: "No endpoints available" }, user_id: "u_123" }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "rate-limited upstream" }, user_id: "u_123" }),
        { status: 429 },
      );
    });
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    let error: Error | undefined;
    try {
      await client.generateText({
        model: "primary/model",
        prompt: "p",
        fallbackModels: ["fallback/model"],
      });
    } catch (err) {
      error = err as Error;
    }

    expect(error).toBeDefined();
    const msg = error!.message;
    expect(msg).toContain("primary/model");
    expect(msg).toContain("No endpoints available");
    expect(msg).toContain("fallback/model");
    expect(msg).toContain("rate-limited upstream");
    expect(msg).not.toContain("user_id");
    expect(msg).not.toContain("u_123");
  });

  it("keeps the original error text when a single model's 4xx body isn't JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("plain text failure", { status: 400 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(client.generateText({ model: "solo/model", prompt: "p" })).rejects.toThrow(
      /plain text failure/,
    );
  });
});

describe("size retry only on 400/422 (A2)", () => {
  it("does not retry without size on a 429 and reports it", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
    );
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "abstract stadium",
      width: 1200,
      height: 800,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("429");
  });
});

describe("no trailing sleep after the final attempt (A3)", () => {
  it("sleeps only between attempts, not after the last one", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls++;
        return new Response("boom", { status: 502 });
      });
      const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const pending = client.generateText({ model: "x", prompt: "p" });
      const assertion = expect(pending).rejects.toThrow(/502/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(calls).toBe(2);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("request timeouts (A4)", () => {
  it("sends an AbortSignal on chat completion requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TEXT), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    await client.generateText({ model: "m/x", prompt: "p" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends an AbortSignal on image generation requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_IMAGE), { status: 200 }));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch });

    await client.generateImage({
      model: "bytedance-seed/seedream-5-0-lite",
      prompt: "abstract stadium",
      width: 1200,
      height: 800,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});