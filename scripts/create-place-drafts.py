#!/usr/bin/env python3
"""Create English draft posts for new places found with the Places API.

For each place: upload its image (a logo from the official website, or a
freely licensed Wikimedia Commons photo) to the media library, create the
post as a draft with the reviewed copy and a facts block (address, phone,
website, opening hours), and assign its categories the way
existing posts have them (a kind under Entertainment also gets the
`entertainment` parent). Nothing is published.

The Google place ID of every created post is appended to
scripts/data/places.json, the only Places data Google's terms allow keeping,
so a post can be refreshed from the API later. Places already listed there
are skipped, so re-running doesn't duplicate.

Usage:
    python3 scripts/create-place-drafts.py <details.json> <copy.json> <images.json> <site-url> [--dry-run]

<images.json>: [{"place_id", "file", "alt", "author"?, "license"?, "license_url"?, "commons_page"?,
                 "media"?: an already-uploaded media item, as `emdash media upload --json` prints it}]
"""

import json
import os
import secrets
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LEDGER = os.path.join(HERE, "data", "places.json")
USER_AGENT = "guidecyprus-scripts/1.0"

# Site category slug -> term slugs to assign, matching existing posts.
TERMS = {
    "restaurants": ["entertainment", "restaurants"],
    "bar-pub": ["entertainment", "bar-pub-2"],
    "beaches": ["entertainment", "beaches"],
    "casino": ["entertainment", "casino"],
    "clubs": ["entertainment", "clubs"],
    "coffee-shop": ["entertainment", "coffee-shop"],
    "entertainment": ["entertainment"],
    "hotels": ["hotels"],
    "hotel-casino": ["hotels", "entertainment", "casino"],
    "historical": ["historical"],
}


def cli(*args: str) -> str:
    result = subprocess.run(["npx", "emdash", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def token(url: str) -> str:
    cli("whoami", "--url", url)  # refreshes a stale access token
    auth = json.load(open(os.path.expanduser("~/.config/emdash/auth.json"), encoding="utf-8"))
    return auth[url]["accessToken"]


def api(url: str, path: str, body: dict | None = None) -> dict:
    headers = {"Authorization": "Bearer " + token(url), "User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        headers.update({"Content-Type": "application/json", "X-EmDash-Request": "1"})
        data = json.dumps(body).encode()
    request = urllib.request.Request(url + path, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)["data"]


def key() -> str:
    return secrets.token_hex(5)


def span(text: str, marks: list[str] | None = None) -> dict:
    return {"_type": "span", "_key": key(), "text": text, "marks": marks or []}


def block(children: list[dict], mark_defs: list[dict] | None = None) -> dict:
    return {"_type": "block", "_key": key(), "style": "normal", "children": children, "markDefs": mark_defs or []}


def link(href: str) -> tuple[str, dict]:
    ref = key()
    return ref, {"_type": "link", "_key": ref, "href": href}


def facts(details: dict) -> dict:
    """One block of 'Label: value' lines, like the imported posts."""
    children, defs = [], []

    def line(label: str, value: str, href: str | None = None) -> None:
        if children:
            children.append(span("\n"))
        children.append(span(f"{label}: ", ["strong"]))
        if href:
            ref, definition = link(href)
            defs.append(definition)
            children.append(span(value, [ref]))
        elif value:
            children.append(span(value))

    if details.get("formattedAddress"):
        line("Address", details["formattedAddress"])
    if details.get("internationalPhoneNumber"):
        phone = details["internationalPhoneNumber"]
        line("Phone", phone, "tel:" + phone.replace(" ", ""))
    site = details.get("websiteUri")
    if site:
        line("Website", site.split("://", 1)[-1].rstrip("/"), site)
    if details.get("googleMapsUri"):
        line("Map", "Open in Google Maps", details["googleMapsUri"])
    hours = (details.get("regularOpeningHours") or {}).get("weekdayDescriptions")
    if hours:
        line("Opening hours", "")
        for day in hours:
            children.append(span("\n" + day.replace(" ", " ").replace(" ", " ")))
    return block(children, defs)


def flatten(terms: list[dict]) -> list[dict]:
    out = []
    for term in terms:
        out.append(term)
        out.extend(flatten(term.get("children") or []))
    return out


def main(details_path: str, copy_path: str, images_path: str, url: str, dry_run: bool) -> None:
    details = {p["place_id"]: p for p in json.load(open(details_path, encoding="utf-8"))}
    copy = {c["place_id"]: c for c in json.load(open(copy_path, encoding="utf-8"))}
    images = {i["place_id"]: i for i in json.load(open(images_path, encoding="utf-8"))}
    ledger = json.load(open(LEDGER, encoding="utf-8")) if os.path.exists(LEDGER) else []
    done = {entry["place_id"] for entry in ledger}

    terms = {t["slug"]: t["id"] for t in flatten(api(url, "/_emdash/api/taxonomies/category/terms?locale=en")["terms"])}
    # Region and town terms, when the details carry them (keys as in setup-regions / the town table).
    region_terms = {t["slug"]: t["id"] for t in api(url, "/_emdash/api/taxonomies/region/terms?locale=en").get("terms", [])}
    town_terms = {t["slug"]: t["id"] for t in api(url, "/_emdash/api/taxonomies/town/terms?locale=en").get("terms", [])}

    for place_id, place in details.items():
        if place_id in done:
            print(f"skip {place['name']}: already created")
            continue
        text = copy[place_id]["en"]
        image = images.get(place_id)
        term_ids = [terms[slug] for slug in TERMS[place["category"]]]
        content = [block([span(p)]) for p in text["paragraphs"]]
        content.append(facts(place["details"]))

        print(f"{'would create' if dry_run else 'create'} {text['slug']}: {place['category']}, "
              f"{place.get('region', '-')}, {place.get('town', '-')}, image={'yes' if image else 'no'}", flush=True)
        if dry_run:
            continue

        data = {"title": text["title"], "excerpt": text["excerpt"], "content": content}
        if image:
            # An entry may carry a media item uploaded earlier; reuse it.
            media = image.get("media") or json.loads(cli("media", "upload", image["file"], "--json", "--url", url))
            data["featured_image"] = {
                "id": media["id"], "src": media["url"], "alt": image["alt"],
                "width": media["width"], "height": media["height"],
                "provider": "local", "meta": {"storageKey": media["storageKey"]},
            }
            if image.get("author"):
                # Licence attribution; PostView renders it under the photo.
                data["featured_image"]["meta"]["credit"] = {
                    "author": image["author"], "license": image["license"],
                    "licenseUrl": image.get("license_url"), "sourceUrl": image.get("commons_page"),
                }
        created = json.loads(cli(
            "content", "create", "posts", "--data", json.dumps(data, ensure_ascii=False),
            "--slug", text["slug"], "--locale", "en", "--draft", "--json", "--url", url,
        ))
        api(url, f"/_emdash/api/content/posts/{created['id']}/terms/category", {"termIds": term_ids})
        if place.get("region") in region_terms:
            api(url, f"/_emdash/api/content/posts/{created['id']}/terms/region", {"termIds": [region_terms[place["region"]]]})
        if place.get("town") in town_terms:
            api(url, f"/_emdash/api/content/posts/{created['id']}/terms/town", {"termIds": [town_terms[place["town"]]]})

        ledger.append({"place_id": place_id, "post_id": created["id"], "slug": text["slug"], "locale": "en"})
        os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
        json.dump(ledger, open(LEDGER, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    if len(args) != 4:
        sys.exit(__doc__)
    main(*args, dry_run="--dry-run" in sys.argv)
