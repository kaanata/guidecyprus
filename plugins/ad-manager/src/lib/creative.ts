import { AD_SPACES } from "../spaces";
import type { Creative, StoredAd } from "./types";

/** Public, browser-safe view of an ad. Never includes names, weights, schedules or targeting. */
export function toCreative(ad: StoredAd): Creative {
  const disclosure = ad.disclosure ? { disclosure: ad.disclosure } : {};
  if (ad.kind === "banner" && ad.banner) {
    const { image, mobileImage, href, alt } = ad.banner;
    return {
      adId: ad.id,
      kind: "banner",
      width: image.width,
      height: image.height,
      href,
      alt,
      image: { url: image.url, width: image.width, height: image.height },
      ...(mobileImage
        ? { mobileImage: { url: mobileImage.url, width: mobileImage.width, height: mobileImage.height } }
        : {}),
      ...disclosure,
    };
  }
  const box = AD_SPACES[ad.space].reserve.desktop;
  return { adId: ad.id, kind: "code", width: box.width, height: box.height, html: ad.code?.html ?? "", ...disclosure };
}
