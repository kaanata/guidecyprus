import { describe, expect, it, vi } from "vitest";
import { cleanContent, createMiniMaxClient, fitImageSide, imageContentType } from "../src/lib/minimax";

const OK = { status_code: 0, status_msg: "" };
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const chat = (content: string) => reply({ choices: [{ message: { role: "assistant", content } }], base_resp: OK });
const failure = (status_code: number, status_msg = "") => reply({ base_resp: { status_code, status_msg } });
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const image = (bytes: number[]) =>
  reply({
    data: { image_base64: [b64(bytes)] },
    metadata: { success_count: "1", failed_count: "0" },
    base_resp: { status_code: 0, status_msg: "success" },
  });

function setup(queue: Array<Response | Error>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const client = createMiniMaxClient({ apiKey: "k", fetchImpl: fetchMock as unknown as typeof fetch, sleep });
  const body = (i: number) => JSON.parse(fetchMock.mock.calls[i][1]?.body as string) as Record<string, unknown>;
  return { fetchMock, sleep, client, body };
}

describe("MiniMax generateText", () => {
  it("POSTs an OpenAI-shaped chat request with reasoning split and no response_format", async () => {
    const { fetchMock, client, body } = setup([chat('{"title":"OK"}')]);
    const out = await client.generateText({
      model: "MiniMax-M3",
      system: "sys",
      prompt: "hi",
      temperature: 0.7,
      responseFormat: { type: "json_object" },
    });
    expect(out.json).toEqual({ title: "OK" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(body(0)).toEqual({
      model: "MiniMax-M3",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      reasoning_split: true,
      temperature: 0.7,
    });
  });

  it("returns token counts without a cost, since plan and pay-as-you-go replies carry no price", async () => {
    const withUsage = reply({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      base_resp: OK,
      usage: { prompt_tokens: 183, completion_tokens: 24, total_tokens: 207 },
    });
    const { client } = setup([withUsage]);
    const out = await client.generateText({ model: "MiniMax-M3", prompt: "hi" });
    expect(out.usage).toEqual({ promptTokens: 183, completionTokens: 24, cost: undefined });
  });

  it("strips think blocks and a code fence before parsing", async () => {
    const { client } = setup([chat('<think>plan it</think>\n\n```json\n{"title":"T"}\n```')]);
    expect(await client.generateText({ model: "MiniMax-M3", prompt: "p" })).toEqual({
      json: { title: "T" },
      raw: '{"title":"T"}',
    });
  });

  it("returns plain text replies as text", async () => {
    const { client } = setup([chat("<think>x</think>Brewing Better Tea")]);
    expect(await client.generateText({ model: "MiniMax-M3", prompt: "p" })).toEqual({
      json: "Brewing Better Tea",
      raw: "Brewing Better Tea",
    });
  });

  it("moves to the fallback model on a base_resp error without retrying", async () => {
    const { client, fetchMock, sleep, body } = setup([failure(2013), chat("Title")]);
    const out = await client.generateText({ model: "MiniMax-M3", fallbackModels: ["MiniMax-M2.7"], prompt: "p" });
    expect(out.raw).toBe("Title");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body(1).model).toBe("MiniMax-M2.7");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([1000, 1001, 1002])("retries once after 2 s on code %i", async (code) => {
    const { client, fetchMock, sleep } = setup([failure(code), chat("Title")]);
    expect((await client.generateText({ model: "MiniMax-M3", prompt: "p" })).raw).toBe("Title");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries once after 2 s on a malformed response body", async () => {
    const { client, fetchMock, sleep } = setup([new Response("not json", { status: 200 }), chat("Title")]);
    expect((await client.generateText({ model: "MiniMax-M3", prompt: "p" })).raw).toBe("Title");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("rejects after two malformed response bodies", async () => {
    const { client } = setup([new Response("not json", { status: 200 }), new Response("not json", { status: 200 })]);
    await expect(client.generateText({ model: "MiniMax-M3", prompt: "p" })).rejects.toThrow(
      "MiniMax-M3: MiniMax returned a malformed response",
    );
  });

  it("retries once on a network error", async () => {
    const { client, fetchMock } = setup([new TypeError("fetch failed"), chat("Title")]);
    expect((await client.generateText({ model: "MiniMax-M3", prompt: "p" })).raw).toBe("Title");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx once, then reports it", async () => {
    const { client, fetchMock } = setup([new Response("boom", { status: 502 }), new Response("boom", { status: 502 })]);
    await expect(client.generateText({ model: "MiniMax-M3", prompt: "p" })).rejects.toThrow(
      "MiniMax-M3: MiniMax HTTP 502: boom",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry other 4xx responses", async () => {
    const { client, fetchMock } = setup([new Response("unauthorized", { status: 401 })]);
    await expect(client.generateText({ model: "MiniMax-M3", prompt: "p" })).rejects.toThrow("MiniMax HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names every failed model, preferring status_msg over the label", async () => {
    const { client } = setup([failure(2049), failure(1008, "insufficient balance")]);
    await expect(
      client.generateText({ model: "MiniMax-M3", fallbackModels: ["MiniMax-M2.7"], prompt: "p" }),
    ).rejects.toThrow("MiniMax-M3: MiniMax 2049: invalid API key · MiniMax-M2.7: MiniMax 1008: insufficient balance");
  });
});

describe("cleanContent", () => {
  it("trims, drops every think block, and unwraps a bare fence", () => {
    expect(cleanContent("  hello  ")).toBe("hello");
    expect(cleanContent("```\n[1,2]\n```")).toBe("[1,2]");
    expect(cleanContent("<think>a</think>x<think>b</think>")).toBe("x");
  });
});

describe("MiniMax generateImage", () => {
  it("POSTs image-01 with a fitted size and truncated prompt, and decodes the JPEG", async () => {
    const { client, fetchMock, body } = setup([image(JPEG)]);
    const out = await client.generateImage({ model: "image-01", prompt: "a".repeat(2000), width: 1201, height: 300 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.minimax.io/v1/image_generation");
    expect(body(0)).toEqual({
      model: "image-01",
      prompt: "a".repeat(1500),
      width: 1200,
      height: 512,
      response_format: "base64",
      n: 1,
    });
    expect(out.error).toBeUndefined();
    expect(out.contentType).toBe("image/jpeg");
    expect(Array.from(out.bytes)).toEqual(JPEG);
  });

  it("waits 7 s and retries once on a rate limit", async () => {
    const { client, fetchMock, sleep } = setup([failure(1002), image(JPEG)]);
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out.bytes.byteLength).toBe(JPEG.length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("returns an error without retrying when the content is refused", async () => {
    const { client, fetchMock } = setup([failure(1026)]);
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out).toEqual({
      bytes: new Uint8Array(0),
      contentType: "image/jpeg",
      error: "MiniMax 1026: sensitive content detected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an error without retrying when the image data is not valid base64", async () => {
    const { client, fetchMock } = setup([reply({ data: { image_base64: ["%%%not-base64%%%"] }, base_resp: OK })]);
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out.error).toBe("MiniMax returned invalid image data");
    expect(out.bytes.byteLength).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an error when no image comes back", async () => {
    const { client } = setup([reply({ data: { image_base64: [] }, base_resp: OK })]);
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out.error).toBe("MiniMax returned no image data");
  });

  it("retries a 5xx once after 2 s, then returns the error", async () => {
    const { client, fetchMock, sleep } = setup([
      new Response("down", { status: 500 }),
      new Response("down", { status: 500 }),
    ]);
    const out = await client.generateImage({ model: "image-01", prompt: "p", width: 1200, height: 800 });
    expect(out.error).toBe("MiniMax HTTP 500: down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe("image helpers", () => {
  it("fits sides to 512–2048 in steps of 8", () => {
    expect(fitImageSide(1200)).toBe(1200);
    expect(fitImageSide(1205)).toBe(1208);
    expect(fitImageSide(300)).toBe(512);
    expect(fitImageSide(5000)).toBe(2048);
    expect(fitImageSide(Number.NaN)).toBe(1024);
  });

  it("detects the content type from magic bytes", () => {
    expect(imageContentType(new Uint8Array(JPEG))).toBe("image/jpeg");
    expect(imageContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(imageContentType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
      "image/webp",
    );
    expect(imageContentType(new Uint8Array([1, 2, 3]))).toBe("image/jpeg");
  });
});
