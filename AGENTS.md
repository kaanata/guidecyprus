This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
pnpm dev              # Start the Astro dev server
npx emdash types      # Regenerate TypeScript types from a running site
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

## Key Files

| File                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `astro.config.mjs`       | Astro config with `emdash()` integration, database, and storage                    |
| `src/live.config.ts`     | EmDash loader registration (boilerplate -- don't modify)                           |
| `seed/seed.json`         | Schema definition + demo content (collections, fields, taxonomies, menus, widgets) |
| `emdash-env.d.ts`        | Generated types for collections (auto-regenerated on dev server start)             |
| `src/layouts/Base.astro` | Base layout with EmDash wiring (menus, search, page contributions)                 |
| `src/pages/`             | Astro pages -- all server-rendered                                                 |

## Skills

Agent skills are in `.agents/skills/`. Load them when working on specific tasks:

- **building-emdash-site** -- Querying content, rendering Portable Text, schema design, seed files, site features (menus, widgets, search, SEO, comments, bylines). Start here.
- **creating-plugins** -- Building EmDash plugins with hooks, storage, admin UI, API routes, and Portable Text block types.
- **emdash-cli** -- CLI commands for content management, seeding, type generation, and visual editing flow.

## Documentation

The EmDash docs are available as an MCP server at `https://docs.emdashcms.com/mcp`. When you need to verify an API, hook, config option, field type, or pattern, call `search_docs` against the live documentation rather than relying on training-data recall. The docs reflect current behaviour; assumptions may not.

This template ships with `.mcp.json`, `.cursor/mcp.json`, and `.vscode/mcp.json` so Claude Code, Cursor, and VS Code auto-discover the docs server. Other tools (OpenCode, Windsurf, etc.) need a manual one-time setup -- see [docs.emdashcms.com/docs-mcp](https://docs.emdashcms.com/docs-mcp).

## Rules

- All content pages must be server-rendered (`output: "server"`). No `getStaticPaths()` for CMS content.
- Image fields are objects (`{ src, alt }`), not strings. Use `<Image image={...} />` from `"emdash/ui"`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).

## This Site

Guide Cyprus: a bilingual (en, tr under `/tr`) directory of places across Cyprus -- historical sites, hotels, restaurants, bars, casinos, beaches, banks (so far mostly around Kyrenia/Girne). Posts are places; categories are kinds of place. Each place has a region (`region` taxonomy: TRNC (KKTC) / South Cyprus; tr terms KKTC / Güney Kıbrıs). The "Visiting" switch (`RegionSwitch.astro`, `src/utils/region.ts`) filters the home page and listings with `?region=trnc|south`; the place page shows the region and a short crossing/currency note. Places also have a town (`town` taxonomy, 11 towns; `src/utils/towns.ts` holds the URL keys and per-locale slugs): the home page finder offers the towns with published places and links each to `/posts?town=<key>`, the listings (`/posts`, `/category/<slug>`) filter with `?town=` (ANDed with `?region=`), and the place page shows a Town row. Never describe the site as "North Cyprus". Readers are visitors, often on a phone, who want to find a place by kind and get its essentials (photo, address, phone). Built from the EmDash blog template, now themed as "Kyrenia harbour" in a Sanzo Wada palette.

## Pages

| Page        | Path               | What it shows                                                                                                        |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Home        | `/`, `/tr`         | `HomeView`: hero finder ("I'm looking for [kind] in [town]", posts to `/posts?kind=&town=`, which redirects via `src/utils/finder.ts`) beside the chosen town's poster, town links, kinds as illustrated tiles with counts, recently added grid, the front page's CMS text   |
| All places  | `/posts`           | Count, jump-to-kind row, grid of place cards                                                                         |
| Place       | `/[slug]`          | Breadcrumb, name, wide photo, left facts column (kind, region, added, tags, visitor note), body, right gutter (TOC, kinds of place with counts, recently added; `PlaceGutter.astro`), "More <kind>" |
| Page        | `/[slug]`          | Static page content (Portable Text) in a reading column                                                              |
| Search      | `/search`          | Search form and result list                                                                                          |
| Category    | `/category/[slug]` | Places of one kind                                                                                                   |
| Tag         | `/tag/[slug]`      | Places with one tag                                                                                                  |
| RSS         | `/rss.xml`         | Generated feed                                                                                                       |

## Schema

- `posts` collection: `title`, `featured_image`, `content` (Portable Text), `excerpt` (text).
- `pages` collection: `title`, `content` (Portable Text). Used for `/about` etc.
- Taxonomies: `category`, `tag`, `region` (en `trnc` / `south-cyprus`, tr `kktc` / `guney-kibris`).
- Single `primary` menu (Home, About, Posts by default).

Site settings have `title` and `tagline` -- both render in the header / footer.

## Visual character

- **Colour.** Sanzo Wada, *A Dictionary of Color Combinations* (#1, #125, #227, #339, #190). Cerulian Blue `#0093a5` (`--color-sea`) is the field, now carried mostly by the illustrations' sea. English Red `#d96629` (`--color-mark`) is the small mark: the finder's dropdown rules, current nav item, focus rings, card-title hover underline, title and blockquote rules. Violet Blue `#40456a` is the ink: text, primary buttons (`--color-button`), the footer band. Links are Cerulian darkened to `#007684` (`--color-brand`, 5.4:1), hover to ink. Light Glaucous Blue only as the pale surface tint, Ivory Buff (`--color-sand`) for the island and photo placeholders. Flat colour only. Dark mode via `light-dark()` in the tokens. Photos carry the colour.
- **Type.** **Young Serif** on `--font-display` (= `--font-heading`) for h1/h2, page titles and place names. It has one weight (400); never bold it (`font-synthesis: none`). **Schibsted Grotesk** on `--font-body` for everything else, card titles at 600. Both load with latin-ext for Turkish. Major-third scale on a 17px base.
- **The island.** One outline of the whole island (`src/utils/island.ts`, Natural Earth land data, no internal lines) is the brand mark, tiny in the wordmark (`Wordmark.astro`). Use it nowhere else. (The home page had a large island map until 2026-10; it was replaced by the finder.)
- **The finder.** The home hero is one sentence in Young Serif with two native `<select>`s set in it ("I'm looking for [kind] in [town]"; tr puts the town first). It is a plain GET form, so it works without JS; JS only swaps the town poster beside it.
- **Places, not posts.** No author bylines, reading time or "continue reading". Show the place's kind instead; `src/utils/kind.ts` picks it (the town category `girne` only as a fallback, `uncategorized` never).
- **Logos as photos.** Many places have a logo as their featured image. A script in `Base.astro` checks images inside `[data-photo-frame]`: if the border (or the four corners) is one flat colour, it sets `data-logo` and a tile of that colour, and `theme.css` shows the image whole instead of cropped.
- **Illustrations.** Flat travel-poster drawings in the site palette, AI-generated with MiniMax (`public/illustrations/`, listed in `src/utils/illustrations.ts`): one per kind, the tile for a place without its own image (`KindPlaceholder.astro`) and the home page's kind tiles, and one per town, the banner on `/posts?town=<key>` and the home hero's poster. Wherever one is shown as content it is labelled as an illustration (alt text, plus the 9px "Illustration" caption on the place page and the town banner); on cards it is decorative. They carry `data-illustration`, so the logo script skips them. Never use one to depict a specific venue.
- The place page keeps the three-column reading layout (facts column, ~68ch body, right gutter). Don't flatten it on desktop.

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css`; the theme's tokens and shared rules are in `theme.css`, the header/footer in `Base.astro`.

Colours are defined with `light-dark(<light>, <dark>)`, so each token carries both modes. Overriding with a plain colour changes light and dark at once; use `light-dark()` in the override to keep them distinct. There is no separate dark palette to maintain.

Webfonts are configured in `astro.config.mjs` under `fonts:`. To swap the body face, change the `name:` for the entry bound to `cssVariable: "--font-body"`. Good alternatives: Geist, IBM Plex Sans, Söhne (if you have a licence), Public Sans. If you want a serif-bodied blog, swap to a humanist serif like Source Serif, Crimson Pro, or Lora -- but then also raise `--font-size-base` to `1.0625rem` for readability. To give headings their own face (or use a system font) without touching the font pipeline, override `--font-heading` or `--font-body` in `theme.css`.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--color-brand`, `--color-brand-hover`, `--color-on-brand`, `--color-brand-ring`
- `--color-bg`, `--color-bg-subtle`, `--color-surface`, `--color-text`, `--color-text-secondary`, `--color-muted`, `--color-border`, `--color-border-subtle`
- `--font-body`, `--font-display`, `--font-heading`, `--font-mono`
- `--color-sea`, `--color-mark`, `--color-sand` (`--color-limestone` is an alias), `--color-button` / `--color-on-button`, `--color-ink-band`, `--color-on-ink-band`, `--color-on-ink-band-muted`
- `--font-weight-heading` (600) / `--font-weight-display` (400, Young Serif's only weight)
- `--tracking-tight` / `--tracking-snug` / `--tracking-wide` / `--tracking-wider` -- letter-spacing tokens used across headings and meta labels
- `--content-width` (680px) -- article body column
- `--wide-width` (1200px) -- max container
- `--gutter-width` (200px) -- right sidebar (TOC) on article pages
- `--meta-col-width` (180px) -- left meta column on article pages

## What not to do

- Don't add colours outside the Wada set, or tints/gradients of red or Cerulian. English Red and full-strength Cerulian are ~3.6:1 on white: never text under 24px or a background under small text.
- No template tells: no `text-transform: uppercase` labels, no "A · B" meta strings, no "→" on links, no monospace labels, no hover lift or shadows on cards (the search dropdown is the only shadow), no scroll-triggered animation. There is no automatic motion; the home poster's short fade on a town change is the only transition, off under reduced motion.
- Every user-visible string goes through `t()` in `src/utils/strings.ts` with en and tr values.
- Don't collapse the place-page gutter on desktop.
- Don't enable comments without a plan to moderate them.
