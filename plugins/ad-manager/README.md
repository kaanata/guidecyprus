# Ad manager (`@main-aff/plugin-ad-manager`)

Ad spaces for the DailyBet site. The theme places empty, labelled spaces; this plugin decides what fills them.

## What it does

- Two kinds of ad: **banner** (image from the media library + link) and **code** (an ad-network snippet such as AdSense).
- Four spaces: top banner, in-feed, article sidebar (desktop only) and in-article. Sizes live in `src/spaces.ts`, which the theme imports.
- Scheduling (start/end), weighted rotation (no repeats on a page), targeting by page type and competition.
- Stats: impressions (counted when an ad is at least half on screen) and clicks, rolled up every 5 minutes into daily totals.

## How it works

1. `page:fragments` injects a small loader at the end of a public page, but only while at least one ad is servable: its status is active, it is inside its schedule window (`startsAt` inclusive, `endsAt` exclusive), and it is not a code ad while "Show code ads" is off. Page, space and country targeting are not checked here; `serve` does that. When nothing is servable the hook returns `null`, so `html[data-ads]` never turns on, the reserved spaces stay `display: none`, and there is no layout shift. The check is one indexed storage query per render. The code-ads setting is only read when every live ad is a code ad. If the query fails, the hook logs a warning and injects the loader anyway, so a transient error can't hide ads.
2. The loader sends one `POST /_emdash/api/plugins/ad-manager/serve` with the page's spaces and context, then renders the ads.
3. Views and clicks go to `POST …/track`, which appends one event record per request.
4. The `stats-rollup` cron task (`*/5 * * * *`) folds events into per-ad daily stats. Plugins registered in `astro.config.mjs` never get EmDash's install and activate hooks, so the task is also created the first time an admin opens the Ads page or saves an ad or the settings. Cron task names may only use letters, digits, `-` and `_`.

Spaces stay collapsed if the plugin is disabled, `serve` fails or times out (3 s), or nothing matches.

Rendered pages can be cached. EmDash gives plugins no way to purge the page cache, and saving, pausing or deleting an ad doesn't invalidate anything. So a cached page keeps its old decision until it is re-rendered. A page cached with no ads won't show a new ad until it refreshes. A page cached with the loader keeps calling `serve` after the last ad ends, reserves space, and collapses it again. On this site, route caching isn't configured in `astro.config.mjs`, so every request re-renders and changes apply straight away. If you turn on a page cache, expect ad changes to show up only after its TTL or the next content change that purges those pages.

The rollup saves the daily totals before it deletes the events it folded in, so a crash between the two steps, or two overlapping runs, can count one batch twice. Counts are never lost.

## Building

`dist/` is not committed and the site imports it, so after changing plugin source run:

    pnpm --filter @main-aff/plugin-ad-manager build

before `pnpm dev`, `pnpm build` or `pnpm deploy`.

`astro.config.mjs` loads `dist/index.js` in plain Node, so relative imports in `src/index.ts` must keep their `.js` extension. Every other module is loaded through Vite and needs none.

## Safety and privacy

- Only admins can create or edit ads. **Code ads run on the public site exactly as pasted**; use "Show code ads" on the Ads page to switch them all off at once.
- The plugin sets no cookies and stores no IPs or visitor ids — only per-ad daily totals. Ad-network code may set its own cookies and may need a consent banner.

## Tests

    pnpm --filter @main-aff/plugin-ad-manager test
