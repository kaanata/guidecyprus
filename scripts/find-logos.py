#!/usr/bin/env python3
"""Find each place's logo on its official website, with camoufox.

For every place with a website (social-media profiles are skipped: their
terms forbid automated collection), the page is rendered and the logo is
picked in this order: the schema.org `logo` the site declares, the theme's
logo image (`custom-logo`, or a header image whose src/class/alt/id says
"logo"), then a large apple-touch-icon. The winner is downloaded; SVG logos
are rasterised to PNG on a white ground.

Large photos on the page are only listed (URL, size), for a permission
request to the venue: they are copyrighted and are not downloaded.

Crawling runs only through a proxy: set PROXY_URL (e.g.
http://user:pass@host:port) in the environment or .env. Without it the
script refuses to run, so venue sites are never fetched from the server's
own IP.

Usage:
    python3 scripts/find-logos.py <details.json> <out-dir>

Writes <out-dir>/<place_id>.<ext> and <out-dir>/logos.json.
"""

import json
import os
import re
import sys
from urllib.parse import unquote, urlparse

from camoufox.sync_api import Camoufox

SOCIAL = ("facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com")

COLLECT = """() => {
  const abs = u => { try { return new URL(u, location.href).href } catch { return null } };
  const out = { ld: [], imgs: [], icons: [], svgs: [] };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o.logo) out.ld.push(abs(typeof o.logo === 'string' ? o.logo : (o.logo.url || o.logo.contentUrl)));
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  for (const img of document.images) {
    const hay = [img.currentSrc || img.src, img.alt, img.className, img.id,
      img.closest('[class*="logo" i],[id*="logo" i]') ? 'logo-ancestor' : ''].join(' ');
    out.imgs.push({
      src: abs(img.currentSrc || img.src), w: img.naturalWidth, h: img.naturalHeight,
      logo: /logo/i.test(hay), custom: img.classList.contains('custom-logo'),
      header: !!img.closest('header, nav, [class*="header" i], [id*="header" i]'),
    });
  }
  for (const l of document.querySelectorAll('link[rel*="icon"]')) {
    out.icons.push({ href: abs(l.href), rel: l.rel, sizes: l.sizes ? String(l.sizes) : '' });
  }
  for (const svg of document.querySelectorAll('[class*="logo" i] svg, svg[class*="logo" i], svg[id*="logo" i]')) {
    const r = svg.getBoundingClientRect();
    if (r.width > 40) out.svgs.push(svg.outerHTML);
  }
  return out;
}"""


def proxy_settings() -> dict:
    url = os.environ.get("PROXY_URL")
    if not url:
        env = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env):
            for line in open(env, encoding="utf-8"):
                if line.startswith("PROXY_URL="):
                    url = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not url:
        sys.exit("PROXY_URL is not set: crawling from the server's own IP is not allowed.")
    parsed = urlparse(url)
    proxy = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        proxy.update(username=unquote(parsed.username), password=unquote(parsed.password or ""))
    return proxy


def icon_size(icon: dict) -> int:
    match = re.search(r"(\d+)x\d+", icon.get("sizes") or "")
    if match:
        return int(match.group(1))
    return 180 if "apple-touch" in icon["rel"] else 0


def pick(found: dict) -> tuple[str, str] | None:
    """Return (kind, url-or-svg) for the best logo candidate."""
    for url in found["ld"]:
        if url and not url.startswith("data:"):
            return ("schema-logo", url)
    imgs = [i for i in found["imgs"] if i["src"] and i["w"] >= 60]
    for test, kind in (
        (lambda i: i["custom"], "custom-logo"),
        (lambda i: i["logo"] and i["header"], "header-logo"),
        (lambda i: i["logo"], "logo-image"),
    ):
        hits = [i for i in imgs if test(i)]
        if hits:
            return (kind, max(hits, key=lambda i: i["w"])["src"])
    if found["svgs"]:
        return ("inline-svg", found["svgs"][0])
    icons = sorted((i for i in found["icons"] if icon_size(i) >= 120), key=icon_size, reverse=True)
    if icons:
        return ("touch-icon", icons[0]["href"])
    return None


def extension(content_type: str, url: str) -> str:
    for mime, ext in (("svg", "svg"), ("png", "png"), ("webp", "webp"), ("jpeg", "jpg"), ("jpg", "jpg"), ("gif", "gif")):
        if mime in (content_type or "") or url.lower().split("?")[0].endswith("." + ext):
            return ext
    return "png"


def rasterise(page, svg_markup: str, path: str) -> None:
    page.set_content(
        '<html><body style="margin:0;background:#fff">'
        f'<div id="l" style="display:inline-block;padding:24px;background:#fff">{svg_markup}</div></body></html>'
    )
    page.evaluate("""() => { const s = document.querySelector('#l svg');
      if (s && !s.getAttribute('width')) { s.style.width = '480px'; s.style.height = 'auto'; } }""")
    page.locator("#l").screenshot(path=path)


def main(details_path: str, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    places = json.load(open(details_path, encoding="utf-8"))
    results = []
    with Camoufox(headless=True, proxy=proxy_settings()) as browser:
        page = browser.new_page()
        for place in places:
            site = place["details"].get("websiteUri")
            result = {"place_id": place["place_id"], "name": place["name"], "website": site}
            results.append(result)
            if not site:
                result["status"] = "no website"
                continue
            if urlparse(site).netloc.lower().removeprefix("www.").removeprefix("m.") in SOCIAL:
                result["status"] = "social profile, skipped"
                continue
            try:
                page.goto(site, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2500)
                found = page.evaluate(COLLECT)
            except Exception as error:  # timeouts, TLS, DNS
                result["status"] = f"load failed: {str(error).splitlines()[0][:120]}"
                print(f"{place['name']}: {result['status']}", flush=True)
                continue
            result["photos"] = [
                {"src": i["src"], "w": i["w"], "h": i["h"]}
                for i in found["imgs"] if i["src"] and i["w"] >= 800 and not i["logo"]
            ][:12]
            choice = pick(found)
            if not choice:
                result["status"] = "no logo found"
                print(f"{place['name']}: {result['status']}", flush=True)
                continue
            kind, value = choice
            result["kind"] = kind
            try:
                if kind == "inline-svg":
                    path = os.path.join(out_dir, place["place_id"] + ".png")
                    rasterise(page, value, path)
                else:
                    response = page.request.get(value, timeout=30000)
                    if not response.ok:
                        result["status"] = f"logo download HTTP {response.status}"
                        print(f"{place['name']}: {result['status']}", flush=True)
                        continue
                    ext = extension(response.headers.get("content-type", ""), value)
                    path = os.path.join(out_dir, place["place_id"] + "." + ext)
                    if ext == "svg":
                        path = path[:-3] + "png"
                        rasterise(page, response.text(), path)
                    else:
                        open(path, "wb").write(response.body())
                    result["source"] = value
                result["file"] = path
                result["status"] = "ok"
            except Exception as error:
                result["status"] = f"logo save failed: {str(error).splitlines()[0][:120]}"
            print(f"{place['name']}: {result['status']} ({result.get('kind', '-')})", flush=True)
    json.dump(results, open(os.path.join(out_dir, "logos.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{sum(1 for r in results if r.get('status') == 'ok')} logos saved of {len(results)} places")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
