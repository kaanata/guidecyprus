#!/usr/bin/env python3
"""Give Turkish places their English counterpart's featured image.

WPML never paired the tr posts with their en originals, and the tr posts on
WordPress had no featured image at all, so after the import every tr place
card is empty and no tr/en page carries the other's hreflang. The pairs in
scripts/tr-en-pairs.json were matched by slug and reviewed by hand (two tr
posts with no en original are left out; the duplicate tr `cinemiles-2` gets
the image but no link).

Images go through `emdash content update`, so each tr post gets a normal
revision. Only entries without an image are updated; re-running is a no-op.

Linking the pairs as translations is NOT done here. EmDash keys category and
tag assignments by the content's translation_group, so moving a tr post into
its en post's group swaps its Turkish categories for the English ones (tried
2026-09-29 and reverted). Linking needs the tr and en terms paired first and
the assignments merged.

Usage:
    python3 scripts/copy-tr-featured-images.py images <site-url> [--dry-run]
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


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    if args[:1] == ["images"] and len(args) == 2:
        images(args[1], dry_run="--dry-run" in sys.argv)
    else:
        sys.exit(__doc__)
