import { isLive } from "../src/lib/schedule";
import { matchesCountry, matchesPage, visitorCountry } from "../src/lib/targeting";

describe("isLive", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");

  it("is live with no dates", () => {
    expect(isLive({}, now)).toBe(true);
  });

  it("is not live before the start and is live from the start", () => {
    expect(isLive({ startsAt: "2026-09-12T12:00:01.000Z" }, now)).toBe(false);
    expect(isLive({ startsAt: "2026-09-12T12:00:00.000Z" }, now)).toBe(true);
  });

  it("stops at the end time (exclusive)", () => {
    expect(isLive({ endsAt: "2026-09-12T12:00:00.000Z" }, now)).toBe(false);
    expect(isLive({ endsAt: "2026-09-12T12:00:01.000Z" }, now)).toBe(true);
  });
});

describe("matchesPage", () => {
  const ad = (pageTypes: string[], competitions: string[]) =>
    ({ targeting: { pageTypes, competitions } }) as Parameters<typeof matchesPage>[0];

  it("matches everywhere when both lists are empty", () => {
    expect(matchesPage(ad([], []), { type: "search" })).toBe(true);
  });

  it("filters by page type", () => {
    expect(matchesPage(ad(["article"], []), { type: "article" })).toBe(true);
    expect(matchesPage(ad(["article"], []), { type: "home" })).toBe(false);
  });

  it("filters by competition", () => {
    expect(matchesPage(ad([], ["premier-league"]), { type: "competition", competition: "premier-league" })).toBe(true);
    expect(matchesPage(ad([], ["premier-league"]), { type: "competition", competition: "la-liga" })).toBe(false);
  });

  it("never matches a competition list on a page without a competition", () => {
    expect(matchesPage(ad([], ["premier-league"]), { type: "home" })).toBe(false);
  });
});

describe("matchesCountry", () => {
  const ad = (countries?: string[]) =>
    ({ targeting: { pageTypes: [], competitions: [], countries } }) as Parameters<typeof matchesCountry>[0];

  it("matches every visitor when the list is empty or missing (older ads)", () => {
    expect(matchesCountry(ad([]), "TR")).toBe(true);
    expect(matchesCountry(ad(undefined), null)).toBe(true);
  });

  it("matches only the listed countries", () => {
    expect(matchesCountry(ad(["TR", "GB"]), "GB")).toBe(true);
    expect(matchesCountry(ad(["TR", "GB"]), "DE")).toBe(false);
  });

  it("never matches a country list when the visitor's country is unknown", () => {
    expect(matchesCountry(ad(["TR"]), null)).toBe(false);
  });
});

describe("visitorCountry", () => {
  it("normalises a real two-letter code", () => {
    expect(visitorCountry("tr")).toBe("TR");
    expect(visitorCountry("GB")).toBe("GB");
  });

  it("treats missing, unknown and Tor values as unknown", () => {
    expect(visitorCountry(null)).toBeNull();
    expect(visitorCountry(undefined)).toBeNull();
    expect(visitorCountry("XX")).toBeNull();
    expect(visitorCountry("T1")).toBeNull();
    expect(visitorCountry("")).toBeNull();
  });
});
