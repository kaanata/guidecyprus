#!/usr/bin/env python3
"""Add WPML language data to a WXR export as postmeta the EmDash importer reads.

WPML keeps each post's language and translation group in its
`icl_translations` table, not postmeta, so a stock WXR carries neither and
every entry imports into the default locale. This adds `_icl_lang_code` and
`trid` postmeta to each item from a dump of that table. Items that already
have `_icl_lang_code` are left alone.

On the WordPress server:
    wp export --skip-plugins --stdout > export.xml
    wp db query --skip-column-names "SELECT element_id, language_code, trid \
        FROM $(wp db prefix)icl_translations WHERE element_type LIKE 'post\\_%'" > icl.tsv

Then:
    python3 scripts/add-wpml-to-wxr.py export.xml icl.tsv > export-wpml.xml
"""

import re
import sys

ITEM = re.compile(r"<item>.*?</item>", re.S)
POST_ID = re.compile(r"<wp:post_id>\s*(\d+)\s*</wp:post_id>")


def meta(key: str, value: str) -> str:
    return (
        "\t\t<wp:postmeta>\n"
        f"\t\t\t<wp:meta_key><![CDATA[{key}]]></wp:meta_key>\n"
        f"\t\t\t<wp:meta_value><![CDATA[{value}]]></wp:meta_value>\n"
        "\t\t</wp:postmeta>\n"
    )


def main(wxr_path: str, tsv_path: str) -> None:
    languages = {}
    with open(tsv_path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[0].isdigit() and parts[1] not in ("", "NULL"):
                languages[parts[0]] = (parts[1], parts[2])

    with open(wxr_path, encoding="utf-8") as f:
        wxr = f.read()

    counts = {"tagged": 0, "untagged": 0, "skipped": 0}

    def tag(match: re.Match) -> str:
        item = match.group(0)
        post_id = POST_ID.search(item)
        if "_icl_lang_code" in item:
            counts["skipped"] += 1
            return item
        if not post_id or post_id.group(1) not in languages:
            counts["untagged"] += 1
            return item
        lang, trid = languages[post_id.group(1)]
        counts["tagged"] += 1
        return item[: -len("</item>")] + meta("_icl_lang_code", lang) + meta("trid", trid) + "\t</item>"

    sys.stdout.write(ITEM.sub(tag, wxr))
    print(
        f"tagged {counts['tagged']}, no WPML row {counts['untagged']}, "
        f"already tagged {counts['skipped']}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
