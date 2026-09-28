import { getRelativeLocaleUrl } from "astro:i18n";

/**
 * Prefix a site path for the active locale; the default locale stays unprefixed.
 * No trailing slash (except the root): src/middleware.ts 301s `/path/` to `/path`.
 */
export function localePath(locale: string | undefined, path: string): string {
	const url = getRelativeLocaleUrl(locale ?? "en", path.replace(/^\//, ""));
	return url.length > 1 ? url.replace(/\/+$/, "") : url;
}
