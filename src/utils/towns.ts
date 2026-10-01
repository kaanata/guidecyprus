/**
 * Towns: where on the island a place is, for the home map's markers and the
 * `?town=` filter on the listing.
 *
 * Places carry a `town` taxonomy term. As with regions, the URL uses a key
 * that is the same in both languages (`?town=kyrenia`); each locale has its
 * own term slug, which is what content queries filter on. Town names shown to
 * readers come from the term labels; the label keys here are the fallback.
 */
import { toLocale, type StringKey } from "./strings";
import type { RegionKey } from "./region";

/** The query parameter that carries the town key. */
export const TOWN_PARAM = "town";

/** Which side of the label the marker's dot is on. */
export type LabelSide = "above" | "below" | "left" | "right";

export interface Town {
	key: string;
	/** Term slug in the `town` taxonomy, per locale. */
	slug: Record<"en" | "tr", string>;
	/** Fallback name (see the TOWN block in strings.ts). */
	label: StringKey;
	lat: number;
	lng: number;
	/** The region its places are in; Nicosia has places on both sides. */
	region: RegionKey | "both";
	/**
	 * Where the map label sits relative to the dot, hand-tuned so labels stay
	 * on the land and clear of each other at the hero's size. `dx`/`dy` nudge
	 * it further, in px.
	 */
	labelSide: LabelSide;
	dx?: number;
	dy?: number;
	/** The label's side on a narrow map (phones), where the towns sit closer together. */
	narrowSide: LabelSide;
}

export const TOWNS: readonly Town[] = [
	{ key: "kyrenia", slug: { en: "kyrenia", tr: "girne-kent" }, label: "town.kyrenia", lat: 35.3364, lng: 33.3182, region: "trnc", labelSide: "below", narrowSide: "above" },
	{ key: "nicosia", slug: { en: "nicosia", tr: "lefkosa" }, label: "town.nicosia", lat: 35.1856, lng: 33.3823, region: "both", labelSide: "right", narrowSide: "below" },
	{ key: "famagusta", slug: { en: "famagusta", tr: "gazimagusa" }, label: "town.famagusta", lat: 35.1174, lng: 33.9399, region: "trnc", labelSide: "left", narrowSide: "right" },
	{ key: "iskele", slug: { en: "iskele", tr: "iskele" }, label: "town.iskele", lat: 35.2867, lng: 33.8919, region: "trnc", labelSide: "left", narrowSide: "left" },
	{ key: "karpaz", slug: { en: "karpaz", tr: "karpaz" }, label: "town.karpaz", lat: 35.6, lng: 34.38, region: "trnc", labelSide: "left", narrowSide: "left" },
	{ key: "guzelyurt", slug: { en: "guzelyurt", tr: "guzelyurt" }, label: "town.guzelyurt", lat: 35.198, lng: 32.993, region: "trnc", labelSide: "below", narrowSide: "above" },
	{ key: "limassol", slug: { en: "limassol", tr: "limasol" }, label: "town.limassol", lat: 34.6786, lng: 33.0413, region: "south", labelSide: "above", narrowSide: "below" },
	{ key: "paphos", slug: { en: "paphos", tr: "baf" }, label: "town.paphos", lat: 34.7754, lng: 32.4245, region: "south", labelSide: "above", dx: 30, narrowSide: "right" },
	{ key: "larnaca", slug: { en: "larnaca", tr: "larnaka" }, label: "town.larnaca", lat: 34.9003, lng: 33.6232, region: "south", labelSide: "left", narrowSide: "left" },
	{ key: "ayia-napa", slug: { en: "ayia-napa", tr: "ayia-napa" }, label: "town.ayiaNapa", lat: 34.9823, lng: 34.0007, region: "south", labelSide: "left", narrowSide: "below" },
	{ key: "troodos", slug: { en: "troodos", tr: "trodos" }, label: "town.troodos", lat: 34.9214, lng: 32.8822, region: "south", labelSide: "above", narrowSide: "above" },
];

const BY_KEY = new Map<string, Town>(TOWNS.map((town) => [town.key, town]));

export function townByKey(key: string | null | undefined): Town | undefined {
	return key ? BY_KEY.get(key) : undefined;
}

/** The town chosen in the URL, or null (unknown values are ignored). */
export function townFromUrl(url: URL): Town | null {
	return townByKey(url.searchParams.get(TOWN_PARAM)) ?? null;
}

/** The `town` term slug for a key in a locale, for `where: { town: ... }`. */
export function townTermSlug(locale: string | undefined | null, key: string): string | undefined {
	return townByKey(key)?.slug[toLocale(locale)];
}

/** The town for a term slug in any locale, or undefined if it is not a known town. */
export function townFromTermSlug(slug: string | undefined | null): Town | undefined {
	if (!slug) return undefined;
	return TOWNS.find((town) => town.slug.en === slug || town.slug.tr === slug);
}

/**
 * A root-relative href for `target` with the town parameter set to `key`, or
 * removed when `key` is null. Other query parameters (e.g. `?region=`) are
 * kept; the hash is dropped.
 */
export function withTown(target: string | URL, key: string | null): string {
	const url = new URL(target.toString(), "http://x");
	if (key) url.searchParams.set(TOWN_PARAM, key);
	else url.searchParams.delete(TOWN_PARAM);
	return `${url.pathname}${url.search}`;
}

/**
 * Projection onto the island map (src/utils/island.ts, viewBox 0 0 1000 592):
 * equirectangular with longitude scaled by cos(35.1°), y pointing south.
 *
 *   x = (lng * cos(35.1°) - MIN_X) * SCALE
 *   y = (-lat - MIN_Y) * SCALE
 *
 * The constants were solved (least squares) from the three markers island.ts
 * was drawn with: Kyrenia (33.3167E, 35.3417N) -> (450.4, 184.7), Nicosia
 * (33.3823, 35.1856) -> (478.7, 267.0), Famagusta (33.9399, 35.1174) ->
 * (719.2, 302.9). They reproduce all three to within 0.1 unit.
 */
const COS_LAT = Math.cos((35.1 * Math.PI) / 180);
const MIN_X = 26.4037; // west edge of the outline, in scaled degrees of longitude
const MIN_Y = -35.6922; // north edge of the outline, as -latitude
const SCALE = 527.1; // viewBox units per degree of latitude

export function projectToIsland(lat: number, lng: number): { x: number; y: number } {
	return {
		x: (lng * COS_LAT - MIN_X) * SCALE,
		y: (-lat - MIN_Y) * SCALE,
	};
}

/**
 * Turkish needs the town name in the locative ("Girne'de", "Baf'ta") and its
 * adjectival form ("Girne'deki yerler"). The suffix follows the name's last
 * vowel (back a ı o u -> -da, front e i ö ü -> -de) and hardens to -ta/-te
 * after a voiceless consonant (f s t k ç ş h p). English returns the name.
 */
export function townLocative(
	locale: string | undefined | null,
	name: string,
	form: "in" | "of" = "in",
): string {
	if (toLocale(locale) !== "tr") return name;
	const lower = name.toLocaleLowerCase("tr");
	const vowels = lower.match(/[aıoueiöü]/g);
	const last = vowels?.[vowels.length - 1] ?? "e";
	const vowel = "aıou".includes(last) ? "a" : "e";
	const consonant = /[fstkçşhp]$/.test(lower) ? "t" : "d";
	return `${name}'${consonant}${vowel}${form === "of" ? "ki" : ""}`;
}
