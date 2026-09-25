# guidecyprus.com → EmDash CMS Migration Plan

**Target repo:** https://github.com/kaanata/guidecyprus
**Upstream base:** EmDash CMS v0.40.1 (commit `b4d759f5`, MIT) — "Astro-native CMS with WordPress migration support"
**Source:** guidecyprus.com — WordPress, public REST at `/wp-json/wp/v2`, 94 posts, Yoast SEO 27.5, multilingual (`/tr/` observed), JWT auth header detected, WXR export path required.

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
| Custom fields (ACF) | ❓ unknown | needs DB dump |
| Comments | ❓ enabled/disabled unknown | needs DB dump |
| Users/roles | ❓ scope unknown | needs DB dump |
| Custom theme assets | ❓ non-public (CSS/JS/images) unknown | needs FTP/SSH |

**Hard requirement for a complete migration:** a WordPress WXR export file (XML, Tools → Export in WP admin). The EmDash importer reads WXR, not REST — REST alone cannot reconstruct Gutenberg block markup, internal IDs, or menu structure.

**Minimum WP admin access to obtain:** Tools → Export → "All content" → download `.wxr` file. Optionally also a DB dump (`wp-content/` + MySQL dump) for full fidelity (menus, plugin-generated metadata, custom uploads outside WXR).

---

## 2. Target architecture (EmDash v0.40.1)

Read from `/home/git-projects/guidecyprus`:

- **Runtime:** Node.js (monorepo uses pnpm + Turborepo). Cloudflare Workers variant via `templates/*-cloudflare`. Node SQLite variant via `templates/*` (root).
- **DB:** SQLite (libSQL/Turso) for Node templates. Cloudflare D1 + R2 for Cloudflare templates.
- **Deploy:** Per template. Node → Dockerfile + compose.yaml (root). Cloudflare → Workers + Pages.
- **Content model:** Astro content collections with a schema-first approach. A "content collection" = a typed directory of files; schema lives next to it. Portable Text is the primary body format (PostgreSQL-shaped JSON tree).
- **i18n:** `lingui.config.ts` (translation extraction) + `lunaria.config.ts` (translation status tracker). **Pattern is single-source-with-translations** — you author once in a source locale, translations come from extracted message catalogs. **This is NOT a multi-locale-content model**, which is what most tourism guide sites (separate Turkish vs English content trees) actually need. See §4 below.
- **Media:** `assets/` directory committed to the repo (Node templates) or R2 bucket (Cloudflare templates). The WP importer downloads media into this directory.
- **CLI:** `pnpm new` runs `create-emdash` (interactive template scaffolder). `emdash import wordpress <file>` is the WP importer (compiled into `packages/core`).

### Key files in this repo

| Path | Purpose |
|---|---|
| `packages/core/src/cli/commands/import/wordpress.ts` | WXR importer entry point (Prepare → Execute) |
| `packages/core/src/cli/wxr/parser.ts` | Streaming SAX parser for WXR |
| `packages/gutenberg-to-portable-text/` | Gutenberg block → Portable Text converter |
| `packages/admin/src/components/WordPressImport.tsx` | Admin UI for the importer |
| `templates/blog/` (Node), `templates/blog-cloudflare/` (CF) | Starter templates |
| `templates/marketing/`, `templates/portfolio/` (and `-cloudflare` variants) | Other templates |
| `compose.yaml` | Local Docker compose for development |
| `Dockerfile` | Production container image |
| `AGENTS.md` | Contributor guide for AI agents |
| `lingui.config.ts`, `lunaria.config.ts`, `i18n/` | i18n setup |

---

## 3. Content mapping plan (WP → EmDash)

The EmDash WP importer (`packages/core/src/cli/commands/import/wordpress.ts`) is a **two-phase process**:

1. **`prepare`** — reads the WXR, analyses post types and meta keys, emits a suggested `MigrationConfig` (JSON or `live.config.ts`).
2. **`execute`** — runs the import using the (possibly human-edited) config, producing Portable Text content files inside the Astro content collections.

| WP concept | EmDash target | Notes |
|---|---|---|
| `wp_posts` where `post_type='post'` | Astro content collection `posts` (or whatever the chosen template names it) | EmDash's `prepare` phase suggests the mapping; user approves before `execute` |
| `wp_posts` where `post_type='page'` | Astro content collection `pages` | same |
| Custom post types | either mapped to a collection or `skipPostTypes` | user choice in config |
| `wp_terms` (category) | Collection-level taxonomy | becomes filterable frontmatter field |
| `wp_terms` (post_tag) | Collection-level tag taxonomy | same |
| Yoast `_yoast_wpseo_title`, `_yoast_wpseo_metadesc` | SEO component props / frontmatter `seo.title`, `seo.description` | rendered by template's `<SEO />` component |
| Yoast `_yoast_wpseo_opengraph-*` | frontmatter `seo.ogImage`, `seo.ogTitle`, etc. | same |
| Featured image (`_thumbnail_id`) | frontmatter `image:` + binary in `assets/` | downloaded during `execute` |
| Gallery/media library | `assets/` directory + frontmatter `gallery:` references | per-post URLs rewritten to local asset paths |
| Body content (Gutenberg HTML) | Portable Text JSON (`<collection>/<slug>/body.json` or inline) | converted via `@emdash-cms/gutenberg-to-portable-text` |
| WP slugs | Astro routes via dynamic `[slug]` | **slug preservation is on by default** in the importer; review the generated config |
| WP authors | EmDash user records | if user migration is in scope (see §5) |
| Comments | ❓ no equivalent in EmDash | open question |
| WP menus (nav_menu_item) | imported into `navMenus` field of WxrData, then mapped | see parser code |

**Slug preservation is the single most important part of the cutover.** Without it, every URL on the live site 404s after DNS flip. The EmDash importer preserves slugs by default; we must verify in `prepare` output before running `execute`.

---

## 4. i18n plan — and a likely gap

guidecyprus.com has multiple locales (`/tr/` observed in canonical URLs). EmDash's i18n stack (`lingui` + `lunaria`) is a **single-source-with-translations** model:

- One file per content entry, authored in the source locale.
- Translatable strings are extracted into catalogs.
- Translators (human or machine) produce parallel catalogs in target locales.
- The rendered page picks the catalog matching the request locale.

**Tourism guide sites are usually different.** A guide to Cyprus tends to have:
- Two parallel content trees (TR + EN) that don't always translate 1:1 — e.g., a section aimed at Turkish-speaking tourists vs. one aimed at English-speaking expats.
- Locale-specific content that doesn't exist in the other language.

If guidecyprus.com is in that pattern (likely — `/tr/` is the *prefix* not a query string, suggesting WPML or Polylang with separate posts per locale), EmDash's `lingui` model won't fit. Workaround options:

1. **Two Astro content collections** (`posts.tr/`, `posts.en/`) and a manual locale-aware loader. Breaks the template convention but works. Need to check if EmDash supports per-locale collections — read `packages/core/src/content/loader.ts`.
2. **Single collection with `locale` frontmatter field** and a query filter at request time. Cleaner. The loader needs to filter, not just match a slug.
3. **Stay on WordPress** with WPML/Polylang instead of migrating. Out of scope but worth raising.

**Decision needed before phase 2:** which model does guidecyprus.com use (1:1 translation vs. parallel content), and do you accept the workaround in option 2 if it's the latter?

---

## 5. Auth & user migration

`guidecyprus.com` exposes a JWT auth header (`X-JWT-Refresh`), suggesting the JWT Authentication plugin. EmDash has its own auth (`packages/auth`, `packages/auth-atproto`). Two paths:

- **Fresh user table.** Author accounts re-created manually. Recommended for a site with 1–5 editors.
- **WP user migration.** Run `prepare` against a DB dump to extract users; map to EmDash auth records. Only worth it if you have many editors or single sign-on requirements.

Open question: how many active WP users/editors on guidecyprus.com?

---

## 6. DNS / cutover plan

### Phase 1 — Preview (≈ 1–2 days)

- Pick a template. **`templates/blog` is the closest match** to a WP tourism guide (posts + pages + categories + tags + search + RSS). Confirm with you before proceeding.
- Scaffold locally: `pnpm new` → choose `blog` → set site URL `https://preview.guidecyprus.com`.
- Get the WXR export from WP admin. Run `pnpm emdash import wordpress prepare guidecyprus.wxr --output ./emdash-import/` and review the generated `MigrationConfig`.
- Edit the config: skip internal WP post types, confirm collection mapping, confirm slug preservation is on.
- Run `pnpm emdash import wordpress execute` with the edited config. Inspect the generated `apps/web/src/content/` tree.
- `pnpm dev` to preview locally. Verify 50 random WP posts render correctly with images.

### Phase 2 — Parallel run (≈ 2–5 days)

- Deploy to a staging host (Cloudflare Pages for Cloudflare template, or Fly.io / your existing infra for Node + Docker).
- Pick 100 random real URLs from guidecyprus.com and verify each one has an equivalent on the staging host (200 OK, correct content, correct image). Build a 301 redirect map for any URL that doesn't have a 1:1 match.
- Confirm SEO meta (titles, descriptions, OG) is preserved per post.
- Confirm featured images load.
- Run a Lighthouse audit on the staging host. Compare against guidecyprus.com's current score.

### Phase 3 — Cutover (≈ 30 minutes, then 30 days of monitoring)

- Drop TTL on `guidecyprus.com` DNS to 300s, 24h in advance.
- Flip DNS to the new host.
- Keep WP online for 30 days at a fallback path (e.g., `legacy.guidecyprus.com`) so editors can roll back individual posts.
- 301 redirects from old WP URLs to new EmDash URLs based on the map from phase 2.
- Watch 404 logs daily. Update the redirect map as gaps appear.
- After 30 days with no significant traffic on legacy, retire WP.

---

## 7. Open questions for the human

1. **Template choice.** `blog` is the default for a WP-like site. Confirm or override (`marketing`, `portfolio` exist but don't fit).
2. **Hosting target.** Cloudflare (D1 + R2, cheapest, fastest CDN) vs. Node on existing infra (Fly.io / your VPS). Affects template variant and infra cost.
3. **i18n model.** 1:1 translation or parallel content? See §4.
4. **WXR export availability.** Can you produce a `.wxr` file from WP admin (Tools → Export)? If not, can you provide WP admin credentials for a one-time CLI export?
5. **DB dump availability.** For full fidelity (menus, plugin metadata, custom uploads not in WXR), can you provide a `wp-content/` tarball + MySQL dump?
6. **Auth scope.** How many editors need accounts on the new site?
7. **Comments.** Keep, disable, or replace with a third-party (Disqus, etc.)?
8. **Domain TTL access.** Can you lower TTL on guidecyprus.com 24h before cutover?

---

## 8. Rough effort estimate

| Phase | Hours | Notes |
|---|---|---|
| 1 — Preview | 8–12 | WP export (1h wait) + `prepare` review (2h) + config editing (2h) + `execute` and fix-ups (3h) + content QA (3h) |
| 2 — Parallel | 6–10 | Deploy (2h) + URL audit and redirect map (3h) + SEO/visual QA (3h) |
| 3 — Cutover | 2 + 30 days passive | DNS flip (0.5h) + monitoring (30 days, ~10 min/day) |
| Auth + i18n extras | +4–16 | only if scope expands |

Total active work: **~20–40 hours** over 2–3 weeks of calendar time.

---

## 9. Next commands (for me to run)

```bash
# 1. Run `pnpm install` once you've approved this plan. Heavy — pulls ~1.5GB.
cd /home/git-projects/guidecyprus
pnpm install --frozen-lockfile

# 2. Scaffold the blog template into apps/blog (or as a sibling to apps/)
pnpm new -- --template blog

# 3. Once you have guidecyprus.wxr, prepare the migration:
pnpm --filter emdash exec emdash import wordpress prepare /path/to/guidecyprus.wxr \
  --output ./emdash-import/ --verbose
```

## 10. Blockers

None for the planning phase. Blockers for execution:

- **No WXR file yet.** Cannot run `prepare` without it.
- **i18n decision not made.** Affects whether single-collection or per-locale structure is used.
- **Hosting target not chosen.** Affects template variant (`blog` vs `blog-cloudflare`).
