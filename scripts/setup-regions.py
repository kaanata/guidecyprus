#!/usr/bin/env python3
"""Create the `region` taxonomy and give posts without one a region.

Guide Cyprus covers the whole island. For visitors, a place is on one of two
sides, a taxonomy so listings can filter on it:

    en `trnc` "TRNC (KKTC)"           <->  tr `kktc` "KKTC"
    en `south-cyprus` "South Cyprus"  <->  tr `guney-kibris` "Güney Kıbrıs"

Idempotent: the taxonomy, its Turkish definition and the terms are created
only when missing, and only posts with no region get one.

Usage:
    python3 scripts/setup-regions.py <site-url> <posts.json> --default trnc [--south ids.json] [--dry-run]

<posts.json> is a `wrangler d1 execute --json` export of ec_posts with id
(deleted posts excluded). `--default` is the region given to posts that have
none; `--south` lists post IDs that are in South Cyprus.
"""

import argparse
import json
import os
import subprocess
import urllib.error
import urllib.request

USER_AGENT = "guidecyprus-scripts/1.0"

# (en slug, en label, tr slug, tr label)
REGIONS = [
    ("trnc", "TRNC (KKTC)", "kktc", "KKTC"),
    ("south-cyprus", "South Cyprus", "guney-kibris", "Güney Kıbrıs"),
]


def token(url: str) -> str:
    subprocess.run(["npx", "emdash", "whoami", "--url", url], capture_output=True)  # refreshes the token
    return json.load(open(os.path.expanduser("~/.config/emdash/auth.json"), encoding="utf-8"))[url]["accessToken"]


def api(url: str, path: str, body: dict | None = None) -> dict:
    headers = {"Authorization": "Bearer " + token(url), "User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        headers.update({"Content-Type": "application/json", "X-EmDash-Request": "1"})
        data = json.dumps(body).encode()
    request = urllib.request.Request(url + path, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response).get("data", {})
    except urllib.error.HTTPError as error:
        if error.code == 404 and data is None:
            return {}
        raise RuntimeError(f"{path}: HTTP {error.code} {error.read()[:300]!r}") from error


def terms(url: str, locale: str) -> dict[str, dict]:
    return {t["slug"]: t for t in api(url, f"/_emdash/api/taxonomies/region/terms?locale={locale}").get("terms", [])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("posts")
    parser.add_argument("--default", required=True, choices=[r[0] for r in REGIONS])
    parser.add_argument("--south", help="JSON list of post IDs in South Cyprus")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    url, dry = args.url, args.dry_run

    # 1. Taxonomy definitions: English, and the Turkish label.
    en_def = api(url, "/_emdash/api/taxonomies/region?locale=en")
    if not en_def:
        print("create taxonomy region (en)")
        if not dry:
            api(url, "/_emdash/api/taxonomies", {"name": "region", "label": "Regions", "labelSingular": "Region",
                                                 "hierarchical": False, "collections": ["posts"], "locale": "en"})
    tr_def = api(url, "/_emdash/api/taxonomies/region?locale=tr")
    if not tr_def or tr_def.get("locale") != "tr":
        print("create taxonomy region (tr)")
        if not dry:
            api(url, "/_emdash/api/taxonomies", {"name": "region", "label": "Bölgeler", "labelSingular": "Bölge", "locale": "tr"})
    if dry:
        print("dry run: stopping before terms and assignments")
        return

    # 2. Terms, the Turkish ones as translations of the English ones.
    en_terms = terms(url, "en")
    for en_slug, en_label, _, _ in REGIONS:
        if en_slug not in en_terms:
            print(f"create term {en_slug}")
            api(url, "/_emdash/api/taxonomies/region/terms", {"slug": en_slug, "label": en_label, "locale": "en"})
    en_terms = terms(url, "en")
    tr_terms = terms(url, "tr")
    for en_slug, _, tr_slug, tr_label in REGIONS:
        if tr_slug not in tr_terms:
            print(f"create term {tr_slug} (translation of {en_slug})")
            api(url, "/_emdash/api/taxonomies/region/terms",
                {"slug": tr_slug, "label": tr_label, "locale": "tr", "translationOf": en_terms[en_slug]["id"]})

    # 3. Posts without a region. Assignments store the term's translation
    # group, so the English term ID works for posts in either locale.
    rows = json.load(open(args.posts, encoding="utf-8"))
    rows = rows[0]["results"] if isinstance(rows, list) and rows and "results" in rows[0] else rows
    south = set(json.load(open(args.south, encoding="utf-8"))) if args.south else set()
    assigned = 0
    for row in rows:
        path = f"/_emdash/api/content/posts/{row['id']}/terms/region"
        if api(url, path).get("terms"):
            continue
        region = "south-cyprus" if row["id"] in south else args.default
        api(url, path, {"termIds": [en_terms[region]["id"]]})
        assigned += 1
    print(f"{assigned} posts got a region")


if __name__ == "__main__":
    main()
