/**
 * A place's "kind" is its category. Some categories are not the kind a
 * traveller looks for: "uncategorized" (an import leftover, never shown),
 * "entertainment" (the parent of restaurants, bars, cafés, beaches and the
 * rest, shown only when the place has nothing more specific) and "girne" (a
 * town, shown only when the place has no better category).
 */

interface KindTerm {
	slug: string;
	label: string;
}

const HIDDEN = "uncategorized";
/** Broad parent categories: behind any specific kind. (The tr kinds sit under "girne".) */
const BROAD = new Set(["entertainment"]);
const TOWN = "girne";

/** The categories worth showing: specific kinds, then broad ones, "girne" last, "uncategorized" dropped. */
export function orderKinds<T extends KindTerm>(terms: readonly T[] | undefined | null): T[] {
	const shown = (terms ?? []).filter((term) => term.slug !== HIDDEN);
	return [
		...shown.filter((term) => !BROAD.has(term.slug) && term.slug !== TOWN),
		...shown.filter((term) => BROAD.has(term.slug)),
		...shown.filter((term) => term.slug === TOWN),
	];
}

/** The one category that best names what a place is, if any. */
export function primaryKind<T extends KindTerm>(terms: readonly T[] | undefined | null): T | undefined {
	return orderKinds(terms)[0];
}

/**
 * How many entries carry each term, from a getTermsForEntries() map. Used for
 * kind counts within a region, where the taxonomy's own counts (whole site)
 * don't apply.
 */
export function countTerms(termsByEntry: ReadonlyMap<string, readonly KindTerm[]>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const terms of termsByEntry.values()) {
		for (const slug of new Set(terms.map((term) => term.slug))) {
			counts.set(slug, (counts.get(slug) ?? 0) + 1);
		}
	}
	return counts;
}

/** The kind illustrations KindPlaceholder shows (src/utils/illustrations.ts); "place" for any other kind. */
export type KindIcon =
	| "restaurant"
	| "hotel"
	| "cafe"
	| "bar"
	| "beach"
	| "historical"
	| "casino"
	| "club"
	| "entertainment"
	| "services"
	| "place";

/** Category slugs (en and tr) to the illustration that stands for them. */
const KIND_ICONS: Record<string, KindIcon> = {
	restaurants: "restaurant",
	restoranlar: "restaurant",
	hotels: "hotel",
	oteller: "hotel",
	"coffee-shop": "cafe",
	kahveler: "cafe",
	"bar-pub": "bar",
	"bar-pub-2": "bar",
	beaches: "beach",
	plajlar: "beach",
	historical: "historical",
	"tarihi-yerler": "historical",
	casino: "casino",
	kumarhaneler: "casino",
	clubs: "club",
	"gece-kulupleri": "club",
	entertainment: "entertainment",
	eglence: "entertainment",
	services: "services",
	hizmetler: "services",
};

/** The illustration for a place whose primary category is `slug`. */
export function kindIcon(slug: string | undefined | null): KindIcon {
	return (slug && KIND_ICONS[slug]) || "place";
}
