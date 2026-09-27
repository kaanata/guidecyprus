import { resolveModel } from "./models";
import type { OpenRouterClient } from "./openrouter";
import type { Settings } from "./settings";
import type { FeaturedImage, ModelOverrides } from "./types";

export type MediaUploader = {
  upload(filename: string, contentType: string, bytes: ArrayBuffer): Promise<{ mediaId: string; url: string }>;
};

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

const SAFE_SUFFIX = "Editorial photograph, natural light, no text, no logos, no watermarks.";

export function imagePromptFor(title: string): string {
  return `${title.trim()}. ${SAFE_SUFFIX}`;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export async function generateFeaturedImage(
  deps: {
    client: Pick<OpenRouterClient, "generateImage">;
    media?: MediaUploader;
    settings: Settings;
    ruleModels?: ModelOverrides;
  },
  input: { prompt: string; alt: string; model?: string },
): Promise<FeaturedImage> {
  if (!deps.media) throw new ImageError("Media upload is unavailable (the media:write capability is missing)");
  const { model } = resolveModel("image", {
    request: input.model,
    rule: deps.ruleModels,
    settings: deps.settings.models,
    provider: deps.settings.providers.image,
  });
  const out = await deps.client.generateImage({
    model,
    prompt: input.prompt,
    width: deps.settings.imageSize.width,
    height: deps.settings.imageSize.height,
  });
  if (out.bytes.byteLength === 0) {
    throw new ImageError(`Image model "${model}" returned no image${out.error ? `: ${out.error}` : ""}`);
  }
  const buffer = out.bytes.buffer.slice(
    out.bytes.byteOffset,
    out.bytes.byteOffset + out.bytes.byteLength,
  ) as ArrayBuffer;
  const ext = EXTENSIONS[out.contentType] ?? "png";
  const uploaded = await deps.media.upload(`ai-writer-${Date.now()}.${ext}`, out.contentType, buffer);
  // Image fields are objects, not strings (see CLAUDE.md).
  return { provider: "local", id: uploaded.mediaId, src: uploaded.url, alt: input.alt };
}
