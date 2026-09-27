import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { adManager } from "@main-aff/plugin-ad-manager";
import { aiWriter } from "@main-aff/plugin-ai-writer";
import { cloudflareEmail } from "@main-aff/plugin-cloudflare-email";
import { emailPassword } from "@main-aff/plugin-email-password";
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
			],
			authProviders: [emailPassword()],
			sandboxed: [webhookNotifier],
			sandboxRunner: sandbox(),
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
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
