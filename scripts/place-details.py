#!/usr/bin/env python3
"""Fetch Place Details (Places API New) for an approved list of places.

One request per place, with a field mask limited to what a post needs:
address, location, Maps link, website, phone and opening hours. The
editorial summary is fetched as background for writing, never pasted.

Usage:
    python3 scripts/place-details.py <approved.json> <out.json> \\
        [--key-var GOOGLE_MAPS_PLACE_API_KEY] [--limit N] [--reviews]

<approved.json> is a list of {"place_id", "name", "category", ...}. The key
is read from the named variable in the environment or .env (never printed).
--reviews also fetches the (up to 5) reviews, only so the newest review's
date can show whether a place is still active; review text is never used.
Use --key-var GOOGLE_MAPS_API_DEMO_KEY --limit 3 to test for free; the demo
key's terms forbid production use, so real content uses the Places key.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

FIELDS = ",".join((
    "id", "displayName", "formattedAddress", "shortFormattedAddress", "location",
    "googleMapsUri", "websiteUri", "internationalPhoneNumber", "nationalPhoneNumber",
    "regularOpeningHours.weekdayDescriptions", "primaryTypeDisplayName",
    "businessStatus", "editorialSummary",
))


def api_key(var: str) -> str:
    key = os.environ.get(var)
    if not key:
        env = os.path.join(os.path.dirname(__file__), "..", ".env")
        for line in open(env, encoding="utf-8"):
            if line.startswith(var + "="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit(f"{var} is not set")
    return key


def details(key: str, place_id: str, reviews: bool = False) -> dict:
    request = urllib.request.Request(
        f"https://places.googleapis.com/v1/places/{place_id}?languageCode=en",
        headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS + (",reviews" if reviews else "")},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = json.load(error).get("error", {})
        sys.exit(f"{place_id}: HTTP {error.code} {detail.get('status')} {detail.get('message', '')[:200]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("approved")
    parser.add_argument("out")
    parser.add_argument("--key-var", default="GOOGLE_MAPS_PLACE_API_KEY")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--reviews", action="store_true")
    args = parser.parse_args()

    key = api_key(args.key_var)
    places = json.load(open(args.approved, encoding="utf-8"))[: args.limit]
    out = []
    for place in places:
        info = details(key, place["place_id"], args.reviews)
        if args.reviews:
            dates = sorted(r.get("publishTime", "") for r in info.pop("reviews", []))
            info["latestReview"] = dates[-1][:10] if dates else None
        out.append({**place, "details": info})
        print(f"{place['name']}: website={'yes' if info.get('websiteUri') else 'no'} "
              f"phone={'yes' if info.get('internationalPhoneNumber') else 'no'} "
              f"hours={'yes' if info.get('regularOpeningHours') else 'no'}")
    json.dump(out, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(out)} places written to {args.out}")


if __name__ == "__main__":
    main()
