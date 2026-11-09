# Demo thumbnails: cut the car out of a dealer photo (rembg / U²-Net) and place
# it, lightly stylized, on a neutral studio gradient — no lot, banner or
# signage, and plates too soft to read. Model, color and angle stay true.
#
#   pip install "rembg[cpu]" pillow        # the model (~170 MB) downloads on first run
#   python scripts/demo-fixture/thumb.py public/demo/photos.json public/demo/cars
#
# photos.json ({ key: source URL }) comes from build.mjs; writes <key>.webp per car.
# Look at every output before committing (a bad cut-out can keep background bits).
import sys
from PIL import Image, ImageFilter, ImageDraw
from rembg import new_session, remove

W, H = 480, 300
_s = new_session("u2net")

def keep_largest(alpha):
    # drop small blobs (logos/text the model kept): threshold, then keep big components via bbox of dense area
    a = alpha.point(lambda v: 255 if v > 128 else 0)
    return a

def build(src, dst):
    im = Image.open(src).convert("RGB")
    cut = remove(im, session=_s, post_process_mask=True)
    a = keep_largest(cut.getchannel("A"))
    bbox = a.getbbox()
    if not bbox:
        raise SystemExit("no car found")
    car = cut.crop(bbox)
    alpha = car.getchannel("A").filter(ImageFilter.GaussianBlur(0.6))
    rgb = car.convert("RGB")
    # light stylization at working size: plates / fine text become unreadable
    scale = min((W * 0.86) / car.width, (H * 0.74) / car.height)
    size = (max(1, int(car.width * scale)), max(1, int(car.height * scale)))
    # Soften fine detail (plate frames, window stickers) below legibility: render
    # at ~half size first, then scale up — cards show ~180 px tall anyway.
    small = (max(1, int(size[0] * 0.5)), max(1, int(size[1] * 0.5)))
    rgb = rgb.resize(small, Image.LANCZOS).filter(ImageFilter.MedianFilter(3)).resize(size, Image.LANCZOS)
    rgb = rgb.quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    alpha = alpha.resize(size, Image.LANCZOS)
    # studio backdrop: vertical gradient + soft floor shadow
    bg = Image.new("RGB", (W, H))
    top, bot = (46, 52, 66), (22, 25, 33)
    d = ImageDraw.Draw(bg)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    x = (W - size[0]) // 2
    y = int(H * 0.86) - size[1]
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).ellipse([x + size[0] * 0.06, y + size[1] - 10, x + size[0] * 0.94, y + size[1] + 12], fill=150)
    sh = sh.filter(ImageFilter.GaussianBlur(9))
    bg.paste((8, 9, 12), (0, 0), sh)
    bg.paste(rgb, (x, y), alpha)
    bg.save(dst, "WEBP", quality=72, method=6)

if __name__ == "__main__":
    import json, os, tempfile, urllib.request, hashlib, shutil
    photos = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    W, H = 480, 300
    tmp = tempfile.mkdtemp(prefix="demo-photos-")
    tmp_cache = os.path.join(tempfile.gettempdir(), "demo-thumb-cache")  # by source URL, so re-runs are quick
    os.makedirs(tmp_cache, exist_ok=True)
    failed = []
    for key, url in sorted(photos.items()):
        dst = os.path.join(out, key + ".webp")
        cached = os.path.join(tmp_cache, hashlib.sha1(url.encode()).hexdigest() + ".webp")
        if os.path.exists(cached):
            shutil.copy(cached, dst); print("ok", key, "(cached)"); continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (demo thumbnail build)"})
            raw = os.path.join(tmp, key)
            with urllib.request.urlopen(req, timeout=30) as r, open(raw, "wb") as f:
                f.write(r.read())
            build(raw, dst)
            shutil.copy(dst, cached)
            print("ok", key)
        except Exception as e:  # keep going; report at the end
            failed.append(key)
            print("FAIL", key, type(e).__name__, str(e)[:80])
    print("failed:", failed)
    if failed:  # feed these to build.mjs --skip-photos, then run this again
        dead = os.path.join(os.path.dirname(sys.argv[1]), "dead-photos.json")
        prev = json.load(open(dead)) if os.path.exists(dead) else []
        json.dump(sorted(set(prev + [photos[k] for k in failed])), open(dead, "w"), indent=1)
        print("wrote", dead)
