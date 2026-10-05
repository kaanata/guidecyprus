#!/usr/bin/env python3
"""Add reviewed venue photos to place posts, as draft revisions.

Reads the photo review output (one folder per English place under
<photos-dir>/out2/<slug>/ with manifest.json and review.json, plus
<photos-dir>/inventory.json) and for each place with kept photos:

- uploads each kept file once to the media library;
- if the post has no featured image, sets the reviewed `featured` photo
  (never a 640px Instagram file) with its credit in meta.credit;
- with 3 or more full-size photos left, puts them in the `gallery` field
  (max 12) as {image, credit, source_url}; with fewer, puts every photo in the
  body as Portable Text image blocks after the first paragraph. 640px
  Instagram files always go in the body;
- skips a kept photo that is already the post's featured image (same
  Wikimedia Commons page) and never repeats the new featured photo.

The Turkish translation of a place gets the same media items (no second
upload) with Turkish captions. Every change is a PUT to the content API, which
on a published post stages a draft and leaves the live version alone; nothing
is published. Posts are addressed by ID (en and tr share slugs).

Progress is kept in <photos-dir>/upload-ledger.json (slug -> media IDs and a
done flag per post), so a rerun never uploads a file twice or edits a post
again.

Usage:
    python3 scripts/upload-place-photos.py <photos-dir> <site-url> [--only slug,slug] [--dry-run]
"""

import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "guidecyprus-scripts/1.0"
GALLERY_MIN = 3
GALLERY_MAX = 12

SOURCE_LABEL = {
    "en": {"website": "website", "instagram": "Instagram", "facebook": "Facebook", "wikimedia": "Wikimedia Commons"},
    "tr": {"website": "web sitesi", "instagram": "Instagram", "facebook": "Facebook", "wikimedia": "Wikimedia Commons"},
}
PHOTO_WORD = {"en": "Photo", "tr": "Fotoğraf"}
# First words of the facts block ("Address: ...") in imported and new posts.
FACT_LABELS = ("address", "adres", "phone", "telefon", "tel", "website", "web sitesi", "map", "harita")


def cli(*args: str) -> str:
    result = subprocess.run(["npx", "emdash", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


_token = {"value": None, "at": 0.0}


def token(url: str) -> str:
    if not _token["value"] or time.time() - _token["at"] > 300:
        cli("whoami", "--url", url)  # refreshes a stale access token
        auth = json.load(open(os.path.expanduser("~/.config/emdash/auth.json"), encoding="utf-8"))
        _token.update(value=auth[url]["accessToken"], at=time.time())
    return _token["value"]


def api(url: str, method: str, path: str, body: dict | None = None) -> dict:
    headers = {"Authorization": "Bearer " + token(url), "User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if body is not None:
        headers.update({"Content-Type": "application/json", "X-EmDash-Request": "1"})
        data = json.dumps(body, ensure_ascii=False).encode()
    request = urllib.request.Request(url + "/_emdash/api" + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)["data"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode(errors='replace')[:300]}") from None


def key() -> str:
    return secrets.token_hex(5)


def same_page(a: str | None, b: str | None) -> bool:
    return bool(a and b) and urllib.parse.unquote(a).rstrip("/") == urllib.parse.unquote(b).rstrip("/")


def venue_name(photo: dict) -> str:
    """'Photo: Rocks Hotel (website)' -> 'Rocks Hotel'."""
    text = photo["credit"].removeprefix("Photo:").strip()
    if text.endswith(")") and " (" in text:
        text = text[: text.rindex(" (")]
    return text


def credit_object(photo: dict) -> dict:
    if photo["source"] == "wikimedia":
        return {"author": photo["author"], "license": photo["license"],
                "licenseUrl": photo.get("license_url"), "sourceUrl": photo["source_url"]}
    return {"owner": venue_name(photo), "url": photo["source_url"]}


def credit_text(photo: dict) -> str:
    if photo["source"] == "wikimedia":
        return f"{photo['author']}, {photo['license']}"
    return venue_name(photo)


def caption(photo: dict, locale: str) -> str:
    return f"{PHOTO_WORD[locale]}: {credit_text(photo)} ({SOURCE_LABEL[locale][photo['source']]})"


def image_value(media: dict, alt: str) -> dict:
    return {"provider": "local", "id": media["id"], "alt": alt, "width": media["width"],
            "height": media["height"], "mimeType": media["mimeType"],
            "meta": {"storageKey": media["storageKey"]}}


def body_block(media: dict, photo: dict, alt: str, locale: str) -> dict:
    return {
        "_type": "image", "_key": key(),
        "asset": {"_ref": media["id"], "url": f"/_emdash/api/media/file/{media['storageKey']}"},
        "alt": alt, "width": media["width"], "height": media["height"],
        "credit": credit_object(photo), "caption": caption(photo, locale),
        "link": {"href": photo["source_url"], "blank": True},
    }


def is_facts(block: dict) -> bool:
    if block.get("_type") != "block":
        return False
    text = "".join(c.get("text", "") for c in block.get("children", [])).strip().lower()
    return any(text.startswith(label) and text[len(label):].lstrip().startswith(":") for label in FACT_LABELS)


def insert_index(content: list[dict]) -> int:
    """After the first paragraph; before the facts block if that comes first."""
    for i, block in enumerate(content):
        if block.get("_type") != "block":
            continue
        if is_facts(block):
            return i
        if block.get("style", "normal") == "normal" and "".join(c.get("text", "") for c in block.get("children", [])).strip():
            return i + 1
    return len(content)


def current(url: str, post_id: str) -> tuple[dict, dict, str]:
    """The post, its data (the pending draft's when there is one) and _rev."""
    got = api(url, "GET", f"/content/posts/{post_id}")
    item, data = got["item"], got["item"]["data"]
    if item.get("draftRevisionId"):
        comparison = api(url, "GET", f"/content/posts/{post_id}/compare")
        if comparison.get("draft"):
            data = comparison["draft"]
    return item, data, got.get("_rev")


def has_featured(data: dict) -> bool:
    image = data.get("featured_image")
    return bool(image and (image.get("id") or image.get("src")))


def plan(slug: str, photos: dict, review: dict, featured_url: str | None, has_image: bool) -> dict:
    """Which file becomes the featured image, which go in gallery, which in the body."""
    small = set(review.get("small") or [])
    keep = [f for f in review["keep"] if not same_page(photos[f]["source_url"], featured_url)]
    featured = None
    if not has_image and review.get("featured") in keep and review["featured"] not in small:
        featured = review["featured"]
    rest = [f for f in keep if f != featured]
    full = [f for f in rest if f not in small]
    if len(full) >= GALLERY_MIN:
        return {"featured": featured, "gallery": full[:GALLERY_MAX], "body": [f for f in rest if f in small]}
    return {"featured": featured, "gallery": [], "body": rest}


def save(ledger_path: str, ledger: dict) -> None:
    tmp = ledger_path + ".tmp"
    json.dump(ledger, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, ledger_path)


def main(photos_dir: str, url: str, only: set[str] | None, dry_run: bool) -> None:
    inventory = {p["slug"]: p for p in json.load(open(os.path.join(photos_dir, "inventory.json"), encoding="utf-8"))}
    ledger_path = os.path.join(photos_dir, "upload-ledger.json")
    ledger = json.load(open(ledger_path, encoding="utf-8")) if os.path.exists(ledger_path) else {}
    failures = []

    for slug in sorted(os.listdir(os.path.join(photos_dir, "out2"))):
        folder = os.path.join(photos_dir, "out2", slug)
        review_path = os.path.join(folder, "review.json")
        if not os.path.isfile(review_path) or (only and slug not in only):
            continue
        review = json.load(open(review_path, encoding="utf-8"))
        if not review.get("keep"):
            continue
        place = inventory[slug]
        photos = {p["file"]: p for p in json.load(open(os.path.join(folder, "manifest.json"), encoding="utf-8"))}
        entry = ledger.setdefault(slug, {"media": {}, "posts": {}})
        posts = [("en", place["post_id"])] + ([("tr", place["tr"]["id"])] if place.get("tr") else [])
        if all(entry["posts"].get(pid, {}).get("done") for _, pid in posts):
            print(f"skip {slug}: done", flush=True)
            continue

        try:
            for locale, post_id in posts:
                if entry["posts"].get(post_id, {}).get("done"):
                    continue
                item, data, rev = current(url, post_id)
                if item["locale"] != locale:
                    raise RuntimeError(f"{post_id} is {item['locale']}, expected {locale}")
                featured_url = (((data.get("featured_image") or {}).get("meta") or {}).get("credit") or {}).get("sourceUrl")
                if not featured_url and locale == "en":
                    featured_url = ((place.get("featured") or {}).get("credit") or {}).get("sourceUrl")
                layout = plan(slug, photos, review, featured_url, has_featured(data))
                title = data.get("title") or place["title"]
                print(f"{'would update' if dry_run else 'update'} {slug} [{locale} {post_id}]: "
                      f"featured={layout['featured'] or '-'} gallery={len(layout['gallery'])} body={len(layout['body'])}", flush=True)
                if dry_run:
                    continue
                if not (layout["featured"] or layout["gallery"] or layout["body"]):
                    entry["posts"][post_id] = {"locale": locale, "done": True, "skipped": "no new photos"}
                    save(ledger_path, ledger)
                    continue

                # Upload once per file; reused by the translation and on reruns.
                for file in filter(None, [layout["featured"], *layout["gallery"], *layout["body"]]):
                    if file not in entry["media"]:
                        media = json.loads(cli("media", "upload", os.path.join(folder, file),
                                               "--alt", place["title"], "--json", "--url", url))
                        entry["media"][file] = {k: media[k] for k in ("id", "storageKey", "width", "height", "mimeType")}
                        save(ledger_path, ledger)
                media = entry["media"]

                update: dict = {}
                if layout["featured"]:
                    photo = photos[layout["featured"]]
                    image = image_value(media[layout["featured"]], title)
                    image["meta"]["credit"] = credit_object(photo)
                    update["featured_image"] = image
                if layout["gallery"]:
                    update["gallery"] = [
                        {"image": image_value(media[f], title), "credit": credit_text(photos[f]),
                         "source_url": photos[f]["source_url"]}
                        for f in layout["gallery"]
                    ]
                if layout["body"]:
                    content = list(data.get("content") or [])
                    at = insert_index(content)
                    content[at:at] = [body_block(media[f], photos[f], title, locale) for f in layout["body"]]
                    update["content"] = content

                body = {"data": update}
                if rev:
                    body["_rev"] = rev
                api(url, "PUT", f"/content/posts/{post_id}", body)
                entry["posts"][post_id] = {"locale": locale, "done": True, "featured": layout["featured"],
                                           "gallery": layout["gallery"], "body": layout["body"]}
                save(ledger_path, ledger)
        except Exception as error:  # keep going; the ledger records what finished
            print(f"FAIL {slug}: {error}", flush=True)
            failures.append(slug)

    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    only = None
    if "--only" in argv:
        i = argv.index("--only")
        only = set(argv[i + 1].split(","))
        del argv[i:i + 2]
    args = [a for a in argv if a != "--dry-run"]
    if len(args) != 2:
        sys.exit(__doc__)
    main(args[0], args[1].rstrip("/"), only, dry_run="--dry-run" in argv)
