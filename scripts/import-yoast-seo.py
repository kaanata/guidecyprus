#!/usr/bin/env python3
"""Generate SQL that copies Yoast SEO titles and descriptions into EmDash.

The WXR importer ignores Yoast post meta. This reads `_yoast_wpseo_title` and
`_yoast_wpseo_metadesc` from each post and page, matches the imported entry
by slug and locale (`_icl_lang_code`), and upserts `_emdash_seo`. EmDash
appends the site title itself, so a trailing site name is removed from
Yoast titles.

Usage:
    python3 scripts/import-yoast-seo.py export.xml > seo.sql
    pnpm wrangler d1 execute guidecyprus --local --file seo.sql
"""

import html
import re
import sys
import xml.etree.ElementTree as ET

WP = "{http://wordpress.org/export/1.2/}"
COLLECTIONS = {"post": "posts", "page": "pages"}
SEPARATOR = "-"
YOAST_VAR = re.compile(r"%%[a-z_]+%%")


def sql_str(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def clean_title(raw: str, post_title: str, site_name: str) -> str | None:
    title = raw.replace("%%title%%", post_title)
    title = title.replace("%%sitename%%", site_name).replace("%%sep%%", SEPARATOR)
    title = YOAST_VAR.sub("", title)
    title = re.sub(r"\s+", " ", title).strip()
    suffix = f" {SEPARATOR} {site_name}"
    while title.endswith(suffix):
        title = title[: -len(suffix)].rstrip()
    return title or None


def main(path: str) -> None:
    channel = ET.parse(path).getroot().find("channel")
    site_name = html.unescape(channel.findtext("title", "").strip())
    statements = ["UPDATE _emdash_collections SET has_seo = 1 WHERE slug IN ('posts', 'pages');"]

    for item in channel.findall("item"):
        collection = COLLECTIONS.get(item.findtext(f"{WP}post_type", ""))
        slug = item.findtext(f"{WP}post_name", "").strip()
        if not collection or not slug:
            continue
        meta = {
            m.findtext(f"{WP}meta_key", ""): m.findtext(f"{WP}meta_value", "")
            for m in item.findall(f"{WP}postmeta")
        }
        raw_title = meta.get("_yoast_wpseo_title", "").strip()
        description = html.unescape(meta.get("_yoast_wpseo_metadesc", "").strip()) or None
        title = clean_title(raw_title, item.findtext("title", ""), site_name) if raw_title else None
        if not title and not description:
            continue
        locale = meta.get("_icl_lang_code", "en")
        statements.append(
            "INSERT INTO _emdash_seo (collection, content_id, seo_title, seo_description) "
            f"SELECT {sql_str(collection)}, id, {sql_str(title)}, {sql_str(description)} "
            f"FROM ec_{collection} WHERE slug = {sql_str(slug)} AND locale = {sql_str(locale)} "
            "AND deleted_at IS NULL "
            "ON CONFLICT (collection, content_id) DO UPDATE SET "
            "seo_title = excluded.seo_title, seo_description = excluded.seo_description, "
            "updated_at = datetime('now');"
        )

    print("\n".join(statements))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
