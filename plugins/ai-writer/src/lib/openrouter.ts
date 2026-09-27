import { parseOpenRouterUsage, type Usage } from "./usage";
export type OpenRouterOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export type GenerateTextInput = {
  model: string;
  system?: string;
  prompt: string;
  responseFormat?: { type: "json_object" };
  /** Tried in order if the primary model call throws (after its built-in
   *  4xx/retry envelope). Used for soft-failover between OpenRouter
   *  providers without round-tripping to the UI. */
  fallbackModels?: string[];
  /** Sampling temperature (0–2). Omitted from the request when undefined. */
  temperature?: number;
  /** Per-call timeout for long replies (e.g. whole-article edits); defaults to the chat timeout. */
  timeoutMs?: number;
};

export type GenerateTextOutput = {
  json: unknown;
  raw: string;
  /** Tokens and exact cost (USD) as reported by the provider, when it reports them. */
  usage?: Usage;
};

export type GenerateImageInput = {
  model: string;
  prompt: string;
  width: number;
  height: number;
};

export type GenerateImageOutput = {
  bytes: Uint8Array;
  contentType: string;
  /** Provider/transport error text when no image could be produced. */
  error?: string;
  usage?: Usage;
};

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

// Request timeouts so a stuck upstream call fails cleanly instead of hanging.
const CHAT_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Reduces a thrown error to a short, readable provider message. When the
// message is our own `OpenRouter <status>: <body>` envelope and the body is
// JSON with an `error.message` string, that string replaces the raw body —
// so other body fields (e.g. `user_id`) never leak into surfaced text.
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^OpenRouter (\d{3}): ([\s\S]*)$/.exec(message);
  if (match) {
    const [, status, body] = match;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (parsed && typeof parsed.error?.message === "string") {
        return `OpenRouter ${status}: ${parsed.error.message}`.slice(0, 200);
      }
    } catch {
      // Body wasn't JSON (or had no error.message) — keep the original text.
    }
  }
  return message.slice(0, 200);
}

function statusFromMessage(message: string): number | undefined {
  const match = /^OpenRouter (\d{3}):/.exec(message);
  return match ? Number(match[1]) : undefined;
}

async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJsonWithRetry<T>(
  url: string,
  apiKey: string,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const lastAttempt = 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= lastAttempt; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status >= 400 && res.status < 500) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`OpenRouter ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /\b4\d\d\b/.test(err.message)) throw err;
    }
    if (attempt < lastAttempt) {
      // Exponential backoff capped at 15s per attempt; well under the spec's
      // 30s total retry envelope (2 attempts × max 15s = 30s). Only between
      // attempts — never after the final one, which is about to throw.
      await sleep(Math.min(15000, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastErr ?? new Error("OpenRouter call failed after retry");
}

export function createOpenRouterClient(options: OpenRouterOptions) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const apiKey = options.apiKey;
  const f = options.fetchImpl ?? fetch;

  return {
    async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
      const build = (model: string): Record<string, unknown> => ({
        model,
        messages: [
          ...(input.system ? [{ role: "system", content: input.system }] : []),
          { role: "user", content: input.prompt },
        ],
        ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      });
      type ChatResponse = {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
      const models = [input.model, ...(input.fallbackModels ?? [])];
      let data: ChatResponse | undefined;
      const attempts: Array<{ model: string; message: string }> = [];
      for (const model of models) {
        try {
          data = await postJsonWithRetry<ChatResponse>(
            `${base}/chat/completions`,
            apiKey,
            build(model),
            f,
            input.timeoutMs ?? CHAT_TIMEOUT_MS,
          );
          break;
        } catch (err) {
          attempts.push({ model, message: describeError(err) });
        }
      }
      if (!data) {
        throw new Error(
          attempts.length > 0
            ? attempts.map((a) => `${a.model}: ${a.message}`).join(" · ")
            : "OpenRouter: all fallback models failed",
        );
      }
      const raw = data.choices?.[0]?.message?.content ?? "";
      let json: unknown = raw;
      // Some models wrap JSON in a markdown code fence even in JSON mode.
      const trimmed = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = raw;
        }
      }
      const usage = parseOpenRouterUsage(data.usage);
      return usage ? { json, raw, usage } : { json, raw };
    },

    async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
      // OpenRouter exposes image generation at POST /api/v1/images (not
      // /images/generations — that's the OpenAI shape). Body needs at
      // least { model, prompt }; `size` is an optional convenience — and
      // some image models reject arbitrary sizes with a 4xx, so a 4xx on a
      // sized request is retried once without `size` before giving up.
      const hasSize = Number.isFinite(input.width) && Number.isFinite(input.height);
      const buildBody = (includeSize: boolean): Record<string, unknown> => {
        const b: Record<string, unknown> = {
          model: input.model,
          prompt: input.prompt,
        };
        if (includeSize && hasSize) {
          b.size = `${input.width}x${input.height}`;
        }
        return b;
      };
      type ImageResponse = {
        data?: Array<{
          b64_json?: string;
          url?: string;
          media_type?: string;
        }>;
        usage?: unknown;
      };
      let data: ImageResponse;
      try {
        data = await postJsonWithRetry<ImageResponse>(
          `${base}/images`,
          apiKey,
          buildBody(true),
          f,
          IMAGE_TIMEOUT_MS,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = statusFromMessage(message);
        // Only retry without `size` when the size itself was rejected
        // (400/422). Auth, quota, and rate-limit failures (401/402/403/429)
        // would fail again identically without `size`, so don't burn a
        // second call on those.
        if (hasSize && (status === 400 || status === 422)) {
          try {
            data = await postJsonWithRetry<ImageResponse>(
              `${base}/images`,
              apiKey,
              buildBody(false),
              f,
              IMAGE_TIMEOUT_MS,
            );
          } catch (err2) {
            return { bytes: new Uint8Array(0), contentType: "image/png", error: describeError(err2) };
          }
        } else {
          return { bytes: new Uint8Array(0), contentType: "image/png", error: describeError(err) };
        }
      }
      const first = data.data?.[0];
      const usage = parseOpenRouterUsage(data.usage);
      if (first?.b64_json) {
        const bytes = Uint8Array.from(atob(first.b64_json), (c) => c.charCodeAt(0));
        return { bytes, contentType: first.media_type ?? "image/png", ...(usage ? { usage } : {}) };
      }
      if (first?.url) {
        const imgRes = await f(first.url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
        if (!imgRes.ok) {
          return {
            bytes: new Uint8Array(0),
            contentType: "image/png",
            error: `OpenRouter returned no image data: image URL fetch failed with ${imgRes.status}`.slice(0, 300),
          };
        }
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        return { bytes: buf, contentType: imgRes.headers.get("content-type") ?? "image/png", ...(usage ? { usage } : {}) };
      }
      return {
        bytes: new Uint8Array(0),
        contentType: "image/png",
        error: "OpenRouter returned no image data",
      };
    },
  };
}

export type OpenRouterClient = ReturnType<typeof createOpenRouterClient>;

/** Prices are USD per token, as OpenRouter lists them (absent when unknown). */
export type ListedModel = { id: string; name: string; promptPrice?: number; completionPrice?: number };

type RawModel = { id?: string; name?: string; pricing?: { prompt?: unknown; completion?: unknown } };

const price = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function parseModelList(body: { data?: RawModel[] }): ListedModel[] {
  const models = (body.data ?? [])
    .filter((m): m is RawModel & { id: string } => typeof m.id === "string" && m.id.length > 0)
    .map((m) => {
      const promptPrice = price(m.pricing?.prompt);
      const completionPrice = price(m.pricing?.completion);
      return {
        id: m.id,
        name: m.name?.trim() || m.id,
        ...(promptPrice !== undefined ? { promptPrice } : {}),
        ...(completionPrice !== undefined ? { completionPrice } : {}),
      };
    });
  models.sort((a, b) => a.name.localeCompare(b.name));
  return models;
}

// Text-model catalog (`/models`), minimal `{ id, name }[]` sorted by name.
// Network-only; callers cache (see lib/models.ts getCatalog).
export async function listModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_BASE,
  signal?: AbortSignal,
): Promise<ListedModel[]> {
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ?? AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter models ${res.status}: ${text.slice(0, 200)}`);
  }
  return parseModelList((await res.json()) as { data?: RawModel[] });
}

// Image-model catalog (`/images/models`), same shape as listModels.
export async function listImageModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = DEFAULT_BASE,
): Promise<ListedModel[]> {
  const res = await fetchImpl(`${baseUrl}/images/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter image models ${res.status}: ${text.slice(0, 200)}`);
  }
  return parseModelList((await res.json()) as { data?: RawModel[] });
}
