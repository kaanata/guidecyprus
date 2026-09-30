#!/usr/bin/env python3
"""Find candidate places for each site category with the Places API (New).

Text Search per query, biased to a circle around Kyrenia: one request per
page of up to 20 results, following nextPageToken for up to --pages pages
(Google stops at 3, i.e. 60 results). The field mask asks only for what's needed to choose
candidates; phone and website come later from Place Details, only for the
places picked. Places already on the site are marked by name so they can
be skipped.

Google's terms allow keeping the place ID; the rest of the output is for
reviewing candidates, not for pasting into posts.

Usage:
    python3 scripts/discover-places.py <existing-posts.json> <out.json> [--pages N]

The key is read from GOOGLE_MAPS_PLACE_API_KEY in .env (never printed).
<existing-posts.json> is a `wrangler d1 execute --json` export of ec_posts
with at least slug, locale and title.
"""

import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.request

KYRENIA = {"latitude": 35.3364, "longitude": 33.3182}

# (category slug on the site, query, search radius in metres)
QUERIES = [
    ("hotels", "hotels in Kyrenia", 15000),
    ("restaurants", "restaurants in Kyrenia", 10000),
    ("casino", "casinos in Kyrenia", 20000),
    ("bar-pub", "bars and pubs in Kyrenia", 10000),
    ("coffee-shop", "coffee shops in Kyrenia", 10000),
    ("clubs", "night clubs in Kyrenia", 15000),
    ("beaches", "beaches near Kyrenia", 30000),
    ("historical", "historical sites near Kyrenia", 30000),
    ("historical", "museums in Kyrenia", 30000),
    ("services", "banks in Kyrenia", 10000),
    ("entertainment", "things to do in Kyrenia", 20000),
    ("entertainment", "cinemas and bowling in Kyrenia", 20000),
]

FIELDS = ",".join(
    "places." + f
    for f in (
        "id", "displayName", "formattedAddress", "businessStatus", "primaryType",
        "types", "location", "googleMapsUri", "rating", "userRatingCount",
    )
)


def api_key() -> str:
    key = os.environ.get("GOOGLE_MAPS_PLACE_API_KEY")
    if not key:
        env = os.path.join(os.path.dirname(__file__), "..", ".env")
        for line in open(env, encoding="utf-8"):
            if line.startswith("GOOGLE_MAPS_PLACE_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("GOOGLE_MAPS_PLACE_API_KEY is not set")
    return key


def search(key: str, query: str, radius: int, pages: int = 1) -> list[dict]:
    body = {
        "textQuery": query,
        "pageSize": 20,
        "languageCode": "en",
        "locationBias": {"circle": {"center": KYRENIA, "radius": radius}},
    }
    places: list[dict] = []
    for _ in range(pages):
        request = urllib.request.Request(
            "https://places.googleapis.com/v1/places:searchText",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": key,
                     "X-Goog-FieldMask": FIELDS + ",nextPageToken"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                page = json.load(response)
        except urllib.error.HTTPError as error:
            detail = json.load(error).get("error", {})
            sys.exit(f"{query}: HTTP {error.code} {detail.get('status')} {detail.get('message', '')[:200]}")
        places.extend(page.get("places", []))
        if not page.get("nextPageToken"):
            break
        body["pageToken"] = page["nextPageToken"]
    return places


STOP = {"the", "hotel", "hotels", "otel", "restaurant", "restaurants", "restoran", "bar", "cafe",
        "casino", "club", "kyrenia", "girne", "and", "spa", "resort", "by", "beach"}


def words(name: str) -> set[str]:
    name = unicodedata.normalize("NFKD", name.lower()).encode("ascii", "ignore").decode()
    return {w for w in re.split(r"[^a-z0-9]+", name) if w and w not in STOP}


def main(existing_path: str, out_path: str, pages: int = 1) -> None:
    rows = json.load(open(existing_path, encoding="utf-8"))
    rows = rows[0]["results"] if isinstance(rows, list) and rows and "results" in rows[0] else rows
    existing = [(r["slug"], words(r["title"])) for r in rows if r.get("locale") == "en"]

    key = api_key()
    found: dict[str, dict] = {}
    for category, query, radius in QUERIES:
        places = search(key, query, radius, pages)
        print(f"{query}: {len(places)}")
        for p in places:
            entry = found.setdefault(p["id"], {**p, "categories": [], "queries": []})
            if category not in entry["categories"]:
                entry["categories"].append(category)
            entry["queries"].append(query)

    for p in found.values():
        name = words(p["displayName"]["text"])
        match = next((slug for slug, w in existing if name and w and (name <= w or w <= name)), None)
        p["on_site"] = match

    json.dump(sorted(found.values(), key=lambda p: -(p.get("userRatingCount") or 0)),
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(found)} unique places, {sum(1 for p in found.values() if p['on_site'])} already on the site")


if __name__ == "__main__":
    args = sys.argv[1:]
    pages = 1
    if "--pages" in args:
        i = args.index("--pages")
        pages = int(args[i + 1])
        del args[i:i + 2]
    if len(args) != 2:
        sys.exit(__doc__)
    main(args[0], args[1], pages)
