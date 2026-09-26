/**
 * WordPress used a static front page per language (Settings → Reading).
 * Its own slug 301-redirected to the locale home, which these routes preserve.
 */
const FRONT_PAGE_SLUGS: Record<string, string> = {
	en: "guide-cyprus",
	tr: "kibris-rehberi",
};

export function frontPageSlug(locale: string | undefined): string | undefined {
	return FRONT_PAGE_SLUGS[locale ?? "en"];
}
