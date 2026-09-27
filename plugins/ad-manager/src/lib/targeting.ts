import type { Ad, PageContext } from "./types";

/** Empty lists mean "everywhere". A page with no competition never matches a competition list. */
export function matchesPage(ad: { targeting: Ad["targeting"] }, page: PageContext): boolean {
  const { pageTypes, competitions } = ad.targeting;
  if (pageTypes.length > 0 && !pageTypes.includes(page.type)) return false;
  if (competitions.length > 0 && (!page.competition || !competitions.includes(page.competition))) return false;
  return true;
}

/** Empty or missing list means every country. An unknown visitor country never matches a country list. */
export function matchesCountry(ad: { targeting: Ad["targeting"] }, country: string | null): boolean {
  const countries = ad.targeting.countries ?? [];
  return countries.length === 0 || (country !== null && countries.includes(country));
}

/** Cloudflare reports "XX" when it can't tell and "T1" for Tor; both count as unknown. */
export function visitorCountry(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1" ? code : null;
}
