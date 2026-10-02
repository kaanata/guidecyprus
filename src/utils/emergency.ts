import { getEmDashEntry } from "emdash";
import { localePath } from "./i18n";

/** Slug of the "Emergencies: what to do" page in each locale. */
export const EMERGENCY_SLUG: Record<string, string> = {
	en: "emergencies",
	tr: "acil-durumlar",
};

/**
 * Link to the emergencies page in this locale, or null while it isn't
 * published there (so links appear on their own once the page goes live).
 */
export async function emergencyHref(locale: string | undefined): Promise<string | null> {
	const slug = EMERGENCY_SLUG[locale ?? "en"];
	if (!slug) return null;
	const { entry, fallbackLocale } = await getEmDashEntry("pages", slug, { locale });
	return entry && !fallbackLocale ? localePath(locale ?? "en", `/${slug}`) : null;
}
