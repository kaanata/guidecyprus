#!/usr/bin/env python3
"""Find candidate places across Cyprus, area by area, with the Places API.

For each area (a town or stretch of coast with a centre and radius) and each
kind of place, one Text Search request, "<kind> in <area>". Results carry the
area, its side of the island (for the `region` taxonomy) and the site
category, and are marked when a post with a matching name already exists.
The review of candidates and the checks (open, recent reviews) come after.

Usage:
    python3 scripts/discover-areas.py <existing-posts.json> <out.json> [--areas a,b,...] [--pages N]
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("discover_places", os.path.join(HERE, "discover-places.py"))
dp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dp)

# key: (search name, region, lat, lng, radius m)
AREAS = {
    "kyrenia-west": ("Lapta and Alsancak, Cyprus", "trnc", 35.345, 33.19, 9000),
    "kyrenia-east": ("Bellapais and Esentepe, Cyprus", "trnc", 35.31, 33.47, 14000),
    "lefkosa": ("North Nicosia (Lefkoşa)", "trnc", 35.182, 33.362, 6000),
    "famagusta": ("Famagusta (Gazimağusa)", "trnc", 35.125, 33.94, 8000),
    "iskele": ("Iskele and Long Beach, Cyprus", "trnc", 35.29, 33.9, 9000),
    "karpaz": ("Karpaz peninsula, Cyprus", "trnc", 35.6, 34.35, 30000),
    "guzelyurt": ("Güzelyurt, Cyprus", "trnc", 35.2, 32.99, 12000),
    "nicosia": ("Nicosia, Cyprus", "south-cyprus", 35.165, 33.36, 6000),
    "limassol": ("Limassol", "south-cyprus", 34.68, 33.04, 10000),
    "paphos": ("Paphos", "south-cyprus", 34.77, 32.42, 12000),
    "larnaca": ("Larnaca", "south-cyprus", 34.92, 33.63, 9000),
    "ayia-napa": ("Ayia Napa and Protaras", "south-cyprus", 35.0, 34.0, 9000),
    "troodos": ("Troodos mountains, Cyprus", "south-cyprus", 34.93, 32.87, 20000),
}

# (site category, kind of place)
KINDS = [
    ("hotels", "hotels"),
    ("restaurants", "restaurants"),
    ("bar-pub", "bars"),
    ("coffee-shop", "cafes"),
    ("beaches", "beaches"),
    ("historical", "historical sites"),
    ("historical", "museums"),
    ("entertainment", "things to do"),
]


def main(existing_path: str, out_path: str, areas: list[str], pages: int) -> None:
    rows = json.load(open(existing_path, encoding="utf-8"))
    rows = rows[0]["results"] if isinstance(rows, list) and rows and "results" in rows[0] else rows
    existing = [(r["slug"], dp.words(r["title"])) for r in rows if r.get("locale") == "en"]
    key = dp.api_key()
    found: dict[str, dict] = {}
    for area in areas:
        name, region, lat, lng, radius = AREAS[area]
        dp.KYRENIA = {"latitude": lat, "longitude": lng}  # centre for this area's searches
        for category, kind in KINDS:
            places = dp.search(key, f"{kind} in {name}", radius, pages)
            print(f"{area}: {kind}: {len(places)}", flush=True)
            for p in places:
                entry = found.setdefault(p["id"], {**p, "area": area, "region": region, "categories": []})
                if category not in entry["categories"]:
                    entry["categories"].append(category)
    for p in found.values():
        name = dp.words(p["displayName"]["text"])
        p["on_site"] = next((slug for slug, w in existing if name and w and (name <= w or w <= name)), None)
    json.dump(list(found.values()), open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(found)} unique places, {sum(1 for p in found.values() if p['on_site'])} already on the site")


if __name__ == "__main__":
    args = sys.argv[1:]
    pages, areas = 1, list(AREAS)
    for flag in ("--pages", "--areas"):
        if flag in args:
            i = args.index(flag)
            value = args[i + 1]
            del args[i:i + 2]
            if flag == "--pages":
                pages = int(value)
            else:
                areas = value.split(",")
    if len(args) != 2:
        sys.exit(__doc__)
    main(args[0], args[1], areas, pages)
