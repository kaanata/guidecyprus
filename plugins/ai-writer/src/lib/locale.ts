import { z } from "zod";

// The site is bilingual: English (default, routed at /{slug}) and Turkish
// (routed at /tr/{slug}). Content is one row per locale, linked by a
// translation group; taxonomy terms exist per locale with the same slugs.

export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Admin labels for locale pickers. */
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", tr: "Türkçe" };

/** The language named in writing prompts. */
const LOCALE_LANGUAGES: Record<Locale, string> = { en: "English", tr: "Turkish" };

export const localeSchema = z.enum(LOCALES);

/** A supported locale, or the default for anything else (missing, unknown). */
export function localeOf(value: unknown): Locale {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (LOCALES as readonly string[]).includes(code) ? (code as Locale) : DEFAULT_LOCALE;
}

export function languageFor(locale: Locale): string {
  return LOCALE_LANGUAGES[locale];
}

/** URL prefix for a locale: "" for the default locale, "/tr" for Turkish. */
export function localePrefix(locale: unknown): string {
  const l = localeOf(locale);
  return l === DEFAULT_LOCALE ? "" : `/${l}`;
}

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "tr" : "en";
}
