/**
 * The home page's finder ("I'm looking for [kind] in [town]") is a plain GET
 * form aimed at the all-places listing, so it works without JavaScript. Its
 * answer arrives as `/posts?kind=<category slug>&town=<key>&region=<key>`,
 * with any of them empty; this turns that into the listing it means:
 * `/category/<kind>?town=...` for a kind, `/posts?town=...` for any kind.
 */
import { localePath } from "./i18n";

/** The query parameter the finder sends the category slug in. */
export const KIND_PARAM = "kind";

/** Category slugs are lowercase words joined by hyphens. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Where a finder submission should land, or null when the URL is not one
 * (no `kind` parameter). Empty parameters are dropped from the target.
 */
export function finderTarget(url: URL, locale: string | undefined | null): string | null {
	if (!url.searchParams.has(KIND_PARAM)) return null;
	const kind = url.searchParams.get(KIND_PARAM) ?? "";
	const path = SLUG.test(kind) ? `/category/${kind}` : "/posts";
	const params = new URLSearchParams();
	for (const [key, value] of url.searchParams) {
		if (key !== KIND_PARAM && value) params.set(key, value);
	}
	const query = params.toString();
	return `${localePath(locale ?? undefined, path)}${query ? `?${query}` : ""}`;
}
