import { describe, expect, it, vi } from "vitest";
import { generateFeaturedImage, ImageError, imagePromptFor } from "../src/lib/image";
import type { GenerateImageInput, GenerateImageOutput } from "../src/lib/openrouter";
import { defaultSettings } from "../src/lib/settings";

function imageClient(out: GenerateImageOutput) {
  const calls: GenerateImageInput[] = [];
  return {
    calls,
    client: {
      async generateImage(input: GenerateImageInput): Promise<GenerateImageOutput> {
        calls.push(input);
        return out;
      },
    },
  };
}

const jpeg = { bytes: new Uint8Array([255, 216, 255]), contentType: "image/jpeg" };
const media = () => ({
  upload: vi.fn(async (_filename: string, _type: string, _bytes: ArrayBuffer) => ({
    mediaId: "m1",
    url: "/_emdash/api/media/file/m1.jpg",
  })),
});

describe("image", () => {
  it("imagePromptFor appends the safe editorial suffix", () => {
    expect(imagePromptFor(" Green tea ")).toBe(
      "Green tea. Editorial photograph, natural light, no text, no logos, no watermarks.",
    );
  });

  it("throws ImageError without media access and makes no call", async () => {
    const { client, calls } = imageClient(jpeg);
    await expect(
      generateFeaturedImage({ client, settings: defaultSettings }, { prompt: "p", alt: "a" }),
    ).rejects.toBeInstanceOf(ImageError);
    expect(calls).toHaveLength(0);
  });

  it("uses the default image model and Settings size, then uploads with the right extension", async () => {
    const { client, calls } = imageClient(jpeg);
    const m = media();
    const img = await generateFeaturedImage(
      { client, media: m, settings: defaultSettings },
      { prompt: "p", alt: "Green tea" },
    );
    expect(calls[0]).toEqual({ model: "bytedance-seed/seedream-5-0-lite", prompt: "p", width: 1200, height: 800 });
    expect(m.upload.mock.calls[0][0]).toMatch(/^ai-writer-\d+\.jpg$/);
    expect(m.upload.mock.calls[0][1]).toBe("image/jpeg");
    expect(img).toEqual({ provider: "local", id: "m1", src: "/_emdash/api/media/file/m1.jpg", alt: "Green tea" });
  });

  it("a per-request image model wins", async () => {
    const { client, calls } = imageClient(jpeg);
    await generateFeaturedImage({ client, media: media(), settings: defaultSettings }, { prompt: "p", alt: "a", model: "req/img" });
    expect(calls[0].model).toBe("req/img");
  });

  it("throws ImageError naming the model when no bytes come back", async () => {
    const { client } = imageClient({ bytes: new Uint8Array(0), contentType: "image/png" });
    await expect(
      generateFeaturedImage({ client, media: media(), settings: defaultSettings }, { prompt: "p", alt: "a" }),
    ).rejects.toThrow(/bytedance-seed\/seedream-5-0-lite/);
  });

  it("includes the provider error in the ImageError message", async () => {
    const { client } = imageClient({
      bytes: new Uint8Array(0),
      contentType: "image/png",
      error: "OpenRouter 400: size too small",
    });
    await expect(
      generateFeaturedImage({ client, media: media(), settings: defaultSettings }, { prompt: "p", alt: "a" }),
    ).rejects.toThrow(/bytedance-seed\/seedream-5-0-lite.*size too small/s);
  });
});

describe("provider-aware image model", () => {
  it("resolves the image model against the image provider and keeps the JPEG extension", async () => {
    const generateImage = vi.fn(async (_input: GenerateImageInput): Promise<GenerateImageOutput> => ({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg",
    }));
    const upload = vi.fn(async (_f: string, _t: string, _b: ArrayBuffer) => ({ mediaId: "m1", url: "/m1.jpg" }));
    const settings = {
      ...defaultSettings,
      providers: { text: "openrouter" as const, image: "minimax" as const },
      models: { ...defaultSettings.models, defaultImage: "image-01" },
    };
    await generateFeaturedImage(
      { client: { generateImage }, media: { upload }, settings, ruleModels: { image: "bytedance-seed/x" } },
      { prompt: "p", alt: "a" },
    );
    expect(generateImage.mock.calls[0][0]).toMatchObject({ model: "image-01" });
    expect(upload.mock.calls[0][0]).toMatch(/\.jpg$/);
    expect(upload.mock.calls[0][1]).toBe("image/jpeg");
  });
});
