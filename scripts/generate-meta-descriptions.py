#!/usr/bin/env python3
"""Generate SQL that fills in missing meta descriptions from each entry's text.

Most English posts (and some Turkish ones) had no Yoast description, so
search engines saw no meta description at all. This derives one per entry:

- Prose entries: the opening sentences, up to 155 characters, cut at a
  sentence or word boundary.
- Listing entries (just "Address: … Phone: …" lines): "{title}: {address}.
  Phone: {phone}." in the entry's language.

Only entries with no SEO description and no excerpt get one; existing SEO
titles and descriptions are never changed.

Usage:
    pnpm wrangler d1 execute guidecyprus --remote --json --command "\\
        SELECT 'posts' AS collection, p.id, p.locale, p.title, p.content FROM ec_posts p \\
        LEFT JOIN _emdash_seo s ON s.collection = 'posts' AND s.content_id = p.id \\
        WHERE p.deleted_at IS NULL AND COALESCE(s.seo_description, '') = '' AND COALESCE(p.excerpt, '') = '' \\
        UNION ALL \\
        SELECT 'pages', p.id, p.locale, p.title, p.content FROM ec_pages p \\
        LEFT JOIN _emdash_seo s ON s.collection = 'pages' AND s.content_id = p.id \\
        WHERE p.deleted_at IS NULL AND COALESCE(s.seo_description, '') = '' AND COALESCE(p.excerpt, '') = ''" \\
        > missing.json
    python3 scripts/generate-meta-descriptions.py missing.json > descriptions.sql
    pnpm wrangler d1 execute guidecyprus --remote --file descriptions.sql
"""

import json
import re
import sys

MAX_LENGTH = 155
# Sentence cuts shorter than this (e.g. stopping at "Hz.") fall back to a word cut.
MIN_SENTENCE_CUT = 70
LABELS = (
    r"Address|Adres|Phone Number|Phone|Telefon|Tel|Facebook|Instagram|Foursquare"
    r"|Twitter|Website|Web|E-?mail|Mail"
)
FIELD = re.compile(rf"\b({LABELS})\s*:\s*(.*?)(?=\b(?:{LABELS})\s*:|$)", re.I)
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
PHONE_LABEL = {"en": "Phone", "tr": "Telefon"}


def d1_rows(path: str) -> list[dict]:
    data = json.load(open(path, encoding="utf-8"))
    return data[0]["results"] if isinstance(data, list) and data and "results" in data[0] else data


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def plain_text(content: str | None) -> str:
    blocks = json.loads(content or "[]")
    text = " ".join(
        span.get("text", "")
        for block in blocks
        if block.get("_type") == "block"
        for span in block.get("children", [])
    )
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def clip(text: str) -> str:
    if len(text) <= MAX_LENGTH:
        return text
    kept = ""
    for sentence in SENTENCE_END.split(text):
        candidate = f"{kept} {sentence}".strip()
        if len(candidate) > MAX_LENGTH:
            break
        kept = candidate
    if len(kept) >= MIN_SENTENCE_CUT:
        return kept
    cut = text[: MAX_LENGTH - 1].rsplit(" ", 1)[0].rstrip(",;:-–")
    return f"{cut}…"


def describe(title: str, text: str, locale: str) -> str | None:
    fields = {m.group(1).lower(): m.group(2).strip(" ,") for m in FIELD.finditer(text)}
    is_listing = bool(fields) and FIELD.match(text) is not None
    if not is_listing:
        return clip(text) if text else None
    parts = []
    address = fields.get("address") or fields.get("adres")
    phone = fields.get("phone number") or fields.get("phone") or fields.get("telefon") or fields.get("tel")
    head = f"{title}: {address.rstrip('.')}." if address else f"{title}."
    parts.append(head)
    if phone:
        parts.append(f"{PHONE_LABEL.get(locale, 'Phone')}: {phone}.")
    return clip(" ".join(parts))


def main(path: str) -> None:
    statements, skipped = [], 0
    for row in d1_rows(path):
        description = describe(row["title"] or "", plain_text(row["content"]), row["locale"])
        if not description:
            skipped += 1
            continue
        statements.append(
            "INSERT INTO _emdash_seo (collection, content_id, seo_description) "
            f"VALUES ({sql_str(row['collection'])}, {sql_str(row['id'])}, {sql_str(description)}) "
            "ON CONFLICT (collection, content_id) DO UPDATE SET seo_description = excluded.seo_description "
            "WHERE COALESCE(_emdash_seo.seo_description, '') = '';"
        )
    print("\n".join(statements))
    print(f"{len(statements)} descriptions, {skipped} entries without text", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
