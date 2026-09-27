import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  languageFor,
  LOCALES,
  localeOf,
  localePrefix,
  otherLocale,
} from "../src/lib/locale";

describe("locales", () => {
  it("lists English (default) and Turkish", () => {
    expect(LOCALES).toEqual(["en", "tr"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("normalizes unknown or missing locales to the default", () => {
    expect(localeOf("tr")).toBe("tr");
    expect(localeOf("TR")).toBe("tr");
    expect(localeOf("en")).toBe("en");
    expect(localeOf(undefined)).toBe("en");
    expect(localeOf(null)).toBe("en");
    expect(localeOf("de")).toBe("en");
  });

  it("names the prompt language for each locale", () => {
    expect(languageFor("en")).toBe("English");
    expect(languageFor("tr")).toBe("Turkish");
  });

  it("prefixes only non-default locales in URLs", () => {
    expect(localePrefix("en")).toBe("");
    expect(localePrefix("tr")).toBe("/tr");
    expect(localePrefix(undefined)).toBe("");
  });

  it("names the other locale", () => {
    expect(otherLocale("en")).toBe("tr");
    expect(otherLocale("tr")).toBe("en");
  });
});
