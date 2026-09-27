import { parseOpenRouterUsage } from "./usage";
import type { GenerateImageInput, GenerateImageOutput, GenerateTextInput, GenerateTextOutput } from "./openrouter";

export type MiniMaxOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Test seam for the retry waits. */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_BASE = "https://api.minimax.io/v1";
const CHAT_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 120_000;
const RETRY_WAIT_MS = 2_000;
// image-01 allows 10 requests per minute.
const RATE_LIMIT_WAIT_MS = 7_000;
const MAX_IMAGE_PROMPT = 1500;
const RATE_LIMITED = 1002;
const RETRYABLE_TEXT_CODES = new Set([1000, 1001, RATE_LIMITED]);

const CODE_LABELS: Record<number, string> = {
  1002: "rate limit exceeded",
  1004: "authentication failed",
  1008: "insufficient balance",
  1026: "sensitive content detected",
  2013: "invalid parameters",
  2049: "invalid API key",
};

type BaseResp = { status_code?: number; status_msg?: string };

// One failed attempt. `retryWaitMs` is set when the attempt may be retried once.
class AttemptError extends Error {
  constructor(
    message: string,
    public readonly retryWaitMs?: number,
  ) {
    super(message.slice(0, 200));
    this.name = "MiniMaxError";
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
const CODE_FENCE = /^```[\w-]*\s*([\s\S]*?)\s*```$/;

/** Removes reasoning blocks and one surrounding code fence from a reply. */
export function cleanContent(content: string): string {
  const text = content.replace(THINK_BLOCK, "").trim();
  const fenced = CODE_FENCE.exec(text);
  return fenced ? fenced[1].trim() : text;
}

function parseReply(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** MiniMax accepts 512–2048 px sides divisible by 8. */
export function fitImageSide(n: number): number {
  const rounded = Number.isFinite(n) ? Math.round(n / 8) * 8 : 1024;
  return Math.min(2048, Math.max(512, rounded));
}

export function imageContentType(bytes: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

export function createMiniMaxClient(options: MiniMaxOptions) {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const f = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // MiniMax reports most failures as HTTP 200 with a non-zero
  // base_resp.status_code, so both layers are checked.
  async function postOnce<T extends { base_resp?: BaseResp }>(
    path: string,
    body: unknown,
    timeoutMs: number,
    waitForCode: (code: number) => number | undefined,
  ): Promise<T> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AttemptError(`MiniMax request failed: ${messageOf(err)}`, RETRY_WAIT_MS);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AttemptError(
        `MiniMax HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status >= 500 ? RETRY_WAIT_MS : undefined,
      );
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      throw new AttemptError("MiniMax returned a malformed response", RETRY_WAIT_MS);
    }
    const code = data.base_resp?.status_code ?? 0;
    if (code !== 0) {
      const label = data.base_resp?.status_msg?.trim() || CODE_LABELS[code] || "request failed";
      throw new AttemptError(`MiniMax ${code}: ${label}`, waitForCode(code));
    }
    return data;
  }

  async function post<T extends { base_resp?: BaseResp }>(
    path: string,
    body: unknown,
    timeoutMs: number,
    waitForCode: (code: number) => number | undefined,
  ): Promise<T> {
    try {
      return await postOnce<T>(path, body, timeoutMs, waitForCode);
    } catch (err) {
      if (!(err instanceof AttemptError) || err.retryWaitMs === undefined) throw err;
      await sleep(err.retryWaitMs);
      return postOnce<T>(path, body, timeoutMs, waitForCode);
    }
  }

  return {
    async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
      type ChatResponse = { choices?: Array<{ message?: { content?: string } }>; base_resp?: BaseResp; usage?: unknown };
      // reasoning_split keeps the model's thinking out of `content`. MiniMax
      // has no documented JSON mode, so responseFormat is not forwarded; the
      // prompts already ask for JSON and cleanContent unwraps stray fences.
      const build = (model: string) => ({
        model,
        messages: [
          ...(input.system ? [{ role: "system", content: input.system }] : []),
          { role: "user", content: input.prompt },
        ],
        reasoning_split: true,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      });
      const waitForCode = (code: number) => (RETRYABLE_TEXT_CODES.has(code) ? RETRY_WAIT_MS : undefined);
      const attempts: string[] = [];
      for (const model of [input.model, ...(input.fallbackModels ?? [])]) {
        try {
          const data = await post<ChatResponse>(
            "/chat/completions",
            build(model),
            input.timeoutMs ?? CHAT_TIMEOUT_MS,
            waitForCode,
          );
          const raw = cleanContent(data.choices?.[0]?.message?.content ?? "");
          // Token counts only: plan (subscription) and pay-as-you-go replies carry no price.
          const usage = parseOpenRouterUsage(data.usage);
          return usage ? { json: parseReply(raw), raw, usage: { ...usage, cost: undefined } } : { json: parseReply(raw), raw };
        } catch (err) {
          attempts.push(`${model}: ${messageOf(err)}`);
        }
      }
      throw new Error(attempts.length > 0 ? attempts.join(" · ") : "MiniMax: no model to call");
    },

    async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
      type ImageResponse = { data?: { image_base64?: string[] }; base_resp?: BaseResp };
      const fail = (error: string): GenerateImageOutput => ({
        bytes: new Uint8Array(0),
        contentType: "image/jpeg",
        error: error.slice(0, 300),
      });
      const waitForCode = (code: number) => (code === RATE_LIMITED ? RATE_LIMIT_WAIT_MS : undefined);
      let data: ImageResponse;
      try {
        data = await post<ImageResponse>(
          "/image_generation",
          {
            model: input.model,
            prompt: input.prompt.slice(0, MAX_IMAGE_PROMPT),
            width: fitImageSide(input.width),
            height: fitImageSide(input.height),
            response_format: "base64",
            n: 1,
          },
          IMAGE_TIMEOUT_MS,
          waitForCode,
        );
      } catch (err) {
        return fail(messageOf(err));
      }
      const encoded = data.data?.image_base64?.[0];
      if (!encoded) return fail("MiniMax returned no image data");
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      } catch {
        return fail("MiniMax returned invalid image data");
      }
      return { bytes, contentType: imageContentType(bytes) };
    },
  };
}

export type MiniMaxClient = ReturnType<typeof createMiniMaxClient>;
