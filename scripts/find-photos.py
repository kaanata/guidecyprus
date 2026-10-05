#!/usr/bin/env python3
"""Collect venue-owned photos for each place, for review before upload.

Sources, in order, until a place has --max photos (default 8):

1. Google Places (New) photos uploaded by the venue itself. Place Details
   with field mask `photos` lists up to 10 photos with their author. An
   owner upload carries the business's own Google account, so its author
   displayName matches the place name (`is_owner()`: the place's distinctive
   words, ignoring generic ones like "Restaurant" or a village name, all
   appear in the author's name, or the reverse, or one squashed name
   contains the other). The author link is a maps/contrib profile, never
   the place's own Maps URL, so it can't be used as a signal. Everyone
   else's photos are user contributions and are rejected. Downloaded
   through the Place Photo media endpoint (maxWidthPx=1600).
2. If that gives fewer than 3: the venue's own website (Places websiteUri),
   rendered with camoufox through a proxy, plus its gallery page if it
   links one: large content images (srcset/lazy/background images and
   og:image), dropping logos, icons, maps, badges, team/staff pictures,
   stock, theme-demo and third-party (booking/review/delivery) images
   (5-minute budget per site). Skipped for historical sites (their
   "website" is a ministry or guide page) and banks (corporate marketing
   images); a site shared by several places (a chain) is flagged in the
   manifest because its photos may show another branch. Then the
   official Instagram/Facebook profiles linked from the site or the post
   (never Instagram "location" pages, which show visitors' photos), logged
   out: Instagram post images, Facebook og:image. A login wall is recorded
   as `social_blocked` and skipped. Logged out, Instagram serves 640 px
   images, below the 1000 px floor: --social-min-width 640 keeps them.
3. For public places (historical sites, beaches, landmarks, parks, places
   of worship) that still have fewer than 3: Wikimedia Commons photos near
   the place or named after it, CC BY / CC BY-SA / CC0 / public domain only,
   with author, licence and file page recorded.

Every image is checked after download: at least 1000 px wide at the
source, not a flat graphic (logo, text card, delivery banner), not mostly
transparent, not a near-duplicate of one already kept (64-bit dHash), then
re-encoded as JPEG (long edge at most 1600 px, EXIF dropped).

Crawling runs only through a proxy: --proxy-line N takes line N (0-based)
of the credentials file (user:pass@host:port per line; use a different N
for each parallel run), or PROXY_URL is read from the environment / .env.
Without one the script refuses to run. Google Places and Wikimedia Commons
are official APIs and are called directly. Nothing is written to the CMS.

Usage:
    python3 scripts/find-photos.py <inventory.json> <out-dir> --proxy-line N \\
        [--start I] [--end J] [--slugs a,b,c] [--max 8] [--social-min-width W] [--no-google] [--no-web]

Writes <out-dir>/<slug>/NN.jpg, <out-dir>/<slug>/manifest.json
([{file, source, source_url, image_url, credit, width, height, sha1, ...}])
and <out-dir>/<slug>/report.json (what was tried, rejections, blocks).
Slugs whose manifest.json exists are skipped, so a run can be resumed.
"""

import argparse
import hashlib
import html
import importlib.util
import io
import json
import os
import re
import sys
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS = "/home/predictions-project/proxy-2340833-credentials.txt"
USER_AGENT = "guidecyprus-scripts/1.0 (https://guidecyprus.com; photo credits)"
MIN_WIDTH = 1000
LONG_EDGE = 1600
SOCIAL = ("facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com")

# ---------------------------------------------------------------- owner test

GENERIC = set("""
the and a an of de la le el by co ltd official
restaurant restaurants restoran restorant hotel hotels otel resort resorts spa casino cafe cafes coffee kahve
bar bars pub lounge beach plaj club kulup bistro brasserie bakery fish balik meyhane taverna tavern kitchen
grill house bank bankasi atm sube subesi branch
kktc girne kyrenia cyprus kibris north northern trnc nicosia lefkosa limassol paphos larnaca famagusta magusa
gazimagusa ayia napa iskele karpaz guzelyurt troodos bellapais beylerbeyi lapta lapithos alsancak karavas
catalkoy esentepe karaoglanoglu ozankoy karsiyaka dogankoy bogaz bafra edremit zeytinlik karmi ilgaz tatlisu
kayalar protaras polis latchi
""".split())


def words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", (text or "").replace("ı", "i")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).split()


def is_owner(venue: str, author: str) -> bool:
    """True when a photo author's name is the venue's own name."""
    tv, ta = words(venue), words(author)
    if not tv or not ta:
        return False
    dv = [t for t in tv if t not in GENERIC and len(t) >= 3]
    da = [t for t in ta if t not in GENERIC and len(t) >= 3]
    if not dv:
        return tv == ta
    if set(dv) <= set(ta):
        return True
    if da and set(da) <= set(tv) and len("".join(da)) >= 5:
        return True
    cv, ca = "".join(dv), "".join(da)
    return len(cv) >= 6 and len(ca) >= 6 and (cv in ca or ca in cv)


# ---------------------------------------------------------------- images

class Rejected(Exception):
    pass


def dhash(img: Image.Image) -> int:
    small = img.convert("L").resize((9, 8), Image.LANCZOS)
    px = list(small.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (px[row * 9 + col] > px[row * 9 + col + 1])
    return bits


def graphic_score(img: Image.Image) -> tuple[float, int]:
    """(share of flat pixels, distinct colours) on a 128 px thumbnail.

    Photos have sensor noise and gradients nearly everywhere; logos, text
    cards and banners are large areas of one exact colour with few colours.
    """
    small = img.convert("RGB").resize((128, 128), Image.BILINEAR)
    px = small.load()
    flat = 0
    for y in range(127):
        for x in range(127):
            a, b, c = px[x, y], px[x + 1, y], px[x, y + 1]
            if sum(abs(a[i] - b[i]) + abs(a[i] - c[i]) for i in range(3)) <= 3:
                flat += 1
    colours = len(set((r >> 3, g >> 3, b >> 3) for r, g, b in small.getdata()))
    return flat / (127 * 127), colours


def process(data: bytes, seen: list[int], min_width: int = MIN_WIDTH) -> tuple[bytes, int, int, int, int]:
    """Validate and re-encode one image. Returns (jpeg, w, h, source_w, hash)."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as error:
        raise Rejected(f"not an image ({type(error).__name__})")
    img = ImageOps.exif_transpose(img)
    w, h = img.size
    if w < min_width:
        raise Rejected(f"too small {w}x{h}")
    ratio = w / h
    if ratio > 2.5 or ratio < 0.45:
        raise Rejected(f"strip/banner shape {w}x{h}")
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        alpha = img.convert("RGBA").getchannel("A")
        clear = sum(1 for a in alpha.resize((64, 64)).getdata() if a < 250)
        if clear > 64 * 64 * 0.02:
            raise Rejected("transparent (cut-out or logo)")
    img = img.convert("RGB")
    flat, colours = graphic_score(img)
    # Kept photos measured 0.04-0.17 flat and 490+ colours; logos and text cards sit far beyond.
    if flat > 0.45 or colours < 250 or (flat > 0.25 and colours < 600):
        raise Rejected(f"graphic (flat {flat:.2f}, colours {colours})")
    digest = dhash(img)
    for other in seen:
        if bin(digest ^ other).count("1") <= 10:
            raise Rejected("near-duplicate")
    if max(w, h) > LONG_EDGE:
        img.thumbnail((LONG_EDGE, LONG_EDGE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=86, optimize=True, progressive=True)
    return out.getvalue(), img.width, img.height, w, digest


# ---------------------------------------------------------------- config

def env_value(var: str) -> str | None:
    value = os.environ.get(var)
    env = os.path.join(HERE, "..", ".env")
    if not value and os.path.exists(env):
        for line in open(env, encoding="utf-8"):
            if line.startswith(var + "="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
    return value


def proxy_settings(line: int | None) -> dict:
    if line is not None:
        lines = [l.strip() for l in open(CREDENTIALS, encoding="utf-8") if l.strip()]
        if not 0 <= line < len(lines):
            sys.exit(f"--proxy-line must be 0..{len(lines) - 1}")
        url = "http://" + lines[line]
    else:
        url = env_value("PROXY_URL")
    if not url:
        sys.exit("No proxy: pass --proxy-line N or set PROXY_URL. Crawling from the server's own IP is not allowed.")
    parsed = urllib.parse.urlparse(url)
    proxy = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        proxy.update(username=urllib.parse.unquote(parsed.username), password=urllib.parse.unquote(parsed.password or ""))
    return proxy


# ---------------------------------------------------------------- Google

def google_owner_photos(key: str, item: dict, want: int, seen: list[int], log: dict) -> list[tuple[dict, bytes]]:
    pid = item.get("place_id")
    if not pid:
        log["google"] = "no place_id"
        return []
    request = urllib.request.Request(
        f"https://places.googleapis.com/v1/places/{pid}",
        headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": "displayName,googleMapsUri,photos"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            details = json.load(response)
    except urllib.error.HTTPError as error:
        log["google"] = f"details HTTP {error.code}"
        return []
    name = (details.get("displayName") or {}).get("text") or item.get("google_name") or ""
    maps = details.get("googleMapsUri") or item.get("maps_url")
    photos = details.get("photos", [])
    owners, others = [], 0
    for photo in photos:
        author = (photo.get("authorAttributions") or [{}])[0]
        if is_owner(name, author.get("displayName", "")) or is_owner(item["title"], author.get("displayName", "")):
            owners.append((photo, author))
        else:
            others += 1
    log["google"] = {"photos": len(photos), "owner": len(owners), "user_rejected": others,
                     "owner_names": sorted({a.get("displayName") for _, a in owners})}
    out = []
    for photo, author in owners:
        if len(out) >= want:
            break
        if photo.get("widthPx", 0) < MIN_WIDTH:
            log.setdefault("rejected", []).append({"source": "google_owner", "url": photo["name"], "why": f"too small {photo.get('widthPx')}"})
            continue
        media = urllib.request.Request(
            f"https://places.googleapis.com/v1/{photo['name']}/media?maxWidthPx={LONG_EDGE}",
            headers={"X-Goog-Api-Key": key, "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(media, timeout=60) as response:
                data = response.read()
            jpeg, w, h, sw, digest = process(data, seen)
        except Rejected as why:
            log.setdefault("rejected", []).append({"source": "google_owner", "url": photo["name"], "why": str(why)})
            continue
        except Exception as error:
            log.setdefault("errors", []).append(f"google media: {type(error).__name__}")
            continue
        seen.append(digest)
        out.append(({"source": "google_owner", "source_url": maps, "image_url": photo["name"],
                     "author": author.get("displayName"), "author_uri": author.get("uri"),
                     "credit": f"Photo: {author.get('displayName')} (Google Maps)",
                     "width": w, "height": h, "source_width": sw, "dhash": f"{digest:016x}"}, jpeg))
    return out


# ---------------------------------------------------------------- website / social

COLLECT = """() => {
  const abs = u => { try { return new URL(u, location.href).href } catch { return null } };
  const best = set => {
    if (!set) return null;
    let top = null, topW = 0;
    for (const part of set.split(/,\\s+(?=\\S)/)) {
      const [u, d] = part.trim().split(/\\s+/);
      const w = d && d.endsWith('w') ? parseInt(d) : (d && d.endsWith('x') ? parseFloat(d) * 1000 : 1);
      if (w >= topW) { top = u; topW = w; }
    }
    return top ? [abs(top), topW] : null;
  };
  const ctx = el => {
    const parts = [];
    for (let n = el, i = 0; n && i < 6; n = n.parentElement, i++) parts.push(n.id || '', typeof n.className === 'string' ? n.className : '');
    return parts.join(' ');
  };
  const out = { imgs: [], og: [], links: [], gallery: [] };
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const cands = [];
    const s1 = best(img.getAttribute('srcset') || img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset'));
    if (s1) cands.push(s1);
    for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-large_image', 'data-full', 'data-orig-file']) {
      const v = img.getAttribute(a); if (v) cands.push([abs(v), 0]);
    }
    cands.push([abs(img.currentSrc || img.src), img.naturalWidth]);
    const p = img.closest('picture');
    if (p) for (const s of p.querySelectorAll('source')) { const b = best(s.getAttribute('srcset')); if (b) cands.push(b); }
    out.imgs.push({ cands, nw: img.naturalWidth, nh: img.naturalHeight, rw: r.width, alt: img.alt || '',
      cls: (img.className || '') + ' ' + (img.id || ''), ctx: ctx(img),
      chrome: !!img.closest('header, nav, footer'),
      link: (img.closest('a') || {}).href || '' });
  }
  for (const el of document.querySelectorAll('div, section, figure, a, li, span')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 500 || r.height < 250) continue;
    for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g))
      out.imgs.push({ cands: [[abs(m[1]), 0]], nw: 0, nh: 0, rw: r.width, alt: '', cls: el.className || '', ctx: ctx(el), chrome: !!el.closest('header, nav, footer'), bg: true });
  }
  for (const m of document.querySelectorAll('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]'))
    if (m.content) out.og.push(abs(m.content));
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href;
    if (/instagram\\.com|facebook\\.com/i.test(h)) out.links.push(h);
    const t = (a.textContent || '') + ' ' + h;
    if (/galler|galeri|photos|fotograf|foto\\b/i.test(t) && new URL(h, location.href).host === location.host) out.gallery.push(h);
  }
  return out;
}"""

SCROLL = """async () => {
  for (let y = 0; y < Math.min(document.body.scrollHeight, 14000); y += 700) {
    window.scrollTo(0, y); await new Promise(r => setTimeout(r, 180));
  }
  window.scrollTo(0, 0);
}"""

def word_re(words: tuple) -> re.Pattern:
    return re.compile(r"(?<![a-z])(" + "|".join(words) + r")(?![a-z])", re.I)


# Words in an image's file path, alt text or own class that mean "not a venue photo".
BAD_WORDS = word_re((
    r"logo\w*", r"icons?", r"favicon", r"sprite", r"maps?", r"marker", r"pin", r"avatar", r"flags?", r"badges?",
    r"awards?", r"certificat\w*", r"travellers?-?choice", r"tripadvisor", r"booking", r"trivago", r"expedia",
    r"holidaycheck", r"hotels?com", r"payment", r"visa", r"mastercard", r"paypal", r"qr", r"placeholder", r"dummy",
    r"blank", r"loader", r"spinner", r"team", r"staff", r"chef", r"manager", r"founder", r"ceo",
    r"owner", r"portrait", r"headshot", r"testimonials?", r"reviews?", r"author", r"profile", r"signature",
    r"yemeksepeti", r"getir", r"trendyol", r"wolt", r"foodpanda", r"deliveroo", r"ubereats", r"glovo",
    r"app-?store", r"google-?play", r"unsplash", r"pexels", r"shutterstock", r"istock\w*",
    r"gettyimages", r"pixabay", r"depositphotos", r"freepik", r"adobestock", r"stock", r"dreamstime",
    r"whatsapp", r"telegram", r"emoji", r"pattern", r"texture", r"divider", r"separator", r"coming-?soon",
    r"banner", r"poster", r"flyer", r"afis", r"menu", r"campaign", r"kampanya", r"promo\w*", r"discount",
    r"indirim", r"brosur", r"brochure", r"infographic", r"screenshot", r"mockup",
    # Theme/slider demo content left on the site (e.g. LayerSlider's "ls-slider-1-slide-1.jpg").
    r"ls-slider-\d+-slide-\d+", r"demo", r"lorem", r"sample", r"example",
))
# Words in the classes/ids of an image's ancestors: sections that hold no venue photos.
BAD_CONTEXT = word_re((
    r"team", r"staff", r"testimonials?", r"reviews?", r"awards?", r"logos", r"logo-?(?:carousel|slider|grid|list)", r"payment", r"instagram-?feed", r"sbi",
    r"insta-?gallery", r"map", r"google-?map", r"author", r"avatar",
))


BAD_HOSTS = ("tripadvisor", "booking.com", "bstatic.com", "googleapis.com/maps", "maps.google", "gstatic.com",
             "facebook.com/tr", "doubleclick", "google-analytics", "yemeksepeti", "trivago", "expedia",
             "holidaycheck", "gravatar", "wp.com/latex", "emoji", "trustpilot", "unsplash", "pexels",
             "shutterstock", "istockphoto", "gettyimages", "pixabay", "freepik")


def originals(url: str) -> list[str]:
    """Likely full-size URLs for a WordPress resized copy (-1024x683.jpg, -845x684-min.jpg, ...)."""
    m = re.match(r"(.+?)(\.(?:jpe?g|png|webp))(\?.*)?$", url, re.I)
    if not m or not re.search(r"-\d{2,4}x\d{2,4}", m.group(1)):
        return []
    stem, ext, out = m.group(1), m.group(2), []
    last = re.sub(r"-\d{2,4}x\d{2,4}(?!.*-\d{2,4}x\d{2,4})", "", stem)
    for cand in (last, re.sub(r"-\d{2,4}x\d{2,4}", "", stem), re.sub(r"-\d{2,4}x\d{2,4}(-\d+)?(-min)?$", "", stem)):
        if cand != stem and cand + ext not in out:
            out.append(cand + ext)
    return out


def social_profile(url: str) -> str | None:
    """Normalised official profile URL, or None for share links, location pages and the like."""
    m = re.match(r"https?://(?:[a-z-]+\.)?(instagram|facebook)\.com/([^?#]+)", url or "", re.I)
    if not m:
        return None
    net, path = m.group(1).lower(), m.group(2).strip("/")
    first = path.split("/")[0].lower()
    if not first or first in {"explore", "sharer", "sharer.php", "share", "p", "reel", "reels", "dialog", "plugins",
                              "events", "groups", "hashtag", "watch", "stories", "photo", "photo.php", "tr", "login",
                              "accounts", "profile.php", "pages", "people", "tags", "help", "privacy", "policies"}:
        return None
    return f"https://www.{net}.com/{path.split('/')[0] if net == 'instagram' else path}/"


class Browser:
    """One camoufox instance for the run, restarted if it dies."""

    def __init__(self, proxy: dict):
        self.proxy, self.cm, self.browser, self.page = proxy, None, None, None

    def open(self):
        from camoufox.sync_api import Camoufox
        self.cm = Camoufox(headless=True, proxy=self.proxy, geoip=False, block_webrtc=True)
        self.browser = self.cm.__enter__()
        self.page = self.browser.new_page()
        self.page.set_default_timeout(45000)

    def close(self):
        try:
            if self.cm:
                self.cm.__exit__(None, None, None)
        except Exception:
            pass
        self.cm = self.browser = self.page = None

    def get_page(self):
        if self.page is None:
            self.open()
        return self.page

    def restart(self):
        self.close()
        self.open()


def fetch(page, url: str, timeout: int = 45000) -> bytes | None:
    for attempt in range(2):
        try:
            response = page.request.get(url, timeout=timeout, headers={"Accept": "image/jpeg,image/png,image/webp,image/*;q=0.8"})
            if response.ok:
                return response.body()
            return None
        except Exception:
            if attempt:
                return None
    return None


def site_candidates(found: dict, site_host: str) -> list[dict]:
    out, urls = [], set()
    for img in found["imgs"]:
        hay = " ".join([img.get("alt", ""), img.get("cls", ""), img.get("ctx", "")])
        cands = [c for c in img["cands"] if c and c[0] and c[0].startswith("http")]
        if not cands:
            continue
        url, declared = max(cands, key=lambda c: c[1] or 0)
        declared = max(declared or 0, img.get("nw") or 0)
        path = urllib.parse.unquote(urllib.parse.urlparse(url).path).replace("_", "-")
        own = (img.get("alt", "") + " " + img.get("cls", "")).replace("_", "-")
        hit = BAD_WORDS.search(path) or BAD_WORDS.search(own)
        ctx_hit = BAD_CONTEXT.search(img.get("ctx", "").replace("_", "-"))
        why = None
        if any(b in url.lower() for b in BAD_HOSTS):
            why = "third-party host"
        elif hit:
            why = "keyword: " + hit.group(0)
        elif ctx_hit:
            why = "section: " + ctx_hit.group(0)
        elif re.search(r"\.(svg|gif|ico)(\?|$)", path, re.I):
            why = "svg/gif/ico"
        elif img.get("chrome") and not img.get("bg") and (img.get("rw") or 0) < 600:
            why = "header/footer image"
        elif declared and declared < MIN_WIDTH and not originals(url):
            why = f"declared {declared}px"
        if url in urls:
            continue
        urls.add(url)
        out.append({"url": url, "declared": declared, "why": why, "alt": img.get("alt", "")[:80]})
    for og in found["og"]:
        if og and og not in urls and not any(b in og.lower() for b in BAD_HOSTS) and not BAD_WORDS.search(urllib.parse.urlparse(og).path):
            urls.add(og)
            out.append({"url": og, "declared": 0, "why": None, "og": True})
    # Bigger first; og:image after declared-large images.
    out.sort(key=lambda c: (c["why"] is not None, -(c["declared"] or 0)))
    return out


def website_photos(browser: Browser, item: dict, want: int, seen: list[int], log: dict) -> tuple[list, set]:
    site = item.get("website")
    socials = set()
    if not site or urllib.parse.urlparse(site).netloc.lower().removeprefix("www.") in SOCIAL:
        log["website"] = "none"
        return [], socials
    page = browser.get_page()
    pages, found_all = [site], {"imgs": [], "og": [], "links": [], "gallery": []}
    visited = []
    while pages and len(visited) < 2:
        url = pages.pop(0)
        try:
            print(f"  {item['slug']}: loading {url}", flush=True)
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(2500)
            page.evaluate(SCROLL)
            page.wait_for_timeout(1500)
            found = page.evaluate(COLLECT)
        except Exception as error:
            log.setdefault("errors", []).append(f"website load {url}: {str(error).splitlines()[0][:120]}")
            if "Target" in str(error) or "closed" in str(error):
                browser.restart()
                page = browser.get_page()
            continue
        visited.append(page.url)
        for k in found_all:
            found_all[k] += found[k]
        if len(visited) == 1 and found["gallery"]:
            pages.append(found["gallery"][0])
    log["website"] = {"visited": visited}
    for link in found_all["links"]:
        prof = social_profile(link)
        if prof:
            socials.add(prof)
    host = urllib.parse.urlparse(site).netloc
    cands = site_candidates(found_all, host)
    log["website"]["candidates"] = len(cands)
    out, tried = [], 0
    deadline = time.time() + 300  # a slow proxy or site must not stall the batch
    for cand in cands:
        if len(out) >= want or tried >= 24:
            break
        if time.time() > deadline:
            log["website"]["stopped"] = "time budget (300 s) used"
            break
        if cand["why"]:
            log.setdefault("rejected", []).append({"source": "website", "url": cand["url"], "why": cand["why"]})
            continue
        tried += 1
        data, url = None, cand["url"]
        for orig in originals(cand["url"]):
            data = fetch(page, orig, 20000)
            if data:
                url = orig
                break
        if data is None:
            data = fetch(page, cand["url"])
        if data is None:
            log.setdefault("rejected", []).append({"source": "website", "url": cand["url"], "why": "download failed"})
            continue
        try:
            jpeg, w, h, sw, digest = process(data, seen)
        except Rejected as why:
            log.setdefault("rejected", []).append({"source": "website", "url": url, "why": str(why)})
            continue
        seen.append(digest)
        out.append(({"source": "website", "source_url": visited[0] if visited else site, "image_url": url,
                     "credit": f"Photo: {item['title']} (website)", "width": w, "height": h,
                     "source_width": sw, "dhash": f"{digest:016x}"}, jpeg))
    return out, socials


INSTAGRAM_POSTS = """() => [...new Set([...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].map(a => a.href))].slice(0, 12)"""
OG = """() => { const m = document.querySelector('meta[property="og:image"]'); return m ? m.content : null }"""
WALL = """() => /accounts\\/login|login\\.php|checkpoint/.test(location.href) ||
  !!document.querySelector('form[action*="login"] input[name="password"], input[name="pass"]') &&
  !document.querySelector('a[href*="/p/"]')"""


def social_photos(browser: Browser, item: dict, profiles: list[str], want: int, seen: list[int], log: dict,
                  min_width: int = MIN_WIDTH) -> list:
    out = []
    page = browser.get_page()
    for profile in profiles:
        if len(out) >= want:
            break
        net = "instagram" if "instagram.com" in profile else "facebook"
        entry = log.setdefault("social", {}).setdefault(profile, {})
        try:
            page.goto(profile, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(4000)
            walled = page.evaluate(WALL)
        except Exception as error:
            entry["status"] = f"load failed: {str(error).splitlines()[0][:100]}"
            continue
        if net == "instagram":
            posts = [] if walled else page.evaluate(INSTAGRAM_POSTS)
            if not posts:
                entry["status"] = "social_blocked"
                continue
            entry["posts"] = len(posts)
            small = 0
            for post in posts:
                if small >= 3:
                    entry["status"] = "images too small logged out (640 px)"
                    break
                if len(out) >= want:
                    break
                try:
                    page.goto(post, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(2000)
                    if page.evaluate(WALL):
                        entry["status"] = "social_blocked (post pages)"
                        break
                    img = page.evaluate(OG)
                except Exception:
                    continue
                if not img:
                    continue
                data = fetch(page, img)
                if not data:
                    continue
                try:
                    jpeg, w, h, sw, digest = process(data, seen, min_width)
                except Rejected as why:
                    small += str(why).startswith("too small")
                    log.setdefault("rejected", []).append({"source": "instagram", "url": post, "why": str(why)})
                    continue
                seen.append(digest)
                out.append(({"source": "instagram", "source_url": post, "image_url": img,
                             "credit": f"Photo: {item['title']} (Instagram)", "width": w, "height": h,
                             "source_width": sw, "dhash": f"{digest:016x}"}, jpeg))
            entry.setdefault("status", "ok")
        else:
            img = page.evaluate(OG)
            if walled and not img:
                entry["status"] = "social_blocked"
                continue
            entry["status"] = "og:image only" if img else "social_blocked"
            data = fetch(page, img) if img else None
            if data:
                try:
                    jpeg, w, h, sw, digest = process(data, seen, min_width)
                    seen.append(digest)
                    out.append(({"source": "facebook", "source_url": profile, "image_url": img,
                                 "credit": f"Photo: {item['title']} (Facebook)", "width": w, "height": h,
                                 "source_width": sw, "dhash": f"{digest:016x}"}, jpeg))
                except Rejected as why:
                    log.setdefault("rejected", []).append({"source": "facebook", "url": profile, "why": str(why)})
    return out


# ---------------------------------------------------------------- Wikimedia

PUBLIC_KINDS = {"historical", "beaches", "tarihi-yerler", "plajlar"}
PUBLIC_TYPES = {"tourist_attraction", "historical_landmark", "historical_place", "museum", "place_of_worship",
                "church", "mosque", "park", "national_park", "beach", "natural_feature", "monument",
                "cultural_landmark", "archaeological_site", "castle", "hiking_area", "garden", "plaza"}
FREE = re.compile(r"^(cc[- ]by(-sa)?[- ]\d(\.\d)?.*|cc0.*|public domain|pd.*)$", re.I)
WIKI_BAD = re.compile(r"(?<![a-z])(map|plan|logo|coat of arms|flag|diagram|stamp|coin|banknote|locator|svg|drawing|"
                      r"sketch|painting|engraving|lithograph|postcard|chart)(?![a-z])", re.I)


def is_public(item: dict) -> bool:
    return item.get("kind") in PUBLIC_KINDS or bool(PUBLIC_TYPES & set(item.get("types") or []))


def commons(params: dict) -> dict:
    params = {**params, "format": "json", "formatversion": "2"}
    request = urllib.request.Request("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params),
                                     headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=40) as response:
        return json.load(response)


def strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", text or ""))).strip()


def wikimedia_photos(item: dict, want: int, seen: list[int], log: dict) -> list:
    loc = item.get("location") or {}
    titles = {}
    name_words = [w for w in words(item["title"]) if w not in GENERIC and len(w) >= 4] or words(item["title"])
    try:
        if loc:
            radius = 600 if item.get("kind") in ("beaches", "plajlar") else 300
            geo = commons({"action": "query", "list": "geosearch", "gscoord": f"{loc['latitude']}|{loc['longitude']}",
                           "gsradius": radius, "gsnamespace": 6, "gslimit": 40})
            for g in geo.get("query", {}).get("geosearch", []):
                titles[g["title"]] = {"dist": g.get("dist", 0), "geo": True}
        found = commons({"action": "query", "list": "search", "srsearch": f"{item['title']} Cyprus filetype:bitmap",
                         "srnamespace": 6, "srlimit": 20})
        for s in found.get("query", {}).get("search", []):
            titles.setdefault(s["title"], {"dist": 9999, "geo": False})
    except Exception as error:
        log.setdefault("errors", []).append(f"commons search: {type(error).__name__}")
        return []
    infos = []
    names = list(titles)
    for i in range(0, len(names), 40):
        try:
            data = commons({"action": "query", "titles": "|".join(names[i:i + 40]), "prop": "imageinfo",
                            "iiprop": "url|size|mime|extmetadata", "iiurlwidth": LONG_EDGE})
        except Exception:
            continue
        for p in data.get("query", {}).get("pages", []):
            if p.get("imageinfo"):
                infos.append((p["title"], p["imageinfo"][0]))

    def score(entry):
        title, info = entry
        meta = info.get("extmetadata", {})
        text = " ".join(words(title + " " + strip_html(meta.get("ImageDescription", {}).get("value", ""))))
        hits = sum(1 for w in name_words if w in text)
        return (-hits, titles[title]["dist"])

    out, per_author = [], {}
    count = {"found": len(infos), "licence_rejected": 0}
    for title, info in sorted(infos, key=score):
        if len(out) >= want:
            break
        meta = info.get("extmetadata", {})
        lic = strip_html(meta.get("LicenseShortName", {}).get("value", ""))
        text = " ".join(words(title + " " + strip_html(meta.get("ImageDescription", {}).get("value", ""))))
        named = any(w in text for w in name_words)
        if not titles[title]["geo"] and not named:
            continue
        if info.get("mime") not in ("image/jpeg", "image/png", "image/webp") or WIKI_BAD.search(title):
            continue
        if not FREE.match(lic) or re.search(r"\bnc\b|\bnd\b", lic, re.I):
            count["licence_rejected"] += 1
            continue
        if info.get("width", 0) < MIN_WIDTH:
            continue
        artist = strip_html(meta.get("Artist", {}).get("value", "")) or "unknown author"
        if per_author.get(artist, 0) >= 3:  # variety: at most three by one photographer
            continue
        try:
            req = urllib.request.Request(info.get("thumburl") or info["url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as response:
                data = response.read()
            jpeg, w, h, sw, digest = process(data, seen)
        except Rejected as why:
            log.setdefault("rejected", []).append({"source": "wikimedia", "url": info["descriptionurl"], "why": str(why)})
            continue
        except Exception as error:
            log.setdefault("errors", []).append(f"commons download: {type(error).__name__}")
            continue
        seen.append(digest)
        author = artist
        per_author[artist] = per_author.get(artist, 0) + 1
        lic_label = lic.upper().replace("CC-BY", "CC BY").replace("CC BY-SA", "CC BY-SA") if lic.lower().startswith("cc") else lic
        out.append(({"source": "wikimedia", "source_url": info["descriptionurl"], "image_url": info["url"],
                     "author": author, "license": lic_label,
                     "license_url": strip_html(meta.get("LicenseUrl", {}).get("value", "")) or None,
                     "credit": f"Photo: {author}, {lic_label}, Wikimedia Commons",
                     "geo_match": titles[title]["geo"], "name_match": named,
                     "width": w, "height": h, "source_width": sw, "dhash": f"{digest:016x}"}, jpeg))
    log["wikimedia"] = count
    return out


# ---------------------------------------------------------------- main

def site_host(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")


def run_place(item: dict, args, key: str, browser: Browser | None) -> None:
    folder = os.path.join(args.out, item["slug"])
    os.makedirs(folder, exist_ok=True)
    log = {"slug": item["slug"], "title": item["title"], "started": time.strftime("%Y-%m-%dT%H:%M:%S")}
    if item.get("website") and args.site_users.get(site_host(item["website"]), 0) > 1:
        # A chain's site: its photos may show other branches. Flag for review.
        log["shared_website"] = args.site_users[site_host(item["website"])]
    seen: list[int] = []
    # Places API terms forbid storing its photos, owner uploads included.
    photos = [] if args.no_google else google_owner_photos(key, item, args.max, seen, log)
    # A historical site's "website" is a ministry or travel-guide page: not venue photos.
    if item.get("kind") in ("historical", "tarihi-yerler"):
        log["website"] = "skipped (public historical site)"
    elif item.get("kind") == "services":
        log["website"] = "skipped (bank/corporate site: marketing images, not the branch)"
    elif len(photos) < 3 and browser and not args.no_web:
        site, socials = website_photos(browser, item, args.max - len(photos), seen, log)
        photos += site
        for prof in (item.get("socials") or {}).values():
            p = social_profile(prof)
            if p:
                socials.add(p)
        log["socials_found"] = sorted(socials)
        if len(photos) < 3 and socials:
            # Instagram first: Facebook rarely shows more than its cover logged out.
            ordered = sorted(socials, key=lambda u: "facebook" in u)[:3]
            photos += social_photos(browser, item, ordered, args.max - len(photos), seen, log, args.social_min_width)
    if len(photos) < 3 and is_public(item):
        photos += wikimedia_photos(item, args.max - len(photos), seen, log)
    manifest = []
    for n, (meta, jpeg) in enumerate(photos[: args.max], 1):
        name = f"{n:02d}.jpg"
        open(os.path.join(folder, name), "wb").write(jpeg)
        manifest.append({"file": name, **meta, "sha1": hashlib.sha1(jpeg).hexdigest()})
    log["kept"] = {s: sum(1 for m in manifest if m["source"] == s) for s in {m["source"] for m in manifest}}
    log["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    json.dump(log, open(os.path.join(folder, "report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(manifest, open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "run-log.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"slug": item["slug"], "kept": log["kept"], "at": log["finished"]}) + "\n")
    print(f"{item['slug']}: {len(manifest)} photos {log['kept']}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inventory")
    parser.add_argument("out")
    parser.add_argument("--proxy-line", type=int)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--end", type=int)
    parser.add_argument("--slugs")
    parser.add_argument("--max", type=int, default=8)
    parser.add_argument("--social-min-width", type=int, default=MIN_WIDTH,
                        help="Instagram serves 640 px images logged out; lower this (e.g. 640) to keep them")
    parser.add_argument("--no-google", action="store_true",
                        help="skip Google owner photos (the Places API terms forbid storing them)")
    parser.add_argument("--no-web", action="store_true", help="Google and Wikimedia only (still needs a proxy)")
    args = parser.parse_args()

    proxy = proxy_settings(args.proxy_line)  # exits without a proxy
    key = env_value("GOOGLE_MAPS_PLACE_API_KEY")
    if not key:
        sys.exit("GOOGLE_MAPS_PLACE_API_KEY is not set")
    items = json.load(open(args.inventory, encoding="utf-8"))
    if args.slugs:
        wanted = args.slugs.split(",")
        items = [i for i in items if i["slug"] in wanted]
    else:
        items = items[args.start: args.end]
    args.site_users = {}
    for i in json.load(open(args.inventory, encoding="utf-8")):
        if i.get("website"):
            args.site_users[site_host(i["website"])] = args.site_users.get(site_host(i["website"]), 0) + 1
    os.makedirs(args.out, exist_ok=True)
    todo = [i for i in items if not os.path.exists(os.path.join(args.out, i["slug"], "manifest.json"))]
    print(f"{len(todo)} places to do ({len(items) - len(todo)} already done)", flush=True)
    browser = None if args.no_web else Browser(proxy)
    try:
        for item in todo:
            try:
                run_place(item, args, key, browser)
            except Exception:
                print(f"{item['slug']}: FAILED\n{traceback.format_exc(limit=3)}", flush=True)
                if browser:
                    browser.close()
    finally:
        if browser:
            browser.close()


if __name__ == "__main__":
    main()
