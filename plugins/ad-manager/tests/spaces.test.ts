import { AD_SPACES, AD_SPACE_IDS, PAGE_TYPES, isAcceptedSize } from "../src/spaces";

describe("AD_SPACES", () => {
  it("defines every space id exactly once", () => {
    expect(Object.keys(AD_SPACES).sort()).toEqual([...AD_SPACE_IDS].sort());
    for (const id of AD_SPACE_IDS) expect(AD_SPACES[id].id).toBe(id);
  });

  it("has no phone reserve for the article sidebar", () => {
    expect(AD_SPACES["article-sidebar"].reserve.mobile).toBeNull();
  });

  it("lists the supported page types", () => {
    expect(PAGE_TYPES).toEqual(["home", "latest", "competition", "article", "tag", "search", "page"]);
  });
});

describe("isAcceptedSize", () => {
  it("accepts the listed main sizes", () => {
    expect(isAcceptedSize("top-banner", { width: 728, height: 90 }, "main")).toBe(true);
    expect(isAcceptedSize("article-sidebar", { width: 300, height: 250 }, "main")).toBe(true);
  });

  it("rejects sizes that are not listed", () => {
    expect(isAcceptedSize("in-feed", { width: 300, height: 600 }, "main")).toBe(false);
  });

  it("checks phone sizes separately", () => {
    expect(isAcceptedSize("top-banner", { width: 320, height: 50 }, "mobile")).toBe(true);
    expect(isAcceptedSize("top-banner", { width: 970, height: 90 }, "mobile")).toBe(false);
    expect(isAcceptedSize("in-feed", { width: 300, height: 250 }, "mobile")).toBe(false);
  });
});
