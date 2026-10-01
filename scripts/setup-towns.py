#!/usr/bin/env python3
"""Create the `town` taxonomy (en + tr) and give posts a town.

Usage: setup-towns.py <site-url> <posts.json> <assign.json>
<assign.json> maps post id -> town key; posts not listed get "kyrenia".
"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("sr", __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "setup-regions.py"))
sr = importlib.util.module_from_spec(spec); spec.loader.exec_module(sr)

# key: (en slug, en label, tr slug, tr label)
TOWNS = {
    "kyrenia": ("kyrenia", "Kyrenia", "girne-kent", "Girne"),
    "nicosia": ("nicosia", "Nicosia", "lefkosa", "Lefkoşa"),
    "famagusta": ("famagusta", "Famagusta", "gazimagusa", "Gazimağusa"),
    "iskele": ("iskele", "İskele", "iskele", "İskele"),
    "karpaz": ("karpaz", "Karpaz", "karpaz", "Karpaz"),
    "guzelyurt": ("guzelyurt", "Güzelyurt", "guzelyurt", "Güzelyurt"),
    "limassol": ("limassol", "Limassol", "limasol", "Limasol"),
    "paphos": ("paphos", "Paphos", "baf", "Baf"),
    "larnaca": ("larnaca", "Larnaca", "larnaka", "Larnaka"),
    "ayia-napa": ("ayia-napa", "Ayia Napa", "ayia-napa", "Ayia Napa"),
    "troodos": ("troodos", "Troodos", "trodos", "Trodos"),
}

def terms(url, locale):
    return {t["slug"]: t for t in sr.api(url, f"/_emdash/api/taxonomies/town/terms?locale={locale}").get("terms", [])}

def main(url, posts_path, assign_path):
    if not sr.api(url, "/_emdash/api/taxonomies/town?locale=en"):
        print("create taxonomy town (en)")
        sr.api(url, "/_emdash/api/taxonomies", {"name": "town", "label": "Towns", "labelSingular": "Town",
                                                "hierarchical": False, "collections": ["posts"], "locale": "en"})
    trd = sr.api(url, "/_emdash/api/taxonomies/town?locale=tr")
    if not trd or trd.get("locale") != "tr":
        print("create taxonomy town (tr)")
        sr.api(url, "/_emdash/api/taxonomies", {"name": "town", "label": "Şehirler", "labelSingular": "Şehir", "locale": "tr"})
    en = terms(url, "en")
    for key, (es, el, ts, tl) in TOWNS.items():
        if es not in en:
            print("create term", es); sr.api(url, "/_emdash/api/taxonomies/town/terms", {"slug": es, "label": el, "locale": "en"})
    en = terms(url, "en"); tr = terms(url, "tr")
    for key, (es, el, ts, tl) in TOWNS.items():
        if ts not in tr:
            print("create term", ts, "(tr)")
            sr.api(url, "/_emdash/api/taxonomies/town/terms", {"slug": ts, "label": tl, "locale": "tr", "translationOf": en[es]["id"]})
    rows = json.load(open(posts_path)); rows = rows[0]["results"] if "results" in rows[0] else rows
    assign = json.load(open(assign_path))
    n = 0
    for row in rows:
        path = f"/_emdash/api/content/posts/{row['id']}/terms/town"
        if sr.api(url, path).get("terms"):
            continue
        key = assign.get(row["id"], "kyrenia")
        sr.api(url, path, {"termIds": [en[TOWNS[key][0]]["id"]]}); n += 1
    print(n, "posts got a town")

if __name__ == "__main__":
    main(*sys.argv[1:])
