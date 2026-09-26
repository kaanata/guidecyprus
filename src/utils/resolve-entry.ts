import { getEmDashEntry } from "emdash";

type PostEntry = NonNullable<Awaited<ReturnType<typeof getEmDashEntry<"posts">>>["entry"]>;
type PageEntry = NonNullable<Awaited<ReturnType<typeof getEmDashEntry<"pages">>>["entry"]>;
type CacheHint = Awaited<ReturnType<typeof getEmDashEntry>>["cacheHint"];

export type ResolvedEntry =
	| { collection: "posts"; entry: PostEntry; cacheHint: CacheHint }
	| { collection: "pages"; entry: PageEntry; cacheHint: CacheHint };

/**
 * WordPress served posts and pages from the same `/%postname%/` namespace, so a
 * slug is looked up as a post first, then as a page. Locale fallback is
 * rejected: a `/tr/` URL must not render English content.
 */
export async function resolveEntry(
	slug: string,
	locale: string | undefined,
): Promise<ResolvedEntry | null> {
	const post = await getEmDashEntry("posts", slug, { locale });
	if (post.entry && !post.fallbackLocale) {
		return { collection: "posts", entry: post.entry, cacheHint: post.cacheHint };
	}
	const page = await getEmDashEntry("pages", slug, { locale });
	if (page.entry && !page.fallbackLocale) {
		return { collection: "pages", entry: page.entry, cacheHint: page.cacheHint };
	}
	return null;
}
