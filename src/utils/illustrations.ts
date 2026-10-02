/**
 * Illustrations: flat poster drawings in the site palette (AI-generated with
 * MiniMax), served from public/illustrations/. They stand in for a kind of
 * place or a town, never for a specific venue, and are labelled as
 * illustrations wherever they are shown as content.
 *
 * The files are static, so which ones exist is listed here; keep these lists
 * in step with the folders.
 */
import type { KindIcon } from "./kind";

/** One per kind (public/illustrations/kinds/<icon>.webp), 1200x900 (4:3). */
export const KIND_ILLUSTRATION = { width: 1200, height: 900 } as const;

export function kindIllustrationSrc(icon: KindIcon): string {
	return `/illustrations/kinds/${icon}.webp`;
}

/** Town keys (see towns.ts) with a banner in public/illustrations/towns/<key>.webp, 1600x900 (16:9). */
const TOWN_KEYS = new Set([
	"kyrenia",
	"nicosia",
	"famagusta",
	"iskele",
	"karpaz",
	"guzelyurt",
	"limassol",
	"paphos",
	"larnaca",
	"ayia-napa",
	"troodos",
]);

export const TOWN_ILLUSTRATION = { width: 1600, height: 900 } as const;

/** The town's banner, or undefined when it has none. */
export function townIllustrationSrc(key: string): string | undefined {
	return TOWN_KEYS.has(key) ? `/illustrations/towns/${key}.webp` : undefined;
}
