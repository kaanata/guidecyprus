/**
 * A place's "kind" is its category. Two categories are not kinds a traveller
 * looks for: "uncategorized" (an import leftover, never shown) and "girne"
 * (a town, shown only when the place has no better category).
 */

interface KindTerm {
	slug: string;
	label: string;
}

const HIDDEN = "uncategorized";
const NOT_A_KIND = new Set([HIDDEN, "girne"]);

/** The categories worth showing, real kinds first, "girne" last, "uncategorized" dropped. */
export function orderKinds<T extends KindTerm>(terms: readonly T[] | undefined | null): T[] {
	const shown = (terms ?? []).filter((term) => term.slug !== HIDDEN);
	return [
		...shown.filter((term) => !NOT_A_KIND.has(term.slug)),
		...shown.filter((term) => NOT_A_KIND.has(term.slug)),
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
