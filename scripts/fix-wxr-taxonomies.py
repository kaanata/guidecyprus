#!/usr/bin/env python3
"""Generate SQL that repairs category and tag terms after a WXR import.

The EmDash WXR importer (0.40.1) stores term names with HTML entities still
encoded, labels mirrored-locale terms with their slug, and flattens the
category hierarchy. This reads the WXR and emits UPDATE statements that set
the decoded WordPress name on every locale row and restore parent links
within each locale.

Usage:
    python3 scripts/fix-wxr-taxonomies.py export.xml > fix.sql
    pnpm wrangler d1 execute guidecyprus --local --file fix.sql
"""

import html
import sys
import xml.etree.ElementTree as ET

WP = "{http://wordpress.org/export/1.2/}"


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main(path: str) -> None:
    channel = ET.parse(path).getroot().find("channel")
    statements = []

    for el in channel.findall(f"{WP}category"):
        slug = el.findtext(f"{WP}category_nicename", "").strip()
        name = html.unescape(el.findtext(f"{WP}cat_name", "").strip())
        parent = el.findtext(f"{WP}category_parent", "").strip()
        if not slug:
            continue
        statements.append(
            f"UPDATE taxonomies SET label = {sql_str(name)} "
            f"WHERE name = 'category' AND slug = {sql_str(slug)};"
        )
        if parent:
            statements.append(
                "UPDATE taxonomies SET parent_id = ("
                "SELECT p.id FROM taxonomies p WHERE p.name = 'category' "
                f"AND p.slug = {sql_str(parent)} AND p.locale = taxonomies.locale) "
                f"WHERE name = 'category' AND slug = {sql_str(slug)};"
            )

    for el in channel.findall(f"{WP}tag"):
        slug = el.findtext(f"{WP}tag_slug", "").strip()
        name = html.unescape(el.findtext(f"{WP}tag_name", "").strip())
        if slug:
            statements.append(
                f"UPDATE taxonomies SET label = {sql_str(name)} "
                f"WHERE name = 'tag' AND slug = {sql_str(slug)};"
            )

    print("\n".join(statements))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
