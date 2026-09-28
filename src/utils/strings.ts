/**
 * The theme's own UI strings, per site locale. Content (titles, menus, pages)
 * comes translated from EmDash; this covers the labels the templates print.
 *
 * `en` defines the keys; `tr` must supply every one of them, so a missing
 * translation is a type error. Placeholders are `{name}`, filled from `params`.
 * Counted strings come in `_one` / `_other` pairs, picked with Intl.PluralRules.
 */

export type Locale = "en" | "tr";

const en = {
	// Header
	"header.searchPlaceholder": "Search...",
	"header.searchLoading": "Searching...",
	"header.searchNoResults": "No results found",
	"header.admin": "Admin",

	// Footer
	"footer.navigate": "Navigate",
	"footer.home": "Home",
	"footer.connect": "Connect",
	"footer.rss": "RSS Feed",
	/** `{link}` is replaced by the EmDash link. */
	"footer.poweredBy": "Powered by {link}",
	"theme.light": "Light mode",
	"theme.dark": "Dark mode",
	"theme.system": "System theme",

	// Ads
	"ad.label": "Advertisement",

	// 404
	"notFound.title": "Page not found",
	"notFound.message": "The page you're looking for doesn't exist.",
	"notFound.home": "Go back home",

	// Search page
	"search.title": "Search",
	"search.titleWithQuery": "Search: {query}",
	"search.description": "Search blog posts",
	"search.placeholder": "Search posts...",
	"search.button": "Search",
	"search.hint": "Enter a search term to find posts.",
	"search.noResults": 'No results for "{query}"',
	"search.results_one": '{n} result for "{query}"',
	"search.results_other": '{n} results for "{query}"',
	"search.untitled": "Untitled",

	// Posts index
	"posts.title": "All Posts",
	"posts.description": "Browse all blog posts",
	"posts.empty": "No posts yet.",
	"posts.count_one": "{n} article",
	"posts.count_other": "{n} articles",

	// Category and tag archives
	"archive.title": "{label} Archives",
	"archive.category": "Category",
	"archive.tag": "Tag",
	"archive.categoryDescription": "All posts in {label}",
	"archive.tagDescription": "All posts tagged with {label}",
	"archive.categoryEmpty": "No posts in this category yet.",
	"archive.tagEmpty": "No posts with this tag yet.",
	"archive.count_one": "{n} post",
	"archive.count_other": "{n} posts",

	// Post
	"post.author": "Author",
	"post.authors": "Authors",
	"post.published": "Published",
	"post.readingTime": "Reading time",
	"post.tags": "Tags",
	"post.tocLabel": "Table of contents",
	"post.toc": "On this page",
	"post.continueReading": "Continue reading",
	"readingTime.short": "{n} min",
	"readingTime.long": "{n} min read",
} as const;

export type StringKey = keyof typeof en;

const tr: Record<StringKey, string> = {
	"header.searchPlaceholder": "Ara...",
	"header.searchLoading": "Aranıyor...",
	"header.searchNoResults": "Sonuç bulunamadı",
	"header.admin": "Yönetim",

	"footer.navigate": "Gezin",
	"footer.home": "Ana Sayfa",
	"footer.connect": "Bağlantılar",
	"footer.rss": "RSS Beslemesi",
	"footer.poweredBy": "{link} ile güçlendirilmiştir",
	"theme.light": "Açık tema",
	"theme.dark": "Koyu tema",
	"theme.system": "Sistem teması",

	"ad.label": "Reklam",

	"notFound.title": "Sayfa bulunamadı",
	"notFound.message": "Aradığınız sayfa mevcut değil.",
	"notFound.home": "Ana sayfaya dön",

	"search.title": "Ara",
	"search.titleWithQuery": "Arama: {query}",
	"search.description": "Blog yazılarında arayın",
	"search.placeholder": "Yazılarda ara...",
	"search.button": "Ara",
	"search.hint": "Yazı bulmak için bir arama terimi girin.",
	"search.noResults": '"{query}" için sonuç bulunamadı',
	"search.results_one": '"{query}" için {n} sonuç',
	"search.results_other": '"{query}" için {n} sonuç',
	"search.untitled": "Başlıksız",

	"posts.title": "Tüm Yazılar",
	"posts.description": "Tüm blog yazılarına göz atın",
	"posts.empty": "Henüz yazı yok.",
	"posts.count_one": "{n} yazı",
	"posts.count_other": "{n} yazı",

	"archive.title": "{label} Arşivi",
	"archive.category": "Kategori",
	"archive.tag": "Etiket",
	"archive.categoryDescription": "{label} kategorisindeki tüm yazılar",
	"archive.tagDescription": "{label} etiketli tüm yazılar",
	"archive.categoryEmpty": "Bu kategoride henüz yazı yok.",
	"archive.tagEmpty": "Bu etiketle henüz yazı yok.",
	"archive.count_one": "{n} yazı",
	"archive.count_other": "{n} yazı",

	"post.author": "Yazar",
	"post.authors": "Yazarlar",
	"post.published": "Yayınlanma",
	"post.readingTime": "Okuma süresi",
	"post.tags": "Etiketler",
	"post.tocLabel": "İçindekiler",
	"post.toc": "Bu sayfada",
	"post.continueReading": "Okumaya devam et",
	"readingTime.short": "{n} dk",
	"readingTime.long": "{n} dk okuma",
};

const STRINGS: Record<Locale, Record<StringKey, string>> = { en, tr };

/** BCP 47 tags for date and number formatting (the theme has always used en-US). */
const INTL_LOCALES: Record<Locale, string> = { en: "en-US", tr: "tr-TR" };

/** Narrow `Astro.currentLocale` to a supported locale; anything else is English. */
export function toLocale(locale: string | undefined | null): Locale {
	return locale === "tr" ? "tr" : "en";
}

type Params = Record<string, string | number>;

/** The string for `key` in `locale`, with `{name}` placeholders filled from `params`. */
export function t(locale: string | undefined | null, key: StringKey, params?: Params): string {
	const template = STRINGS[toLocale(locale)][key];
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** Keys that come as a `_one` / `_other` pair, named without the suffix. */
type PluralBase = {
	[K in StringKey]: K extends `${infer Base}_one`
		? `${Base}_other` extends StringKey
			? Base
			: never
		: never;
}[StringKey];

/** A counted string: picks `<base>_one` or `<base>_other` for `n`, which fills `{n}`. */
export function tn(
	locale: string | undefined | null,
	base: PluralBase,
	n: number,
	params?: Params,
): string {
	const lang = toLocale(locale);
	const form = new Intl.PluralRules(INTL_LOCALES[lang]).select(n) === "one" ? "one" : "other";
	return t(lang, `${base}_${form}`, { ...params, n });
}

/** A date in the locale's format, e.g. "March 4, 2025" / "4 Mart 2025". */
export function formatDate(
	locale: string | undefined | null,
	date: Date,
	month: "long" | "short" = "long",
): string {
	return date.toLocaleDateString(INTL_LOCALES[toLocale(locale)], {
		year: "numeric",
		month,
		day: "numeric",
	});
}
