import { z } from "zod";
import { isCountryCode } from "../countries";
import { AD_SPACE_IDS, PAGE_TYPES, isAcceptedSize } from "../spaces";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const isIsoDate = (value: string) => !Number.isNaN(Date.parse(value));

// A site-relative path (never "//host/..." -- that's protocol-relative to another
// origin) or an absolute http(s) URL. Rejects javascript:/data:/other schemes that
// would otherwise reach an <img src> / <source srcset> in the browser loader.
const isSafeMediaUrl = (value: string) => (value.startsWith("/") && !value.startsWith("//")) || isHttpUrl(value);

const mediaRef = z.object({
  mediaId: z.string().min(1),
  url: z.string().min(1).refine(isSafeMediaUrl, "Image must be a site path or an http(s) URL"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const adInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1, "Enter a name").max(80),
    advertiser: z.string().trim().max(80).optional(),
    kind: z.enum(["banner", "code"]),
    space: z.enum(AD_SPACE_IDS),
    status: z.enum(["active", "paused"]).default("active"),
    weight: z.number().int().min(1).max(100).default(10),
    startsAt: z.string().refine(isIsoDate, "Enter a valid start time").optional(),
    endsAt: z.string().refine(isIsoDate, "Enter a valid end time").optional(),
    targeting: z
      .object({
        pageTypes: z.array(z.enum(PAGE_TYPES)).default([]),
        competitions: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
        countries: z
          .array(z.string().trim().toUpperCase().refine(isCountryCode, "Pick countries from the list"))
          .max(300)
          .default([]),
      })
      .default({ pageTypes: [], competitions: [], countries: [] }),
    disclosure: z.string().trim().max(120).optional(),
    banner: z
      .object({
        image: mediaRef,
        mobileImage: mediaRef.optional(),
        href: z.string().trim().refine(isHttpUrl, "Link must start with http:// or https://"),
        alt: z.string().trim().min(1, "Describe the image").max(125),
      })
      .optional(),
    code: z.object({ html: z.string().trim().min(1, "Paste the ad code").max(20000) }).optional(),
  })
  .superRefine((ad, ctx) => {
    if (ad.kind === "banner") {
      if (!ad.banner) ctx.addIssue({ code: "custom", path: ["banner"], message: "Add an image and a link" });
      if (ad.code) ctx.addIssue({ code: "custom", path: ["code"], message: "Banner ads can't include code" });
    } else {
      if (!ad.code) ctx.addIssue({ code: "custom", path: ["code", "html"], message: "Paste the ad code" });
      if (ad.banner) ctx.addIssue({ code: "custom", path: ["banner"], message: "Code ads can't include a banner" });
    }

    if (ad.banner) {
      const { image, mobileImage } = ad.banner;
      if (!isAcceptedSize(ad.space, image, "main")) {
        ctx.addIssue({
          code: "custom",
          path: ["banner", "image"],
          message: `This space doesn't accept ${image.width}×${image.height} images`,
        });
      }
      if (mobileImage) {
        if (ad.space !== "top-banner") {
          ctx.addIssue({ code: "custom", path: ["banner", "mobileImage"], message: "Only the top banner has a phone image" });
        } else if (!isAcceptedSize("top-banner", mobileImage, "mobile")) {
          ctx.addIssue({ code: "custom", path: ["banner", "mobileImage"], message: "Phone image must be 320×100 or 320×50" });
        }
      }
    }

    if (ad.startsAt && ad.endsAt && Date.parse(ad.endsAt) <= Date.parse(ad.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after the start time" });
    }
  });

export type AdInput = z.input<typeof adInputSchema>;
export type AdParsed = z.output<typeof adInputSchema>;

export const serveInputSchema = z.object({
  page: z.object({
    type: z.enum(PAGE_TYPES),
    competition: z.string().trim().min(1).max(100).optional(),
  }),
  spaces: z
    .array(z.object({ space: z.enum(AD_SPACE_IDS), count: z.number().int().min(1).max(4) }))
    .min(1)
    .max(8),
});
export type ServeInput = z.output<typeof serveInputSchema>;

export const trackInputSchema = z.object({
  events: z
    .array(
      z.object({
        adId: z.string().min(1).max(64),
        space: z.enum(AD_SPACE_IDS),
        type: z.enum(["impression", "click"]),
      }),
    )
    .min(1)
    .max(50),
});
export type TrackEvent = z.output<typeof trackInputSchema>["events"][number];

export const idInputSchema = z.object({ id: z.string().min(1) });
export const statsInputSchema = z.object({ days: z.union([z.literal(7), z.literal(30)]).default(7) });
export const settingsInputSchema = z.object({ codeAdsEnabled: z.boolean() });

/** First message per dotted field path, for showing next to form fields. */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
