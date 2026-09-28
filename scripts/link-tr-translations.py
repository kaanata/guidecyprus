#!/usr/bin/env python3
"""Give Turkish places their English counterpart's featured image and link
the two as translations.

WPML never paired the tr posts with their en originals, and the tr posts on
WordPress had no featured image at all, so after the import every tr place
card is empty and no tr/en page carries the other's hreflang. The pairs in
scripts/tr-en-pairs.json were matched by slug and reviewed by hand (two tr
posts with no en original are left out; the duplicate tr `cinemiles-2` gets
the image but no link).

Step 1 (images) goes through `emdash content update`, so each tr post gets a
normal revision. Step 2 (links) has no API: translation_group is a column,
so this writes an SQL file that moves each tr post into its en post's group,
and moves any menu item pointing at the old group along with it.

Only entries that change are updated; re-running is a no-op.

Usage:
    python3 scripts/link-tr-translations.py images <site-url> [--dry-run]
    python3 scripts/link-tr-translations.py sql > link-tr-translations.sql
    pnpm wrangler d1 execute guidecyprus --remote --file link-tr-translations.sql
"""

import json
import os
import subprocess
import sys

PAIRS = os.path.join(os.path.dirname(__file__), "tr-en-pairs.json")


def cli(*args: str) -> str:
    result = subprocess.run(["npx", "emdash", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def get(entry_id: str, url: str) -> dict:
    return json.loads(cli("content", "get", "posts", entry_id, "--raw", "--json", "--url", url))


def images(url: str, dry_run: bool) -> None:
    changed = 0
    for pair in json.load(open(PAIRS, encoding="utf-8")):
        image = get(pair["en_id"], url)["data"].get("featured_image")
        if not image:
            print(f"skip {pair['tr_slug']}: {pair['en_slug']} has no featured image")
            continue
        entry = get(pair["tr_id"], url)
        if entry["data"].get("featured_image"):
            continue
        changed += 1
        print(f"{'would set' if dry_run else 'set'} {pair['tr_slug']} <- {pair['en_slug']}")
        if not dry_run:
            cli(
                "content", "update", "posts", pair["tr_id"],
                "--rev", entry["_rev"],
                "--data", json.dumps({"featured_image": image}),
                "--url", url,
            )
    print(f"{changed} {'to update' if dry_run else 'updated'}")


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def sql() -> None:
    for pair in json.load(open(PAIRS, encoding="utf-8")):
        if not pair["link"]:
            continue
        old, new = quote(pair["tr_group"]), quote(pair["en_group"])
        print(f"-- {pair['tr_slug']} -> {pair['en_slug']}")
        # Guarded so a re-run, or an en group that already has a tr entry, changes nothing.
        print(
            f"UPDATE ec_posts SET translation_group = {new} "
            f"WHERE id = {quote(pair['tr_id'])} AND locale = 'tr' AND translation_group = {old} "
            f"AND NOT EXISTS (SELECT 1 FROM ec_posts WHERE translation_group = {new} AND locale = 'tr');"
        )
        print(
            f"UPDATE _emdash_menu_items SET reference_id = {new} WHERE reference_id = {old} "
            f"AND EXISTS (SELECT 1 FROM ec_posts WHERE id = {quote(pair['tr_id'])} AND translation_group = {new});"
        )


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    if args[:1] == ["images"] and len(args) == 2:
        images(args[1], dry_run="--dry-run" in sys.argv)
    elif args == ["sql"]:
        sql()
    else:
        sys.exit(__doc__)
