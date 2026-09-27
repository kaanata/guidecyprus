import { adInputSchema, fieldErrorsOf, serveInputSchema, trackInputSchema } from "../src/lib/schema";

const image = (width: number, height: number) => ({ mediaId: "m1", url: "/_emdash/api/media/file/a.jpg", width, height });

const banner = (overrides: Record<string, unknown> = {}) => ({
  name: "Welcome offer",
  kind: "banner",
  space: "in-feed",
  banner: { image: image(300, 250), href: "https://example.com/offer", alt: "Welcome offer banner" },
  ...overrides,
});

function errorsFor(input: unknown): Record<string, string> {
  const result = adInputSchema.safeParse(input);
  if (result.success) throw new Error("expected validation to fail");
  return fieldErrorsOf(result.error);
}

describe("adInputSchema", () => {
  it("accepts country codes and upper-cases them", () => {
    const ad = adInputSchema.parse(banner({ targeting: { countries: ["tr", "GB"] } }));
    expect(ad.targeting.countries).toEqual(["TR", "GB"]);
  });

  it("rejects codes that aren't countries", () => {
    expect(adInputSchema.safeParse(banner({ targeting: { countries: ["ZZ"] } })).success).toBe(false);
    expect(adInputSchema.safeParse(banner({ targeting: { countries: ["TUR"] } })).success).toBe(false);
  });

  it("accepts a valid banner and fills defaults", () => {
    const ad = adInputSchema.parse(banner());
    expect(ad.status).toBe("active");
    expect(ad.weight).toBe(10);
    expect(ad.targeting).toEqual({ pageTypes: [], competitions: [], countries: [] });
  });

  it("requires banner fields for banner ads", () => {
    expect(errorsFor(banner({ banner: undefined })).banner).toBe("Add an image and a link");
  });

  it("requires code for code ads and forbids a banner on them", () => {
    const errors = errorsFor(banner({ kind: "code" }));
    expect(errors["code.html"]).toBe("Paste the ad code");
    expect(errors.banner).toBe("Code ads can't include a banner");
  });

  it("accepts a code ad", () => {
    const ad = adInputSchema.parse({ name: "AdSense", kind: "code", space: "in-article", code: { html: "<ins></ins>" } });
    expect(ad.code?.html).toBe("<ins></ins>");
  });

  it("rejects image sizes the space doesn't accept", () => {
    const errors = errorsFor(banner({ banner: { image: image(728, 90), href: "https://example.com", alt: "x" } }));
    expect(errors["banner.image"]).toBe("This space doesn't accept 728×90 images");
  });

  it("allows a phone image only on the top banner", () => {
    const withPhone = (space: string, phone: { width: number; height: number }) =>
      banner({
        space,
        banner: {
          image: space === "top-banner" ? image(970, 90) : image(300, 250),
          mobileImage: image(phone.width, phone.height),
          href: "https://example.com",
          alt: "x",
        },
      });
    expect(adInputSchema.safeParse(withPhone("top-banner", { width: 320, height: 100 })).success).toBe(true);
    expect(errorsFor(withPhone("in-feed", { width: 320, height: 100 }))["banner.mobileImage"]).toBe(
      "Only the top banner has a phone image",
    );
    expect(errorsFor(withPhone("top-banner", { width: 300, height: 250 }))["banner.mobileImage"]).toBe(
      "Phone image must be 320×100 or 320×50",
    );
  });

  it("restricts the image url to a site-relative path or an http(s) url", () => {
    const withImageUrl = (url: string) => banner({ banner: { image: { ...image(300, 250), url }, href: "https://example.com", alt: "x" } });
    expect(adInputSchema.safeParse(withImageUrl("/_emdash/api/media/file/abc.jpg")).success).toBe(true);
    expect(adInputSchema.safeParse(withImageUrl("https://cdn.example.com/a.jpg")).success).toBe(true);
    expect(errorsFor(withImageUrl("javascript:alert(1)"))["banner.image.url"]).toBeTruthy();
    expect(errorsFor(withImageUrl("data:text/html,x"))["banner.image.url"]).toBeTruthy();
    expect(errorsFor(withImageUrl(""))["banner.image.url"]).toBeTruthy();
  });

  it("rejects links that are not http or https", () => {
    const errors = errorsFor(banner({ banner: { image: image(300, 250), href: "javascript:alert(1)", alt: "x" } }));
    expect(errors["banner.href"]).toBe("Link must start with http:// or https://");
  });

  it("rejects an end time that is not after the start time", () => {
    const errors = errorsFor(banner({ startsAt: "2026-09-12T10:00:00.000Z", endsAt: "2026-09-12T10:00:00.000Z" }));
    expect(errors.endsAt).toBe("End time must be after the start time");
  });

  it("caps text lengths and weight", () => {
    expect(errorsFor(banner({ name: "x".repeat(81) }))).toHaveProperty("name");
    expect(errorsFor(banner({ disclosure: "x".repeat(121) }))).toHaveProperty("disclosure");
    expect(errorsFor(banner({ weight: 0 }))).toHaveProperty("weight");
    expect(errorsFor(banner({ weight: 101 }))).toHaveProperty("weight");
  });
});

describe("serveInputSchema", () => {
  it("accepts a page with a competition", () => {
    const input = { page: { type: "article", competition: "premier-league" }, spaces: [{ space: "in-feed", count: 2 }] };
    expect(serveInputSchema.parse(input)).toEqual(input);
  });

  it("limits counts and the number of entries", () => {
    expect(serveInputSchema.safeParse({ page: { type: "home" }, spaces: [{ space: "in-feed", count: 5 }] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, () => ({ space: "in-feed", count: 1 }));
    expect(serveInputSchema.safeParse({ page: { type: "home" }, spaces: nine }).success).toBe(false);
  });
});

describe("trackInputSchema", () => {
  it("caps a request at 50 events", () => {
    const events = Array.from({ length: 51 }, () => ({ adId: "a", space: "in-feed", type: "impression" }));
    expect(trackInputSchema.safeParse({ events }).success).toBe(false);
    expect(trackInputSchema.safeParse({ events: events.slice(0, 50) }).success).toBe(true);
  });
});
