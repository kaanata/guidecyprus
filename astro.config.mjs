import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { adManager } from "@main-aff/plugin-ad-manager";
import { aiWriter } from "@main-aff/plugin-ai-writer";
import { cloudflareEmail } from "@main-aff/plugin-cloudflare-email";
import { emailPassword, emailPasswordAccount } from "@main-aff/plugin-email-password";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "tr"],
		fallback: { tr: "en" },
	},
	image: {
		// EmDash passes media as absolute URLs on the site's own host; Astro only
		// resizes remote images from listed domains (via the IMAGES binding).
		domains: ["guidecyprus.divine-queen-9624.workers.dev", "localhost"],
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [
				formsPlugin(),
				adManager(),
				aiWriter(),
				cloudflareEmail({
					from: { email: "noreply@notify.guidecyprus.com", name: "Guide Cyprus" },
					replyTo: "info@guidecyprus.com",
				}),
				// Hosts the admin "Password" page for the email-password provider.
				emailPasswordAccount(),
				// Runs in-process like the others: sandboxed plugins would need
				// a Worker Loader binding, and the site doesn't use the sandbox.
				webhookNotifier,
			],
			authProviders: [emailPassword()],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Schibsted Grotesk",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Young Serif",
			cssVariable: "--font-display",
			weights: [400],
			subsets: ["latin", "latin-ext"],
			fallbacks: ["Georgia", "serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
