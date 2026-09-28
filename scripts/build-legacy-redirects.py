#!/usr/bin/env python3
"""Generate src/data/legacy-redirects.json: exact 301s for WordPress-only URLs.

Covers the two URL families a WXR import leaves behind:

- /wp-content/uploads/... originals, mapped to the imported media file. The
  importer deduplicated identical bytes, so a WordPress "-1"/"-2" re-upload
  maps to its base file.
- Attachment pages (e.g. /some-post/image-slug/), which WordPress (Yoast)
  301'd to the image file. They go to the same media file.

Resized variants (-1024x576 etc.) have no imported copy and are not mapped.
Any source that is also a live content or taxonomy path is skipped, so a
redirect can never shadow a real page. Feeds, pagination, author archives and
wp-admin are rule-based and live in src/middleware.ts instead.

Usage:
    pnpm wrangler d1 execute guidecyprus --remote --json \\
        --command "SELECT filename, storage_key FROM media" > media.json
    pnpm wrangler d1 execute guidecyprus --remote --json \\
        --command "SELECT slug, locale FROM ec_posts WHERE deleted_at IS NULL \\
            UNION ALL SELECT slug, locale FROM ec_pages WHERE deleted_at IS NULL" > slugs.json
    python3 scripts/build-legacy-redirects.py export.wpml.wxr.xml media.json slugs.json \\
        > src/data/legacy-redirects.json
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

WP = "{http://wordpress.org/export/1.2/}"
MEDIA_PREFIX = "/_emdash/api/media/file/"
DUPLICATE_SUFFIX = re.compile(r"-\d+(\.\w+)$")


def d1_rows(path: str) -> list[dict]:
    """Rows from `wrangler d1 execute --json` output (or a plain list)."""
    data = json.load(open(path, encoding="utf-8"))
    return data[0]["results"] if isinstance(data, list) and data and "results" in data[0] else data


def site_path(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return path or "/"


def main(wxr_path: str, media_path: str, slugs_path: str) -> None:
    media = {row["filename"].lower(): row["storage_key"] for row in d1_rows(media_path)}
    live = {
        ("/tr/" if row["locale"] == "tr" else "/") + row["slug"]
        for row in d1_rows(slugs_path)
        if row.get("slug")
    }

    def media_url(attachment_url: str) -> str | None:
        name = os.path.basename(urlparse(attachment_url).path).lower()
        key = media.get(name) or media.get(DUPLICATE_SUFFIX.sub(r"\1", name))
        return MEDIA_PREFIX + key if key else None

    redirects: dict[str, str] = {}
    unmapped = shadowed = 0
    channel = ET.parse(wxr_path).getroot().find("channel")
    for item in channel.findall("item"):
        if item.findtext(f"{WP}post_type") != "attachment":
            continue
        attachment_url = item.findtext(f"{WP}attachment_url") or ""
        target = media_url(attachment_url)
        if not target:
            unmapped += 1
            continue
        for source in (site_path(attachment_url), site_path(item.findtext("link") or "")):
            if source == "/":
                continue
            if source in live:
                shadowed += 1
                continue
            redirects[source] = target

    json.dump(dict(sorted(redirects.items())), sys.stdout, indent="\t", ensure_ascii=False)
    sys.stdout.write("\n")
    print(
        f"{len(redirects)} redirects, {unmapped} attachments without media, "
        f"{shadowed} skipped as live paths",
        file=sys.stderr,
    )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
