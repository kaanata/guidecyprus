/**
 * Where a visitor is going: the whole island, the TRNC (KKTC) or South Cyprus.
 *
 * Places carry a `region` taxonomy term. The URL uses a short key that is the
 * same in both languages (`?region=trnc`, `?region=south`); each locale has
 * its own term slug, which is what content queries filter on.
 */
import { toLocale, type StringKey } from "./strings";

export const REGION_KEYS = ["trnc", "south"] as const;
export type RegionKey = (typeof REGION_KEYS)[number];

/** The query parameter that carries the region key. */
export const REGION_PARAM = "region";

/** Each region's term slug in the `region` taxonomy, per locale. */
const TERM_SLUGS: Record<"en" | "tr", Record<RegionKey, string>> = {
	en: { trnc: "trnc", south: "south-cyprus" },
	tr: { trnc: "kktc", south: "guney-kibris" },
};

/** Switch labels and "in <region>" phrases, by key (see the REGION block in strings.ts). */
export const REGION_LABEL: Record<RegionKey, StringKey> = {
	trnc: "region.trnc",
	south: "region.south",
};
export const REGION_IN: Record<RegionKey, StringKey> = {
	trnc: "region.inTrnc",
	south: "region.inSouth",
};

function isRegionKey(value: string | null): value is RegionKey {
	return value !== null && (REGION_KEYS as readonly string[]).includes(value);
}

/** The region chosen in the URL, or null for the whole island (unknown values are ignored). */
export function regionFromUrl(url: URL): RegionKey | null {
	const value = url.searchParams.get(REGION_PARAM);
	return isRegionKey(value) ? value : null;
}

/** The `region` term slug for a key in a locale, for `where: { region: ... }`. */
export function regionTermSlug(locale: string | undefined | null, key: RegionKey): string {
	return TERM_SLUGS[toLocale(locale)][key];
}

/** The region key for a term slug in any locale, or null if it is not a known region. */
export function regionFromTermSlug(slug: string | undefined | null): RegionKey | null {
	if (!slug) return null;
	for (const slugs of Object.values(TERM_SLUGS)) {
		for (const key of REGION_KEYS) {
			if (slugs[key] === slug) return key;
		}
	}
	return null;
}

/**
 * A root-relative href for `target` (a path, optionally with a query, or a URL)
 * with the region parameter set to `key`, or removed when `key` is null.
 * Other query parameters are kept; the hash is dropped.
 */
export function withRegion(target: string | URL, key: RegionKey | null): string {
	const url = new URL(target.toString(), "http://x");
	if (key) url.searchParams.set(REGION_PARAM, key);
	else url.searchParams.delete(REGION_PARAM);
	return `${url.pathname}${url.search}`;
}
