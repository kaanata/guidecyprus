import { getEmDashCollection, getSiteSettings } from "emdash";

import { localePath } from "./i18n";
import { resolveBlogSiteIdentity } from "./site-identity";

const FEED_LANGUAGE: Record<string, string> = { en: "en-us", tr: "tr-tr" };

/** RSS 2.0 feed of a locale's 20 latest posts (/rss.xml, /tr/rss.xml). */
export async function rssResponse(locale: "en" | "tr", origin: string): Promise<Response> {
	const siteUrl = origin.replace(/\/+$/, "");
	const { siteTitle, siteTagline } = resolveBlogSiteIdentity(await getSiteSettings());

	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 20,
		locale,
	});

	const items = posts
		.map((post) => {
			if (!post.data.publishedAt) return null;
			const pubDate = post.data.publishedAt.toUTCString();

			const postUrl = `${siteUrl}${localePath(locale, `/${post.id}`)}`;
			const title = escapeXml(post.data.title || "Untitled");
			const description = escapeXml(post.data.excerpt || "");

			return `    <item>
      <title>${title}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
    </item>`;
		})
		.filter(Boolean)
		.join("\n");

	const home = `${siteUrl}${localePath(locale, "/")}`;
	const self = `${siteUrl}${localePath(locale, "/rss.xml")}`;
	const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <description>${escapeXml(siteTagline)}</description>
    <link>${home}</link>
    <atom:link href="${self}" rel="self" type="application/rss+xml"/>
    <language>${FEED_LANGUAGE[locale]}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

	return new Response(rss, {
		headers: {
			"Content-Type": "application/rss+xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}

const XML_ESCAPE_PATTERNS = [
	[/&/g, "&amp;"],
	[/</g, "&lt;"],
	[/>/g, "&gt;"],
	[/"/g, "&quot;"],
	[/'/g, "&apos;"],
] as const;

function escapeXml(str: string): string {
	let result = str;
	for (const [pattern, replacement] of XML_ESCAPE_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
