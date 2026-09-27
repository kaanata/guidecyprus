# guidecyprus.com → EmDash CMS Migration Plan

**Target repo:** https://github.com/kaanata/guidecyprus
**Stack:** this repo is the site: an Astro project on the `emdash@0.40.1` package, deployed to Cloudflare Workers. EmDash source: https://github.com/emdash-cms/emdash
**Source:** guidecyprus.com — WordPress, public REST at `/wp-json/wp/v2`, 94 posts, Yoast SEO 27.5, multilingual (`/tr/` observed), JWT auth header detected.

Upstream reference docs (in `emdash-cms/emdash`): `docs/src/content/docs/migration/from-wordpress.mdx`, `docs/src/content/docs/migration/content-import.mdx`, `docs/src/content/docs/guides/internationalization.mdx`.

---

## 1. Source inventory (what we know)

| Item | Status | How we know |
|---|---|---|
| WP REST endpoint | ✅ `/wp-json/wp/v2` open, returns 200 | `curl https://guidecyprus.com/wp-json/wp/v2/posts?per_page=1` |
| Post count | ✅ 161 published posts: 94 `en` + 67 `tr`. REST shows only the 94 `en`. | WPML translation table |
| SEO plugin | ✅ Yoast SEO v27.5 (meta present in `yoast_head` of REST response) | REST |
| Multilingual | ✅ **WPML**. Locales `en` (default, unprefixed at `/`) and `tr` (at `/tr/`); `x-default` → `/` | `wpml/v1` namespaces in `/wp-json/`, `hreflang` links on the home page |
| JWT auth | ✅ `access-control-expose-headers: X-JWT-Refresh` present | REST headers |
| Pages | ✅ 7 published + 1 draft: 2 `en` + 6 `tr` | database |
| Custom post types | ❓ unknown | needs fetch `/wp/v2/types` |
| Custom fields (ACF) | ⚠️ ACF + ACFML active; field usage not yet checked | plugin list |
| Comments | ✅ 0 approved comments; nothing to migrate | database |
| Users/roles | ✅ 2 users | database |
| Custom theme assets | ❓ non-public (CSS/JS/images) unknown | needs FTP/SSH |
| Current edge | ✅ Domain already proxied through Cloudflare (`server: cloudflare`) | response headers |
| Backup | ✅ Database dump + full site directory archive, taken 2026-09-25, stored on the origin server | — |
| WXR | ✅ Full export (949 items, plugins skipped so all languages are included), stored next to the backup | WP-CLI |

**Import source: WXR** (`wp export`, or Tools → Export → All content). It covers posts, pages, custom post types, taxonomy terms, reusable blocks, authors and attachment URLs, but not Yoast values, menus or arbitrary custom meta. The docs also describe an EmDash Exporter plugin that imports those extras; the public release (`emdash-cms/wp-emdash` 1.0.0) lacks them and sends no WPML data, so this migration doesn't use it (§7).

The public REST API alone can't be imported. Entering the site URL without the exporter only runs a probe that detects and counts content.

Take a backup either way: MySQL dump + `wp-content/uploads`.

---

## 2. Target architecture (EmDash v0.40.1)

- **Site:** An Astro project with the `emdash` integration. The monorepo itself uses pnpm workspaces; the guidecyprus site will be one project scaffolded from a template (§6).
- **Content storage:** In the database, not in files. Collection schemas live in `_emdash_collections` / `_emdash_fields`, and each collection gets a real SQL table (`ec_posts`, `ec_pages`, …). Editors work in the admin at `/_emdash/admin`.
- **Rich text:** Portable Text (JSON), stored in the entry's `content` field. Gutenberg and Classic HTML are converted by `@emdash-cms/gutenberg-to-portable-text` during import.
- **Database / media by hosting target:**
  - Node: SQLite (`sqlite({ url: "file:./data.db" })`), media on local disk or S3-compatible storage. `Dockerfile` / `compose.yaml` at the repo root are for EmDash development; the site will need its own.
  - Cloudflare: D1 + R2 (`templates/*-cloudflare`).
- **Content i18n:** Row-per-locale (migration `019_i18n`, plus `036` for menus/taxonomies, `040` for bylines). Each translation is its own entry with its own slug, status and revisions, linked through a shared `translation_group`. Locales come from Astro's `i18n` config block. See §4.
- **Admin UI i18n:** `lingui.config.ts`, `lunaria.config.ts` and `i18n/` translate the **admin interface**, not site content. They play no part in this migration.
- **SEO:** Built-in SEO storage (migration `018_seo`). The exporter maps Yoast values into it.
- **Redirects:** Built-in redirect store (migration `029_redirects`, API at `/_emdash/api/redirects`). The 301 map from §6 goes here, not in a separate server config.
- **Comments:** Built-in (`/_emdash/api/comments`). The exporter imports WordPress comments.

### Key files in the EmDash source (`emdash-cms/emdash`)

| Path | Purpose |
|---|---|
| `packages/core/src/import/sources/wordpress-plugin.ts` | EmDash Exporter import source (plugin path) |
| `packages/core/src/import/sources/wxr.ts` | WXR import source |
| `packages/core/src/cli/wxr/parser.ts` | Streaming WXR parser; reads WPML/Polylang locale and translation group |
| `packages/core/src/cli/commands/import/wordpress.ts` | CLI importer that writes converted JSON to disk (not used in this plan) |
| `packages/gutenberg-to-portable-text/` | Gutenberg block → Portable Text converter |
| `packages/admin/src/components/WordPressImport.tsx` | Admin UI for the importer |
| `templates/blog/` (Node), `templates/blog-cloudflare/` (CF) | Starter templates |

---

## 3. Content mapping plan (WP → EmDash)

Run the import from the admin (**Import WordPress**, `/_emdash/admin/import/wordpress`). It requires the `import:execute` permission. The flow:

1. Analyze the source.
2. Confirm the post type → collection mapping.
3. Map authors.
4. Choose exporter extras (menus, site identity, SEO).
5. Import.
6. Run the media step.

| WP concept | EmDash target | Notes |
|---|---|---|
| `post` | `posts` collection | default mapping; the blog template's `posts` collection is reused if field types match |
| `page` | `pages` collection | same |
| Custom post types | collection with a sanitized slug, or skipped | chosen per post type in the analysis step |
| Categories / tags | `category` / `tag` taxonomies | custom taxonomies: created by the exporter; skipped on WXR unless a matching definition exists |
| Yoast title, description, OG | built-in SEO fields | **exporter only**, enable the SEO switch |
| Featured image (`_thumbnail_id`) | `featured_image` field + media library | bytes downloaded in the media step |
| Inline media | media library, content URLs rewritten | source site must stay reachable during the media step; deduplicated by SHA-1 of the bytes |
| Body (Gutenberg / Classic HTML) | Portable Text `content` field | inspect embeds, shortcodes and page-builder blocks afterwards |
| Reusable blocks (`wp_block`) | Sections | not a regular collection |
| WP slugs | entry slug, unchanged | uniqueness is per `(slug, locale)` |
| Statuses | `publish` → `published`; everything else → `draft` | scheduled posts come in as drafts; review them before publishing |
| WP authors | owner (if mapped to an EmDash user) or guest byline | no login needed for guest bylines |
| Comments | built-in comments | exporter only |
| Menus | built-in menus | exporter only |
| ACF / custom meta | matching EmDash fields | exporter only, and only where the target field exists |

**Slug preservation is the single most important part of the cutover.** The importer keeps WP slugs. Route patterns are up to the site: the Astro routes must reproduce guidecyprus.com's permalink structure (e.g. `/%postname%/` vs `/blog/%postname%/`). Otherwise, add redirects for each changed pattern.

Retries skip existing entries by collection + slug + locale. If a slug changed between attempts, a rerun creates a duplicate.

---

## 4. i18n plan

EmDash stores translations as separate entries, one row per locale, grouped by `translation_group`. That fits a tourism guide with parallel TR/EN content:

- A Turkish-only post simply has no English sibling, and vice versa.
- Translations have independent slugs (`/cyprus-beaches` and `/tr/kibris-plajlari`), statuses and revisions.
- Hreflang alternates come from `getHreflangAlternates()`.

**Config.** Add Astro's `i18n` block to `astro.config.mjs`. EmDash reads the locale list, default and fallback from it:

```js
i18n: {
	defaultLocale: "en",
	locales: ["en", "tr"],
	fallback: { tr: "en" },
	// no `routing` block — keeps the default `prefix-other-locales`
},
```

The default locale must not be prefixed. `prefixDefaultLocale: true` and `routing: "prefix-always"` make `/_emdash/admin` return 404. guidecyprus.com's current shape (English at `/`, Turkish at `/tr/`) fits the default strategy. If the live site actually prefixes English, handle `/en/…` with redirects instead.

**Import.** The WXR parser reads WPML (`_icl_lang_code` + `trid`) and Polylang (`_locale` / `language` taxonomy + `_translations`), and passes the locale and translation group per post to the importer. The exporter source also detects the multilingual plugin.

⚠️ Upstream's `guides/internationalization.mdx` says a WXR import lands everything in the default locale, which contradicts the parser code above. Before the full run, confirm with a trial import of a few posts that TR entries arrive with `locale = tr` and linked to their EN siblings.

**Decided:** guidecyprus.com runs WPML with `en` as the unprefixed default and `tr` under `/tr/`. That matches the config above and EmDash's default routing, and the importer reads WPML's `_icl_lang_code` and `trid`.

---

## 5. Auth & user migration

guidecyprus.com exposes a JWT auth header (`X-JWT-Refresh`), suggesting the JWT Authentication plugin. That plugin has no role after migration. EmDash uses passkey-based auth (`packages/auth`).

Passwords are never migrated. The import maps each WP author either to an existing EmDash user (who becomes the entry owner) or to a guest byline, which preserves author credit without granting a login. For a site with 1–5 editors:

1. Create the EmDash accounts first.
2. Map those authors to them during import.
3. Let every other author become a guest byline.

Open question: how many active WP users/editors on guidecyprus.com?

---

## 6. DNS / cutover plan

### Phase 1 — Preview (done locally 2026-09-26)

This repo, EmDash 0.40.1 on `blog-cloudflare`.

1. Scaffold: `pnpm create emdash@latest guidecyprus-site --template cloudflare:blog --pm pnpm --no-sandboxed-plugins --install --yes`, then upgrade to `emdash@0.40.1`.
2. Add the `i18n` block from §4.
3. Port routes to the WP URL structure:
   - `/%postname%/` for posts and pages, with `/tr/` for Turkish.
   - `/category/parent/child/` and `/tag/<slug>/`.
   - Static front pages at `/` and `/tr/`; their old slugs 301 there.
4. Export the WXR with plugins skipped, then add `_icl_lang_code` and `trid` postmeta per item from WPML's `icl_translations` (§7).
5. Import through the admin API, in order: analyze → prepare (adds `pages.excerpt`) → execute → media (unique URLs only) → rewrite-urls.
6. Run the post-import SQL from the site repo:
   - `scripts/fix-wxr-taxonomies.py` restores decoded term labels in every locale and the category parents.
   - `scripts/import-yoast-seo.py` copies Yoast titles and descriptions into `_emdash_seo`.
7. Delete the template's sample posts and "About" page. Set the site title to "Guide Cyprus" and the tagline.

Result:
- 94 `en` + 65 `tr` posts and 8 pages.
- 391 media files, with 365 content URLs rewritten.
- 23 categories and 128 tags.
- 50 Yoast descriptions and 3 custom titles.
- The 2 WPML-linked page pairs share translation groups. WPML didn't link the posts, so they stay independent.
- One `tr` draft with an empty slug was skipped; its published version imported.

Known gaps:
- The English homepage title gets a " - Guide Cyprus" suffix that the live site doesn't show.
- One post still links to an origin image, probably a resized variant.
- Menus aren't imported, because WXR doesn't carry them.

### Phase 2 — Parallel run (≈ 2–5 days)

- Create the D1 database and R2 bucket, then `wrangler deploy` to a `*.workers.dev` URL for staging.
- Crawl or sample old public URLs and check each has an equivalent on staging: 200 OK, correct content, correct image. Enter a 301 in EmDash's redirects for every URL without a 1:1 match.
- Confirm SEO meta (titles, descriptions, OG) and hreflang per post.
- Confirm drafts aren't reachable when logged out.
- Run a Lighthouse audit on staging and compare it against guidecyprus.com's current score.

### Phase 3 — Cutover (≈ 30 minutes, then 30 days of monitoring)

- Point `legacy.guidecyprus.com` at the WordPress origin and keep it online for 30 days, so content can be compared or re-imported.
- Attach the Worker to `guidecyprus.com` as a custom domain. The zone is already on Cloudflare, so there is no nameserver change or TTL wait.
- Watch 404 logs daily. Add redirects as gaps appear.
- After 30 days with no significant traffic on legacy, retire WP. Keep the backup.

---

## 7. Decisions

Criteria: free to run and simplest to operate.

| Question | Decision | Why |
|---|---|---|
| Template | `blog-cloudflare` | Posts, pages, categories, tags and menus match the WP site |
| Hosting | Cloudflare Workers free plan + D1 + R2 | The domain is already on Cloudflare, so cutover is a route change rather than a DNS move. The free tiers cover a 94-post site. Sandboxed plugins need Workers Paid, so leave them disabled at scaffold time. R2 may ask for a payment method on the account even when usage stays within the free tier. |
| Import source | WXR + WPML language data | The public EmDash Exporter (`emdash-cms/wp-emdash` 1.0.0) predates the core importer. It has no migration-key wizard and sends no WPML locale/translation group, comments or menus, so TR/EN links would be lost. WPML keeps languages in its `icl_translations` table, not postmeta, so a stock WXR carries none either. Add `_icl_lang_code` and `trid` postmeta to each WXR item from that table; the WXR parser reads both. Yoast values need a separate step. |
| i18n | WPML → row-per-locale, `en` default, `tr` prefixed | Matches current URLs, so no locale redirects are needed |
| Editors | Create EmDash accounts for active editors; other authors become guest bylines | No password migration exists |
| Comments | None to import | The site has 0 approved comments |

## 8. Open questions for the human

1. **Credentials.** Rotate the origin root password, and switch to SSH key auth.
2. **Editors.** Who needs a login on the new site?
3. **Cloudflare account.** Which account holds the guidecyprus.com zone? `wrangler login` must use it.

---

## 9. Rough effort estimate

| Phase | Hours | Notes |
|---|---|---|
| 1 — Preview | 8–12 | scaffold + i18n/routes (3h), exporter setup + analysis (1h), trial + full import (2h), content QA and fix-ups (4h) |
| 2 — Parallel | 6–10 | deploy (2h), URL audit and redirects (3h), SEO/visual QA (3h) |
| 3 — Cutover | 2 + 30 days passive | DNS flip (0.5h), monitoring (30 days, ~10 min/day) |
| Extras | +4–16 | ACF field modelling or theme porting beyond the blog template |

Total active work: **~20–40 hours** over 2–3 weeks of calendar time.

---

## 10. Next commands

```bash
pnpm wrangler login                      # account that holds the guidecyprus.com zone
pnpm wrangler d1 create guidecyprus      # put the database_id in wrangler.jsonc
pnpm wrangler r2 bucket create guidecyprus-media
pnpm run deploy                          # → *.workers.dev staging URL
```

Then rerun the §6 Phase 1 import steps against the deployed site. The post-import SQL runs with `wrangler d1 execute guidecyprus --remote --file …`.

Staging runs with `EMDASH_SITE_URL` set to the `workers.dev` URL (a `vars` entry in `wrangler.jsonc`). Passkeys are bound to that hostname. Before cutover, give the admin a second way to sign in: a magic link with an email provider configured, or a GitHub/Google login. Then switch `EMDASH_SITE_URL` to `https://guidecyprus.com` and register a new passkey there.

## 11. Blockers

- **Cloudflare account access** for `wrangler login` (§8, question 3).
- **Media on R2:** the media step fetches from the WordPress origin, which must stay online.
