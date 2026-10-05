/**
 * Photo credits. Every photo of a place says where it came from, in 9px under
 * the image, linked to the source:
 *
 * - A photo the venue publishes itself: "Photo: <Venue> (Instagram)", linked to
 *   the post or page it came from. The source label is read from the URL.
 * - A freely licensed photo (Wikimedia Commons): author, licence and source,
 *   as the licence requires.
 *
 * Credits are stored in three places, all read through `readCredit()`:
 *
 * - featured image:  `featured_image.meta.credit`
 * - gallery item:    `{ image, credit, source_url }` (or `image.meta.credit`)
 * - body image block: `credit` on the Portable Text image block
 */
import { sanitizeHref } from "emdash";

/** Where a venue-owned photo was taken from; picks the label in brackets. */
export type PhotoSource = "website" | "instagram" | "facebook" | "google" | "tripadvisor" | "wikimedia";

/** A photo published by the place itself (or found on its Google listing). */
export interface OwnerCredit {
	kind: "owner";
	/** Who to credit: the venue's name, or for Wikimedia "Author, CC BY-SA 4.0". */
	owner: string;
	source: PhotoSource;
	/** The page the photo was taken from. */
	url?: string;
}

/** A freely licensed photo (the PR #17 shape, used for Wikimedia Commons). */
export interface LicensedCredit {
	kind: "licensed";
	author: string;
	license: string;
	licenseUrl?: string;
	sourceUrl?: string;
}

export type PhotoCredit = OwnerCredit | LicensedCredit;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A link we are willing to print: http(s) only, after EmDash's own check. */
export function safeUrl(value: unknown): string | undefined {
	const url = str(value);
	if (!url || !/^https?:\/\//i.test(url)) return undefined;
	const safe = sanitizeHref(url);
	return safe && safe !== "#" ? safe : undefined;
}

/** The source label for a credit link, from its host. Anything else is the venue's website. */
export function sourceFromUrl(url: string | undefined): PhotoSource {
	if (!url) return "website";
	let host = "";
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "website";
	}
	const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
	if (is("instagram.com")) return "instagram";
	if (is("facebook.com") || is("fb.com")) return "facebook";
	if (is("tripadvisor.com") || /(^|\.)tripadvisor\./.test(host)) return "tripadvisor";
	if (is("wikimedia.org") || is("wikipedia.org")) return "wikimedia";
	if (
		is("google.com") ||
		is("goo.gl") ||
		is("googleusercontent.com") ||
		/(^|\.)google\.[a-z.]+$/.test(host)
	)
		return "google";
	return "website";
}

const SOURCES: readonly PhotoSource[] = [
	"website",
	"instagram",
	"facebook",
	"google",
	"tripadvisor",
	"wikimedia",
];

/**
 * Normalise any stored credit value into a `PhotoCredit`, or `undefined` when
 * there is nothing to show. Accepts:
 *
 * - `{ owner, url?, source? }` (venue photo)
 * - `{ author, license, licenseUrl?, sourceUrl? }` (licensed photo)
 * - a bare string, with the link passed separately (gallery `credit` + `source_url`)
 */
export function readCredit(value: unknown, url?: unknown): PhotoCredit | undefined {
	if (typeof value === "string") {
		const owner = str(value);
		if (!owner) return undefined;
		const link = safeUrl(url);
		return { kind: "owner", owner, url: link, source: sourceFromUrl(link) };
	}
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const author = str(v.author);
	const license = str(v.license);
	if (author && license) {
		return {
			kind: "licensed",
			author,
			license,
			licenseUrl: safeUrl(v.licenseUrl),
			sourceUrl: safeUrl(v.sourceUrl),
		};
	}
	const owner = str(v.owner) ?? author;
	if (!owner) return undefined;
	const link = safeUrl(v.url ?? v.sourceUrl ?? url);
	const source = SOURCES.includes(v.source as PhotoSource)
		? (v.source as PhotoSource)
		: sourceFromUrl(link);
	return { kind: "owner", owner, url: link, source };
}

/** The credit stored on an image field value (`meta.credit`, link in `meta.creditUrl` as a fallback). */
export function imageCredit(image: unknown): PhotoCredit | undefined {
	if (!image || typeof image !== "object") return undefined;
	const meta = (image as { meta?: Record<string, unknown> }).meta;
	if (!meta) return undefined;
	return readCredit(meta.credit, meta.creditUrl);
}

/** One photo of the place's `gallery` field. */
export interface GalleryPhoto {
	image: Record<string, unknown> & { id: string };
	credit?: PhotoCredit;
}

/**
 * The `gallery` repeater as photos with credits. Tolerates a site whose schema
 * has no gallery yet (returns []) and rows with no image.
 */
export function readGallery(value: unknown): GalleryPhoto[] {
	if (!Array.isArray(value)) return [];
	const photos: GalleryPhoto[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		const image = r.image as GalleryPhoto["image"] | undefined;
		if (!image || typeof image !== "object" || typeof image.id !== "string") continue;
		photos.push({
			image,
			credit: readCredit(r.credit, r.source_url) ?? imageCredit(image),
		});
	}
	return photos;
}
