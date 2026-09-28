/**
 * Placement rules for the ad-manager plugin's spaces. Sizes live in the plugin
 * (`@main-aff/plugin-ad-manager/spaces`); this file only decides where the theme
 * puts them.
 */

/** A list gets an in-feed space after every Nth item ("every 6 cards"). */
export const IN_FEED_EVERY = 6;

/**
 * The serve route fills at most 4 slots per space on a page (the loader caps the
 * count it asks for, and the serve schema rejects more). Rendering extra slots
 * would only reserve space that is guaranteed to collapse, so lists stop there.
 */
export const IN_FEED_MAX = 4;

/** True when an in-feed space goes after the item at `index` (0-based) of `total`. */
export function inFeedAfter(index: number, total: number): boolean {
	const position = index + 1;
	return (
		position % IN_FEED_EVERY === 0 &&
		position < total && // only between items, never trailing the list
		position / IN_FEED_EVERY <= IN_FEED_MAX
	);
}

/** Paragraphs of body text before the in-article space ("after the 2nd paragraph"). */
export const IN_ARTICLE_AFTER_PARAGRAPHS = 2;

interface PortableTextBlockLike {
	_type?: string;
	style?: string;
	listItem?: string;
}

/**
 * Splits Portable Text right after the Nth plain paragraph so the in-article
 * space can sit between the two halves. Returns null (no space) when the post
 * is too short or nothing would follow the space. Splitting after a
 * non-list paragraph never cuts a list in half.
 */
export function splitForInArticle<T>(
	blocks: T[] | null | undefined,
	afterParagraphs: number = IN_ARTICLE_AFTER_PARAGRAPHS,
): [T[], T[]] | null {
	if (!Array.isArray(blocks)) return null;
	let seen = 0;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i] as PortableTextBlockLike;
		if (block?._type === "block" && (block.style ?? "normal") === "normal" && !block.listItem) {
			seen++;
			if (seen === afterParagraphs) {
				return i + 1 < blocks.length ? [blocks.slice(0, i + 1), blocks.slice(i + 1)] : null;
			}
		}
	}
	return null;
}
