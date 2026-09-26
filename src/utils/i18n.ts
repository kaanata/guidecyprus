import { getRelativeLocaleUrl } from "astro:i18n";

/** Prefix a site path for the active locale; the default locale stays unprefixed. */
export function localePath(locale: string | undefined, path: string): string {
	return getRelativeLocaleUrl(locale ?? "en", path.replace(/^\//, ""));
}
