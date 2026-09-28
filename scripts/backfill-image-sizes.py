#!/usr/bin/env python3
"""Add width/height to imported images so browsers can reserve their space.

The WXR importer stores Portable Text image blocks and `featured_image`
objects with a URL only. Without dimensions every image shifts the layout
when it loads (Lighthouse CLS 0.35 on image-heavy posts). The media table
has the real sizes, so this sets `width`/`height` on each image block and
featured image whose file is in the media library, through
`emdash content update` so each post gets a normal revision.

Only entries that change are updated; re-running is a no-op.

Usage:
    pnpm wrangler d1 execute guidecyprus --remote --json \\
        --command "SELECT storage_key, width, height FROM media" > media-sizes.json
    pnpm wrangler d1 execute guidecyprus --remote --json \\
        --command "SELECT id FROM ec_posts WHERE deleted_at IS NULL" > post-ids.json
    python3 scripts/backfill-image-sizes.py media-sizes.json post-ids.json \\
        https://guidecyprus.divine-queen-9624.workers.dev [--dry-run]
"""

import json
import os
import re
import subprocess
import sys
import tempfile

MEDIA_FILE = re.compile(r"/_emdash/api/media/file/([^/?#]+)")


def d1_rows(path: str) -> list[dict]:
    data = json.load(open(path, encoding="utf-8"))
    return data[0]["results"] if isinstance(data, list) and data and "results" in data[0] else data


def cli(*args: str) -> str:
    result = subprocess.run(["npx", "emdash", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def size_for(url: str | None, sizes: dict) -> tuple[int, int] | None:
    match = MEDIA_FILE.search(url or "")
    return sizes.get(match.group(1)) if match else None


def sized(obj: dict, size: tuple[int, int] | None) -> bool:
    """Set width/height on obj when known and missing; report whether it changed."""
    if not size or (obj.get("width") and obj.get("height")):
        return False
    obj["width"], obj["height"] = size
    return True


def main(sizes_path: str, ids_path: str, url: str, dry_run: bool) -> None:
    sizes = {
        row["storage_key"]: (row["width"], row["height"])
        for row in d1_rows(sizes_path)
        if row.get("width") and row.get("height")
    }
    updated = unchanged = failed = 0
    for row in d1_rows(ids_path):
        entry_id = row["id"]
        try:
            entry = json.loads(cli("content", "get", "posts", entry_id, "--raw", "--json", "--url", url))
            data = entry.get("data", {})
            changes = {}

            content = data.get("content") or []
            content_changed = False
            for block in content:
                if block.get("_type") == "image":
                    asset = block.get("asset") or {}
                    content_changed |= sized(block, size_for(asset.get("url") or asset.get("_ref"), sizes))
            if content_changed:
                changes["content"] = content

            featured = data.get("featured_image")
            if isinstance(featured, dict) and sized(featured, size_for(featured.get("src"), sizes)):
                changes["featured_image"] = featured

            if not changes:
                unchanged += 1
                continue
            if dry_run:
                print(f"would update {entry.get('slug')}: {sorted(changes)}")
                updated += 1
                continue
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump(changes, f)
            try:
                cli("content", "update", "posts", entry_id, "--rev", entry["_rev"], "--file", f.name, "--url", url)
            finally:
                os.unlink(f.name)
            updated += 1
            print(f"updated {entry.get('slug')}: {sorted(changes)}", flush=True)
        except Exception as error:  # keep going; report at the end
            failed += 1
            print(f"FAILED {entry_id}: {error}", file=sys.stderr, flush=True)
    print(f"{updated} updated, {unchanged} unchanged, {failed} failed", file=sys.stderr)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    if len(args) != 3:
        sys.exit(__doc__)
    main(*args, dry_run="--dry-run" in sys.argv)
