# guidecyprus.com → EmDash CMS Migration Plan

**Target repo:** https://github.com/kaanata/guidecyprus
**Upstream base:** EmDash CMS v0.40.1 (commit `b4d759f5`, MIT) — "Astro-native CMS with WordPress migration support"
**Source:** guidecyprus.com — WordPress, public REST at `/wp-json/wp/v2`, 94 posts, Yoast SEO 27.5, multilingual (`/tr/` observed), JWT auth header detected.

Upstream reference docs: `docs/src/content/docs/migration/from-wordpress.mdx`, `docs/src/content/docs/migration/content-import.mdx`, `docs/src/content/docs/guides/internationalization.mdx`.

---

## 1. Source inventory (what we know)

| Item | Status | How we know |
|---|---|---|
| WP REST endpoint | ✅ `/wp-json/wp/v2` open, returns 200 | `curl https://guidecyprus.com/wp-json/wp/v2/posts?per_page=1` |
| Post count | ✅ 94 posts (`X-WP-Total: 94`) | REST header |
| SEO plugin | ✅ Yoast SEO v27.5 (meta present in `yoast_head` of REST response) | REST |
| Multilingual | ⚠️ `/tr/` path observed in canonical URL. **Locale plugin unconfirmed** — likely WPML, Polylang, or TranslatePress | REST meta |
| JWT auth | ✅ `access-control-expose-headers: X-JWT-Refresh` present | REST headers |
| Pages | ❓ count unknown — REST call to `/wp/v2/pages` not yet run | needs fetch |
| Custom post types | ❓ unknown | needs fetch `/wp/v2/types` |
| Custom fields (ACF) | ❓ unknown | needs exporter analysis or DB dump |
| Comments | ❓ enabled/disabled unknown | needs exporter analysis or DB dump |
| Users/roles | ❓ scope unknown | needs exporter analysis or DB dump |
| Custom theme assets | ❓ non-public (CSS/JS/images) unknown | needs FTP/SSH |

**Hard requirement:** WP admin access, for one of the two import sources EmDash supports:

- **EmDash Exporter plugin (recommended for this site).** Install it on WordPress, then generate a migration key under **Tools → EmDash Migration**. Beyond what WXR carries, it imports comments, menus, site title/tagline/logo/favicon, **Yoast SEO fields**, and ACF/custom meta for which a matching EmDash field exists.
- **WXR file** (Tools → Export → All content). Covers posts, pages, custom post types, taxonomy terms, reusable blocks, authors and attachment URLs. It does **not** import Yoast values, menus, comments or arbitrary custom meta. Use it only if the plugin can't be installed.

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

### Key files in this repo

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

**Import.** The WXR parser reads WPML (`_icl_lang_code` + `trid`) and Polylang (`_locale` / `language` taxonomy + `_translations`), and passes the locale and translation group per post to the importer. The exporter source also detects the multilingual plugin. TranslatePress stores translations outside posts, so neither path picks it up. If guidecyprus.com uses TranslatePress, the Turkish content has to be rebuilt as translated entries after import.

⚠️ Upstream's `guides/internationalization.mdx` says a WXR import lands everything in the default locale, which contradicts the parser code above. Before the full run, confirm with a trial import of a few posts that TR entries arrive with `locale = tr` and linked to their EN siblings.

**Decision needed before Phase 1:** which multilingual plugin guidecyprus.com runs (WPML, Polylang or TranslatePress), and which locale is the default.

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

### Phase 1 — Preview (≈ 1–2 days)

- Pick a template. **`templates/blog` is the closest match** to a WP tourism guide: `posts` + `pages` collections, categories, tags, menus. Use `templates/blog-cloudflare` if hosting on Cloudflare.
- Scaffold the site outside this monorepo: `pnpm create emdash@latest`, choose the blog template.
- Add the `i18n` block from §4. Adjust routes to match the WP permalink structure.
- Run `pnpm dev` and complete setup at `/_emdash/admin`.
- Install the EmDash Exporter on WordPress. Generate a migration key, then paste it into **Import WordPress**.
- Review the analysis: collection mapping, custom post types, author mapping. Enable menus, site identity and SEO.
- Trial-import a handful of posts in both languages and verify locales (§4). Then run the full import and the media step.
- Verify against the source:
  - Counts per post type, status and locale.
  - 50 random posts rendering correctly with images.
  - Yoast titles/descriptions.
  - Menus, categories/tags, comments.

### Phase 2 — Parallel run (≈ 2–5 days)

- Deploy to a staging host (Cloudflare Workers for the Cloudflare template, or Node + Docker on your existing infra).
- Crawl or sample old public URLs and check each has an equivalent on staging: 200 OK, correct content, correct image. Enter a 301 in EmDash's redirects for every URL without a 1:1 match.
- Confirm SEO meta (titles, descriptions, OG) and hreflang per post.
- Confirm drafts aren't reachable when logged out.
- Run a Lighthouse audit on staging and compare it against guidecyprus.com's current score.

### Phase 3 — Cutover (≈ 30 minutes, then 30 days of monitoring)

- Drop TTL on `guidecyprus.com` DNS to 300s, 24h in advance.
- Flip DNS to the new host.
- Keep WP online for 30 days at a fallback host (e.g., `legacy.guidecyprus.com`) so content can be compared or re-imported.
- Watch 404 logs daily. Add redirects as gaps appear.
- After 30 days with no significant traffic on legacy, retire WP. Keep the backup.

---

## 7. Open questions for the human

1. **Template choice.** `blog` is the default for a WP-like site. Confirm or override (`marketing`, `portfolio` exist but don't fit).
2. **Hosting target.** Cloudflare (D1 + R2) or Node + SQLite on existing infra. This decides the template variant.
3. **Multilingual plugin and default locale.** WPML, Polylang or TranslatePress? Is English or Turkish unprefixed today? See §4.
4. **Exporter plugin.** Can the EmDash Exporter be installed on guidecyprus.com? If not, can you produce a WXR export? That path loses Yoast, menus and comments.
5. **Backup.** Can you provide a `wp-content/uploads` tarball + MySQL dump?
6. **Auth scope.** How many editors need accounts on the new site?
7. **Comments.** Import them (exporter path), or disable comments on the new site?
8. **Domain TTL access.** Can you lower TTL on guidecyprus.com 24h before cutover?

---

## 8. Rough effort estimate

| Phase | Hours | Notes |
|---|---|---|
| 1 — Preview | 8–12 | scaffold + i18n/routes (3h), exporter setup + analysis (1h), trial + full import (2h), content QA and fix-ups (4h) |
| 2 — Parallel | 6–10 | deploy (2h), URL audit and redirects (3h), SEO/visual QA (3h) |
| 3 — Cutover | 2 + 30 days passive | DNS flip (0.5h), monitoring (30 days, ~10 min/day) |
| Extras | +4–16 | TranslatePress rebuild, ACF field modelling, or theme porting beyond the blog template |

Total active work: **~20–40 hours** over 2–3 weeks of calendar time.

---

## 9. Next commands (for me to run)

```bash
# 1. Monorepo dependencies (already installed; needed for reading/running upstream code)
cd /home/git-projects/guidecyprus
pnpm install --frozen-lockfile

# 2. Scaffold the site (outside the monorepo, or under a new directory)
pnpm create emdash@latest   # choose: blog (or blog-cloudflare)

# 3. In the new site: dev server, then import from the admin
pnpm dev
# open http://localhost:4321/_emdash/admin → Import WordPress
```

## 10. Blockers

None for the planning phase. Blockers for execution:

- **No import source yet.** Need the EmDash Exporter installed on guidecyprus.com, or a WXR file.
- **Multilingual plugin unknown.** Decides whether translations import automatically (WPML/Polylang) or need a rebuild (TranslatePress).
- **Hosting target not chosen.** Decides the template variant (`blog` vs `blog-cloudflare`).
