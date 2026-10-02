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
	"header.searchPlaceholder": "Search places",
	"header.searchLoading": "Searching...",
	"header.searchNoResults": "No results found",
	"header.admin": "Admin",

	// Footer
	"footer.navigate": "Navigate",
	"footer.home": "Home",
	"footer.connect": "Connect",
	"footer.rss": "RSS Feed",
	"footer.emergency": "Emergencies",
	/** `{link}` is replaced by the EmDash link. */
	"footer.poweredBy": "Powered by {link}",
	"theme.light": "Light mode",
	"theme.dark": "Dark mode",
	"theme.system": "System theme",

	// Ads
	"ad.label": "Advertisement",

	// 404
	"notFound.title": "Page not found",
	"notFound.message": "The page you're looking for doesn't exist. It may have moved when the guide was rebuilt.",
	"notFound.home": "Go back home",

	// Search page
	"search.titleWithQuery": "Search: {query}",
	"search.button": "Search",
	"search.untitled": "Untitled",

	// Post
	"post.tocLabel": "Table of contents",
	"post.toc": "On this page",
	"readingTime.short": "{n} min",
	"readingTime.long": "{n} min read",
	// --- SHELL (header, footer, 404) -- redesign block ---
	"header.nav": "Main",
	"footer.theme": "Colour theme",
	"notFound.searchLabel": "Search for a place instead",
	"notFound.searchPlaceholder": "e.g. Bellapais, beach, hotel",
	"notFound.code": "Error 404",
	// --- end SHELL ---
	// --- LISTINGS (archive views, search) -- redesign block ---
	"listing.allPlaces": "All places",
	"listing.allDescription": "Every place in the guide to Cyprus: historical sites, hotels, restaurants, bars and everyday services.",
	"listing.place_one": "{n} place",
	"listing.place_other": "{n} places",
	"listing.byKind": "Browse by kind",
	"listing.breadcrumb": "You are here",
	"listing.home": "Home",
	"listing.categoryTitle": "{label} in Cyprus",
	"listing.categoryDescription": "Places in Cyprus listed under {label}, with photos, addresses and phone numbers.",
	"listing.tagTitle": "Places tagged {label}",
	"listing.tagDescription": "Places in Cyprus tagged {label}.",
	"listing.tagLead": "Places tagged",
	"listing.categoryEmpty": "Nothing is listed under {label} yet.",
	"listing.tagEmpty": "No places carry this tag yet.",
	"listing.emptyAll": "Browse all places",
	"listing.emptySearch": "Search the guide",
	"listing.empty": "No places are listed yet.",
	"listing.searchTitle": "Search the guide",
	"listing.searchLabel": "Place name, town or kind",
	"listing.searchPlaceholder": "Bellapais, Kyrenia, hotels...",
	"listing.searchHint": "Search by a place's name, the town it is in, or what it is, like beach or casino.",
	"listing.searchNone": "No places match “{query}”. Try a place name or a kind, like hotels.",
	"listing.searchCount_one": "{n} place matches “{query}”",
	"listing.searchCount_other": "{n} places match “{query}”",
	"listing.searchDescription": "Search places in Cyprus by name, town or kind.",
	// --- end LISTINGS ---
	// --- HOME (home page, island map, CMS pages) -- redesign block ---
	"home.title": "Cyprus, place by place",
	"home.intro":
		"Historical sites, hotels, restaurants, beaches and nightlife across the island, each with a photo and what you need to find it.",
	"home.searchLabel": "Find a place",
	"home.searchPlaceholder": "e.g. Bellapais, casino",
	"home.searchButton": "Search",
	"home.mapAlt": "Map of Cyprus with the guide's towns marked",
	"home.browseTitle": "Browse by kind",
	"home.browseCount_one": "{n} place",
	"home.browseCount_other": "{n} places",
	"home.recentTitle": "Recently added",
	"home.recentAll": "See all places",
	"home.aboutLabel": "About the island",
	// --- end HOME ---
	// --- PLACE (place detail, place cards) -- redesign block ---
	"place.breadcrumb": "Breadcrumb",
	"place.places": "Places",
	"place.kind": "Kind",
	"place.added": "Added",
	"place.tags": "Tags",
	"place.moreKind": "More {label}",
	"place.more": "More places",
	"place.moreAll": "See all {label}",
	/** Photo credit under a place photo. `{author}`, `{license}` and `{source}` are filled in by the template. */
	"place.photoCredit": "Photo: {author}, {license}, via {source}",
	// --- end PLACE ---
	// --- REGION (the "Visiting" switch, region filter, place-page note) ---
	/** Label for the group of region links. */
	"region.switchLabel": "Visiting",
	"region.all": "Whole island",
	"region.trnc": "TRNC (KKTC)",
	"region.south": "South Cyprus",
	/** "in <region>", slotted into `{in}` below. */
	"region.inTrnc": "in the TRNC (KKTC)",
	"region.inSouth": "in South Cyprus",
	"region.count_one": "{n} place {in}",
	"region.count_other": "{n} places {in}",
	"region.empty": "No places {in} yet.",
	"region.emptyCategory": "Nothing is listed under {label} {in} yet.",
	"region.emptyTag": "No places {in} carry this tag yet.",
	"region.emptyWhole": "See the whole island",
	/** Place page facts column. */
	"region.label": "Region",
	"region.noteTrnc":
		"Prices are in Turkish lira; euros and pounds are widely taken in tourist areas. Cross to South Cyprus at an official crossing point with a passport or ID card.",
	"region.noteSouth":
		"Prices are in euros. Cross to the TRNC (KKTC) at an official crossing point with a passport or ID card.",
	/** Link after the note to the emergencies page, once it is published. */
	"region.emergencyLink": "What to do in an emergency",
	// --- end REGION ---
	// --- TOWN (island map markers, ?town= filter, place-page town row) ---
	/** Fallback town names; the `town` taxonomy's term labels are used when present. */
	"town.kyrenia": "Kyrenia",
	"town.nicosia": "Nicosia",
	"town.famagusta": "Famagusta",
	"town.iskele": "İskele",
	"town.karpaz": "Karpaz",
	"town.guzelyurt": "Güzelyurt",
	"town.limassol": "Limassol",
	"town.paphos": "Paphos",
	"town.larnaca": "Larnaca",
	"town.ayiaNapa": "Ayia Napa",
	"town.troodos": "Troodos",
	/** Accessible name of a map marker: "Kyrenia, 120 places". */
	"town.marker_one": "{town}, {n} place",
	"town.marker_other": "{town}, {n} places",
	/** Listing title with a town chosen. `{town}` is the name (tr: with -deki/-daki). */
	"town.title": "Places in {town}",
	/** `{town}` is the name (tr: with -de/-da). */
	"town.empty": "No places in {town} yet.",
	"town.clear": "Show all towns",
	/** Place page facts column. */
	"town.label": "Town",
	// --- end TOWN ---
	// --- ILLUSTRATION (AI-generated drawings: kind tiles for places without a photo, town banners) ---
	/** Caption under an illustration shown as content (place page tile), in the 9px credit style. */
	"illustration.caption": "Illustration",
	/** Alt text of the kind illustration where it stands in for the place's photo. */
	"illustration.restaurant": "Illustration of a restaurant",
	"illustration.hotel": "Illustration of a hotel",
	"illustration.cafe": "Illustration of a coffee shop",
	"illustration.bar": "Illustration of a bar",
	"illustration.beach": "Illustration of a beach",
	"illustration.historical": "Illustration of a historical site",
	"illustration.casino": "Illustration of a casino",
	"illustration.club": "Illustration of a nightclub",
	"illustration.entertainment": "Illustration of an entertainment venue",
	"illustration.services": "Illustration of a local service",
	"illustration.place": "Illustration of a place",
	/** Alt text and caption of the town banner on the listing. `{town}` is the name. */
	"illustration.town": "Illustration of {town}",
	// --- end ILLUSTRATION ---
} as const;

export type StringKey = keyof typeof en;

const tr: Record<StringKey, string> = {
	"header.searchPlaceholder": "Yer ara",
	"header.searchLoading": "Aranıyor...",
	"header.searchNoResults": "Sonuç bulunamadı",
	"header.admin": "Yönetim",

	"footer.navigate": "Gezin",
	"footer.home": "Ana Sayfa",
	"footer.connect": "Bağlantılar",
	"footer.rss": "RSS Beslemesi",
	"footer.emergency": "Acil durumlar",
	"footer.poweredBy": "{link} altyapısıyla çalışır",
	"theme.light": "Açık tema",
	"theme.dark": "Koyu tema",
	"theme.system": "Sistem teması",

	"ad.label": "Reklam",

	"notFound.title": "Sayfa bulunamadı",
	"notFound.message": "Aradığınız sayfa mevcut değil. Rehber yenilenirken taşınmış olabilir.",
	"notFound.home": "Ana sayfaya dön",

	"search.titleWithQuery": "Arama: {query}",
	"search.button": "Ara",
	"search.untitled": "Başlıksız",



	"post.tocLabel": "İçindekiler",
	"post.toc": "Bu sayfada",
	"readingTime.short": "{n} dk",
	"readingTime.long": "{n} dk okuma",
	// --- SHELL (header, footer, 404) -- redesign block ---
	"header.nav": "Ana menü",
	"footer.theme": "Renk teması",
	"notFound.searchLabel": "Bunun yerine bir yer arayın",
	"notFound.searchPlaceholder": "Örn. Bellapais, plaj, otel",
	"notFound.code": "Hata 404",
	// --- end SHELL ---
	// --- LISTINGS (archive views, search) -- redesign block ---
	"listing.allPlaces": "Tüm yerler",
	"listing.allDescription": "Kıbrıs rehberindeki tüm yerler: tarihi mekânlar, oteller, restoranlar, barlar ve günlük hizmetler.",
	"listing.place_one": "{n} yer",
	"listing.place_other": "{n} yer",
	"listing.byKind": "Türüne göre göz atın",
	"listing.breadcrumb": "Buradasınız",
	"listing.home": "Ana sayfa",
	"listing.categoryTitle": "Kıbrıs'ta {label}",
	"listing.categoryDescription": "Kıbrıs'ta {label} başlığındaki yerler; fotoğraf, adres ve telefon bilgileriyle.",
	"listing.tagTitle": "{label} etiketli yerler",
	"listing.tagDescription": "Kıbrıs'ta {label} etiketli yerler.",
	"listing.tagLead": "Etiketli yerler",
	"listing.categoryEmpty": "{label} başlığında henüz bir yer yok.",
	"listing.tagEmpty": "Bu etiketi taşıyan bir yer henüz yok.",
	"listing.emptyAll": "Tüm yerlere göz atın",
	"listing.emptySearch": "Rehberde arayın",
	"listing.empty": "Henüz listelenmiş bir yer yok.",
	"listing.searchTitle": "Rehberde arayın",
	"listing.searchLabel": "Yer adı, kasaba ya da tür",
	"listing.searchPlaceholder": "Bellapais, Girne, oteller...",
	"listing.searchHint": "Bir yerin adıyla, bulunduğu kasabayla ya da ne olduğuyla arayın; örneğin plaj veya kumarhane.",
	"listing.searchNone": "“{query}” ile eşleşen bir yer yok. Bir yer adı ya da tür deneyin, örneğin oteller.",
	"listing.searchCount_one": "“{query}” ile eşleşen {n} yer",
	"listing.searchCount_other": "“{query}” ile eşleşen {n} yer",
	"listing.searchDescription": "Kıbrıs'taki yerleri ada, kasabaya ya da türe göre arayın.",
	// --- end LISTINGS ---
	// --- HOME (home page, island map, CMS pages) -- redesign block ---
	"home.title": "Kıbrıs, adım adım",
	"home.intro":
		"Adanın dört bir yanındaki tarihi yerler, oteller, restoranlar, plajlar ve gece hayatı; her biri fotoğrafı ve nasıl bulacağınızla birlikte.",
	"home.searchLabel": "Bir yer bulun",
	"home.searchPlaceholder": "Örn. Bellapais, kumarhane",
	"home.searchButton": "Ara",
	"home.mapAlt": "Rehberdeki şehirlerin işaretli olduğu Kıbrıs haritası",
	"home.browseTitle": "Türüne göre göz atın",
	"home.browseCount_one": "{n} yer",
	"home.browseCount_other": "{n} yer",
	"home.recentTitle": "Yeni eklenenler",
	"home.recentAll": "Tüm yerleri görün",
	"home.aboutLabel": "Ada hakkında",
	// --- end HOME ---
	// --- PLACE (place detail, place cards) -- redesign block ---
	"place.breadcrumb": "Sayfa yolu",
	"place.places": "Yerler",
	"place.kind": "Tür",
	"place.added": "Eklenme tarihi",
	"place.tags": "Etiketler",
	"place.moreKind": "Diğer {label}",
	"place.more": "Başka yerler",
	"place.moreAll": "{label}: tümünü görün",
	"place.photoCredit": "Fotoğraf: {author}, {license}, {source} aracılığıyla",
	// --- end PLACE ---
	// --- REGION (the "Visiting" switch, region filter, place-page note) ---
	"region.switchLabel": "Gezi bölgesi",
	"region.all": "Tüm ada",
	"region.trnc": "KKTC",
	"region.south": "Güney Kıbrıs",
	"region.inTrnc": "KKTC'de",
	"region.inSouth": "Güney Kıbrıs'ta",
	"region.count_one": "{in} {n} yer",
	"region.count_other": "{in} {n} yer",
	"region.empty": "{in} henüz bir yer yok.",
	"region.emptyCategory": "{in} {label} başlığında henüz bir yer yok.",
	"region.emptyTag": "{in} bu etiketi taşıyan bir yer henüz yok.",
	"region.emptyWhole": "Tüm adaya bakın",
	"region.label": "Bölge",
	"region.noteTrnc":
		"Fiyatlar Türk lirasıdır; turistik bölgelerde euro ve sterlin de geçer. Güney Kıbrıs'a resmi geçiş noktalarından pasaport ya da kimlik kartıyla geçebilirsiniz.",
	"region.noteSouth":
		"Fiyatlar eurodur. KKTC'ye resmi geçiş noktalarından pasaport ya da kimlik kartıyla geçebilirsiniz.",
	"region.emergencyLink": "Acil durumda ne yapmalı",
	// --- end REGION ---
	// --- TOWN (island map markers, ?town= filter, place-page town row) ---
	"town.kyrenia": "Girne",
	"town.nicosia": "Lefkoşa",
	"town.famagusta": "Gazimağusa",
	"town.iskele": "İskele",
	"town.karpaz": "Karpaz",
	"town.guzelyurt": "Güzelyurt",
	"town.limassol": "Limasol",
	"town.paphos": "Baf",
	"town.larnaca": "Larnaka",
	"town.ayiaNapa": "Ayia Napa",
	"town.troodos": "Trodos",
	"town.marker_one": "{town}, {n} yer",
	"town.marker_other": "{town}, {n} yer",
	"town.title": "{town} yerler",
	"town.empty": "{town} henüz bir yer yok.",
	"town.clear": "Tüm şehirler",
	"town.label": "Şehir",
	// --- end TOWN ---
	// --- ILLUSTRATION (AI-generated drawings: kind tiles for places without a photo, town banners) ---
	"illustration.caption": "İllüstrasyon",
	"illustration.restaurant": "Bir restoran illüstrasyonu",
	"illustration.hotel": "Bir otel illüstrasyonu",
	"illustration.cafe": "Bir kafe illüstrasyonu",
	"illustration.bar": "Bir bar illüstrasyonu",
	"illustration.beach": "Bir plaj illüstrasyonu",
	"illustration.historical": "Bir tarihi yer illüstrasyonu",
	"illustration.casino": "Bir kumarhane illüstrasyonu",
	"illustration.club": "Bir gece kulübü illüstrasyonu",
	"illustration.entertainment": "Bir eğlence mekânı illüstrasyonu",
	"illustration.services": "Bir hizmet noktası illüstrasyonu",
	"illustration.place": "Bir yer illüstrasyonu",
	"illustration.town": "{town} illüstrasyonu",
	// --- end ILLUSTRATION ---
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
