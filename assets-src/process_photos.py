#!/usr/bin/env python3
"""Turn the real checkpoint photos of SCHOOL SE GHAR TAK into game textures (public/photos/).

    python -P assets-src/process_photos.py "<project root>" [preview_dir]

Needs OpenCV (cv2), numpy and Pillow. For every photo it:
  * rectifies the useful planes (sign walls, facades, boards) to straight-on with a homography,
  * removes things that would look odd in the game (people, vehicles, Street View markers, foreground
    plants) by inpainting or by synthesising the surrounding material (granite, wall paint),
  * flattens hard sun/shadow patches and grades to the game palette: a touch warmer, lifted shadows,
    a little less contrast and saturation noise, plus mild edge-preserving "painterly" smoothing so the
    photo matches the flat-shaded low-poly world,
  * re-letters signs whose text is too small in the photo (same colours/fonts style, crisp at speed),
  * exports textures <= 1024 px on the long side (JPEG q~82, WebP with alpha for cut-out letters).
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREV = sys.argv[2] if len(sys.argv) > 2 else None
SRC = os.path.join(ROOT, 'assets-src', 'photos')
OUT = os.path.join(ROOT, 'public', 'photos')
FONTS = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts')
os.makedirs(OUT, exist_ok=True)
if PREV:
    os.makedirs(PREV, exist_ok=True)

REPORT = []


# ------------------------------------------------------------------ io
def load(name):
    im = cv2.imread(os.path.join(SRC, name), cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit('cannot read ' + name)
    return im


def save(name, im, q=82):
    path = os.path.join(OUT, name)
    if name.endswith('.jpg'):
        cv2.imwrite(path, im, [cv2.IMWRITE_JPEG_QUALITY, q, cv2.IMWRITE_JPEG_PROGRESSIVE, 0, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    elif name.endswith('.webp'):
        if im.shape[2] == 4:
            rgba = cv2.cvtColor(im, cv2.COLOR_BGRA2RGBA)
            Image.fromarray(rgba).save(path, 'WEBP', quality=q, method=6, alpha_quality=90)
        else:
            Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)).save(path, 'WEBP', quality=q, method=6)
    else:
        cv2.imwrite(path, im)
    REPORT.append((name, im.shape[1], im.shape[0], os.path.getsize(path)))
    if PREV:
        cv2.imwrite(os.path.join(PREV, os.path.splitext(name)[0] + '.png'), im)


# ------------------------------------------------------------------ geometry
def warp(im, quad, W, H, pad=(0, 0, 0, 0), interp=cv2.INTER_CUBIC):
    """Map quad (TL, TR, BR, BL in source pixels) onto a W x H rectangle; pad = extra (l, t, r, b) pixels
    of the same plane kept around it."""
    l, t, r, b = pad
    S = np.float32(quad)
    D = np.float32([[l, t], [l + W, t], [l + W, t + H], [l, t + H]])
    M = cv2.getPerspectiveTransform(S, D)
    return cv2.warpPerspective(im, M, (W + l + r, H + t + b), flags=interp, borderMode=cv2.BORDER_REPLICATE)


def fit(im, w, h, interp=None):
    if interp is None:
        interp = cv2.INTER_AREA if w * h < im.shape[0] * im.shape[1] else cv2.INTER_CUBIC
    return cv2.resize(im, (w, h), interpolation=interp)


# ------------------------------------------------------------------ look
def flatten_light(im, strength=0.5, sigma=40):
    """Soften big sun/shadow patches: pull the low-frequency luminance towards its mean."""
    lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[:, :, 0]
    low = cv2.GaussianBlur(L, (0, 0), sigma)
    lab[:, :, 0] = np.clip(L - strength * (low - low.mean()), 0, 255)
    return cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2BGR)


def grade(im, warm=0.045, lift=0.05, contrast=0.92, sat=0.94, smooth=0.65, sharpen=0.35, gamma=0.96, bright=1.0):
    """Game palette: warmer, lifted shadows, gentler contrast, painterly edge-preserving smoothing."""
    sm = cv2.edgePreservingFilter(im, flags=cv2.RECURS_FILTER, sigma_s=12, sigma_r=0.18)
    sm = cv2.bilateralFilter(sm, 0, 18, 3)
    x = im.astype(np.float32) * (1 - smooth) + sm.astype(np.float32) * smooth
    if sharpen > 0:
        bl = cv2.GaussianBlur(x, (0, 0), 1.2)
        x = x + (x - bl) * sharpen
    x = np.clip(x / 255.0, 0, 1)
    x = np.power(x, gamma) * bright
    x = (x - 0.5) * contrast + 0.5
    x = lift + (1 - lift) * x
    luma = (0.114 * x[:, :, 0] + 0.587 * x[:, :, 1] + 0.299 * x[:, :, 2])[:, :, None]
    x = luma + (x - luma) * sat
    x[:, :, 2] *= 1 + warm          # R
    x[:, :, 1] *= 1 + warm * 0.3    # G
    x[:, :, 0] *= 1 - warm          # B
    # soft highlight roll-off: nothing reaches pure white (the game's bloom would flare on it)
    k = 0.78
    x = np.where(x > k, k + (1 - k) * np.tanh((x - k) / (1 - k) * 0.9) * 0.62, x)
    return np.clip(x * 255 + 0.5, 0, 255).astype(np.uint8)


def white_balance(im, target=(1.0, 1.0, 1.0), pct=(60, 99.5)):
    """Grey-world-ish balance on the bright-but-not-clipped pixels, times a target tint (B, G, R)."""
    f = im.astype(np.float32)
    lum = f.mean(axis=2)
    lo, hi = np.percentile(lum, pct)
    m = (lum > lo) & (lum < hi)
    means = [f[:, :, c][m].mean() for c in range(3)]
    g = np.mean(means)
    for c in range(3):
        f[:, :, c] *= g / max(1, means[c]) * target[c]
    return np.clip(f, 0, 255).astype(np.uint8)


def inpaint(im, mask, r=6, method=cv2.INPAINT_TELEA):
    return cv2.inpaint(im, (mask > 0).astype(np.uint8) * 255, r, method)


def synth_fill(im, mask, patch, feather=6):
    """Fill mask with a material: smooth inpainted base colour + high-frequency detail of a clean patch."""
    base = inpaint(im, mask, 9, cv2.INPAINT_NS)
    base = cv2.GaussianBlur(base, (0, 0), 3)
    p = patch.astype(np.float32)
    detail = p - cv2.GaussianBlur(p, (0, 0), 6)
    H, W = im.shape[:2]
    ty = int(np.ceil(H / p.shape[0])) + 1
    tx = int(np.ceil(W / p.shape[1])) + 1
    tiles = np.tile(detail, (ty, tx, 1))[:H, :W]
    filled = np.clip(base.astype(np.float32) + tiles, 0, 255)
    m = (mask > 0).astype(np.float32)
    if feather:
        m = cv2.GaussianBlur(m, (0, 0), feather)
        m = np.clip(m * 1.6, 0, 1)
    m = m[:, :, None]
    return (im.astype(np.float32) * (1 - m) + filled * m).astype(np.uint8)


def seamless(patch):
    """Make a texture patch tile seamlessly (cross-fade with its half-offset copy away from the centre)."""
    h, w = patch.shape[:2]
    p = patch.astype(np.float32)
    q = np.roll(np.roll(p, h // 2, 0), w // 2, 1)
    yy, xx = np.mgrid[0:h, 0:w]
    wy = 1 - np.abs((yy + 0.5) / h * 2 - 1)
    wx = 1 - np.abs((xx + 0.5) / w * 2 - 1)
    a = np.clip(np.minimum(wx, wy) * 3.0, 0, 1)[:, :, None]
    return (p * a + q * (1 - a)).astype(np.uint8)


def foliage_mask(im, sat_min=60, green_bias=6):
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
    b, g, r = [im[:, :, i].astype(np.int16) for i in range(3)]
    h, s = hsv[:, :, 0], hsv[:, :, 1]
    green = (h > 22) & (h < 95) & (s > sat_min) & (g > b + green_bias)
    return green.astype(np.uint8) * 255


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def draw_text_fit(img, text, box, fnt_name, color, max_size=400, spacing=0, shadow=None, stroke=0, stroke_fill=None, sx=1.0):
    """Draw text centred in box (x0,y0,x1,y1) on a PIL RGBA image, as big as fits. sx = horizontal squeeze."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    size = max_size
    while size > 6:
        f = font(fnt_name, size)
        w = sum(f.getlength(c) for c in text) + spacing * (len(text) - 1)
        asc, desc = f.getmetrics()
        bb = f.getbbox(text)
        th = bb[3] - bb[1]
        if w * sx <= bw and th <= bh:
            break
        size -= 2
    f = font(fnt_name, size)
    bb = f.getbbox(text)
    th = bb[3] - bb[1]
    W = int(np.ceil(w)) + 8
    layer = Image.new('RGBA', (W, bh + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = 4
    ty = (bh + 40 - th) // 2 - bb[1]
    for c in text:
        if shadow:
            d.text((x + shadow[0], ty + shadow[1]), c, font=f, fill=shadow[2])
        d.text((x, ty), c, font=f, fill=color, stroke_width=stroke, stroke_fill=stroke_fill)
        x += f.getlength(c) + spacing
    if sx != 1.0:
        layer = layer.resize((max(1, int(W * sx)), layer.height), Image.LANCZOS)
    px = x0 + (bw - layer.width) // 2
    py = y0 + (bh - layer.height) // 2
    img.alpha_composite(layer, (int(px), int(py)))
    return size


def cv2pil(im):
    return Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB)).convert('RGBA')


def pil2cv(img):
    return cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2BGR)


def mean_bgr(im, x0, y0, x1, y1):
    return [int(v) for v in im[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)]


def hexcol(bgr):
    b, g, r = bgr
    return '#%02x%02x%02x' % (r, g, b)


COLORS = {}


# ================================================================== SHANGRI LA
def shangrila():
    im = load('shangrila.webp')
    # The granite sign wall is shot from below-left: rectify the wall body (below the open frame on top)
    # so the "Shangri La" script reads straight-on. Quad found by fitting the frame-opening line, the dark
    # granite band and the vertical rust stain; pad keeps the wall's left end (the swash of the S).
    W, H = 1400, 560
    pad = (150, 0, 0, 0)
    r = warp(im, [[400, 440], [1360, 338], [1527, 1019], [352, 880]], W, H, pad)
    # left of the wall end the photo shows another building: keep from the wall start
    x0, y0 = 92, 24
    r = r[y0:, x0:]
    # beyond the photo's right edge the warp only replicates pixels: stop where the photo ends
    r = r[:, : 150 - x0 + 1300]
    H = r.shape[0]
    # foreground foliage (bush, fan palm) in the lower part -> synthesise granite instead
    m = foliage_mask(r, 40, 2)
    red = (r[:, :, 2].astype(int) > r[:, :, 1] + 20) & (r[:, :, 2] > 80)
    m[red] = 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = cv2.dilate(m, np.ones((13, 13), np.uint8))
    rows = np.arange(H)[:, None]
    m[(rows < 368 - y0).repeat(m.shape[1], 1)] = 0
    # protect the chrome letters: the "g" descender stroke and the bottom of the L loop / "a"
    prot = np.zeros_like(m)
    o = (150 - x0, -y0)
    cv2.line(prot, (480 + o[0], 330 + o[1]), (282 + o[0], 512 + o[1]), 255, 46)
    cv2.rectangle(prot, (540 + o[0], 300 + o[1]), (1290 + o[0], 384 + o[1]), 255, -1)
    m[prot > 0] = 0
    patch = r[400 - y0:536 - y0, 1080:1300].copy()
    r = synth_fill(r, m, patch, feather=4)
    COLORS['granite'] = hexcol(mean_bgr(r, 1000, 380, 1300, 540))
    r = flatten_light(r, 0.35, 60)
    r = grade(r, warm=0.04, lift=0.05, contrast=0.95, sat=0.9, smooth=0.55, sharpen=0.4)
    out = fit(r, 1024, 384)
    save('shangrila-wall.jpg', out)
    # seamless granite tile for the frame, ends and back of the wall
    g = grade(flatten_light(seamless(patch[:128, :128] if False else r[410:538, 1030:1158]), 0.3, 20), warm=0.0, lift=0.0, contrast=1.0, sat=1.0, smooth=0.2, sharpen=0)
    g = seamless(g)
    save('shangrila-granite.jpg', fit(g, 128, 128))


# ================================================================== ADDA (Rose Wood Residency)
def adda():
    im = load('adda-rosewood.webp')
    # Oval wooden sign: ellipse centre ~(1718,191), semi axes ~241 x 91, tilted ~-3.5 deg.
    cx, cy, a, b, ang = 1718, 190, 243, 93, -3.0
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    rot = cv2.warpAffine(im, M, (im.shape[1], im.shape[0]), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    s = rot[cy - b: cy + b, cx - a: cx + a].copy()
    # the porch slab throws a hard shadow over the top right of the board: relight it
    lab = cv2.cvtColor(s, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    hh, ww = L.shape
    yy, xx = np.mgrid[0:hh, 0:ww]
    zone = (yy < 0.43 * hh) & (xx > ww * 0.30 + (yy * 0.55))
    sh = ((L < 132) & zone).astype(np.uint8) * 255
    sh = cv2.morphologyEx(sh, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    sh = cv2.dilate(sh, np.ones((3, 3), np.uint8))
    lit = (~(sh > 0)) & (L < 160) & (yy > 0.2 * hh) & (yy < 0.8 * hh)
    f = s.astype(np.float32)
    gain = [f[:, :, c][lit].mean() / max(1, f[:, :, c][(sh > 0) & (L < 132)].mean()) for c in range(3)]
    msk = cv2.GaussianBlur(sh.astype(np.float32) / 255, (0, 0), 3)[:, :, None]
    s = np.clip(f * (1 + (np.float32(gain) - 1) * msk), 0, 255).astype(np.uint8)
    s = flatten_light(s, 0.55, 35)
    s = fit(s, 1024, 392, cv2.INTER_CUBIC)
    s = grade(s, warm=0.05, lift=0.04, contrast=1.0, sat=0.95, smooth=0.55, sharpen=0.6)
    save('adda-sign.jpg', s)
    COLORS['adda_wood'] = hexcol(mean_bgr(s, 60, 150, 200, 250))
    # balcony full of potted plants (1st floor, above the porch)
    bal = im[300:456, 1163:1390].copy()
    bal = flatten_light(bal, 0.3, 30)
    bal = grade(bal, warm=0.05, lift=0.06, contrast=0.95, sat=1.0, smooth=0.6, sharpen=0.4)
    save('adda-balcony.jpg', fit(bal, 512, 352, cv2.INTER_CUBIC))
    # security cabin front: textured white wall + window, sign-posted brick pillar next to it
    src = im.copy()
    wm = np.zeros(src.shape[:2], np.uint8)
    cv2.rectangle(wm, (1550, 660), (1790, 720), 255, -1)        # faint "(c) Google" watermark
    gm = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY).astype(np.int16)
    top = gm - cv2.medianBlur(gm.astype(np.uint8), 11).astype(np.int16)
    wm &= ((top > 7).astype(np.uint8) * 255)
    src = inpaint(src, cv2.dilate(wm, np.ones((5, 5), np.uint8)), 5)
    # rectify on the window frame so the cabin front reads straight-on
    cab = warp(src, [[1639, 472], [1837, 470], [1848, 780], [1641, 727]], 220, 270, (100, 90, 100, 150))
    cab = flatten_light(cab, 0.4, 40)
    cab = grade(cab, warm=0.05, lift=0.05, contrast=0.95, sat=0.95, smooth=0.6)
    save('adda-cabin.jpg', fit(cab, 384, 448))
    COLORS['adda_wall'] = hexcol(mean_bgr(cab, 10, 300, 60, 500))
    # brick tile: clean patch of the porch pillar, made seamless
    br = im[290:400, 1470:1600].copy()
    br = flatten_light(br, 0.6, 15)
    br = grade(br, warm=0.03, lift=0.03, contrast=1.0, sat=0.95, smooth=0.4, sharpen=0.3)
    br = fit(br, 128, 112)
    br = seamless(br)
    save('adda-brick.jpg', fit(br, 128, 128))
    COLORS['adda_brick'] = hexcol(mean_bgr(br, 0, 0, 128, 128))


# ================================================================== VIDHI COLLECTION
def vidhi():
    im = load('vidhi-collection.webp')
    # "VIDDHI COLLECTION" board (fascia of the first-floor slab)
    board = warp(im, [[193, 17], [546, 48], [546, 136], [193, 97]], 1024, 256)
    board = flatten_light(board, 0.3, 40)
    board = grade(board, warm=0.03, lift=0.03, contrast=1.02, sat=1.02, smooth=0.5, sharpen=0.7)
    save('vidhi-board.jpg', board)
    # Apollo Pharmacy sign on the neighbouring bay
    ap = warp(im, [[0, 26], [186, 50], [186, 108], [0, 140]], 512, 224)
    ap = flatten_light(ap, 0.3, 30)
    ap = grade(ap, warm=0.02, lift=0.03, contrast=1.02, sat=1.0, smooth=0.5, sharpen=0.7)
    save('vidhi-apollo.jpg', ap)
    # ground-floor shopfront row (stationery & jumbo xerox in the middle), rectified, bicycle + plant removed
    fr = im.copy()
    m = np.zeros(fr.shape[:2], np.uint8)
    cv2.rectangle(m, (352, 380), (491, 491), 255, -1)       # bicycle
    pm = foliage_mask(fr, 40, 0)
    pm[:300, :] = 0
    pm[:, :440] = 0
    m = cv2.dilate(m | pm, np.ones((7, 7), np.uint8))
    fr = inpaint(fr, m, 7)
    front = warp(fr, [[0, 150], [560, 192], [560, 432], [0, 420]], 1024, 448)
    front = flatten_light(front, 0.3, 40)
    front = grade(front, warm=0.05, lift=0.06, contrast=0.95, sat=0.95, smooth=0.6, sharpen=0.4)
    save('vidhi-front.jpg', fit(front, 1024, 448))


# ================================================================== BRIGHT DAY SCHOOL
def shift_fill(im, mask, period, passes=3):
    """Fill masked pixels from the same column `period` px higher (repeats storeys / cladding rows)."""
    out = im.copy()
    m = mask > 0
    for _ in range(passes):
        for y in range(out.shape[0]):
            row = np.where(m[y])[0]
            if not len(row):
                continue
            ys = y - period
            if ys < 0:
                continue
            ok = row[~m[ys, row]]
            out[y, ok] = out[ys, ok]
            m[y, ok] = False
    if m.any():
        out = inpaint(out, m.astype(np.uint8) * 255, 5)
    return out


def brightday():
    im = load('brightday.webp')
    im = white_balance(im, (0.97, 1.0, 1.03))
    f = im[6:404, 0:600].copy()
    # remove the parked car (bottom right) and the trees in front of the facade by extruding the cladding
    # columns straight down (blue panels stay blue, white piers stay white: reads like flat-shaded geometry);
    # real 3D trees stand in front of these spots in the game
    m = np.zeros(f.shape[:2], np.uint8)
    cv2.ellipse(m, (138, 300), (80, 96), 0, 0, 360, 255, -1)
    cv2.rectangle(m, (120, 300), (150, 398), 255, -1)
    cv2.ellipse(m, (497, 316), (68, 86), 0, 0, 360, 255, -1)
    cv2.rectangle(m, (482, 316), (510, 398), 255, -1)
    cv2.ellipse(m, (22, 330), (44, 80), 0, 0, 360, 255, -1)
    cv2.rectangle(m, (0, 330), (40, 398), 255, -1)
    cv2.rectangle(m, (580, 316), (600, 398), 255, -1)
    cv2.rectangle(m, (396, 348), (530, 398), 255, -1)
    keep = np.zeros_like(m)
    keep[300:398, 196:398] = 255                         # entrance: porch, doors, steps stay as photographed
    m[keep > 0] = 0
    mm = m > 0
    for y in range(1, f.shape[0]):
        row = mm[y]
        f[y, row] = f[y - 1, row]
    # soften the extruded streaks a little, only inside the filled area
    bl = cv2.GaussianBlur(f, (0, 0), 1.6)
    fm = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 2)[:, :, None]
    f = (f * (1 - fm) + bl * fm).astype(np.uint8)
    f = fit(f, 1024, 680, cv2.INTER_CUBIC)
    f = flatten_light(f, 0.25, 50)
    f = grade(f, warm=0.06, lift=0.05, contrast=0.96, sat=1.0, smooth=0.6, sharpen=0.45, bright=1.03)
    sx = 1024 / 600.0
    sy = 680 / 398.0
    # crisp re-lettering of the top band "BRIGHT DAY SCHOOL" (white serif caps on blue)
    band = (int(226 * sx), int(38 * sy), int(410 * sx), int(58 * sy))
    g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    lm = np.zeros(g.shape, np.uint8)
    lm[band[1]:band[3], band[0]:band[2]] = (g[band[1]:band[3], band[0]:band[2]] > 150).astype(np.uint8) * 255
    f = inpaint(f, cv2.dilate(lm, np.ones((7, 7), np.uint8)), 5)
    pil = cv2pil(f)
    draw_text_fit(pil, 'BRIGHT DAY SCHOOL', (band[0] - 20, band[1] - 6, band[2] + 20, band[3] + 6), 'timesbd.ttf', (248, 248, 242, 255), spacing=3)
    f = pil2cv(pil)
    save('brightday-facade.jpg', f)
    COLORS['bd_blue'] = hexcol(mean_bgr(f, int(130 * sx), int(20 * sy), int(200 * sx), int(34 * sy)))
    COLORS['bd_grey'] = hexcol(mean_bgr(f, int(330 * sx), int(100 * sy), int(380 * sx), int(140 * sy)))
    COLORS['bd_white'] = hexcol(mean_bgr(f, int(270 * sx), int(150 * sy), int(300 * sx), int(200 * sy)))
    # portico sign: light grey grooved panels with slate-blue serif caps + the school emblem on the right
    sg = im[272:308, 196:446]
    panel = [int(np.percentile(sg[:, :, c], 80)) for c in range(3)]
    pil = Image.new('RGBA', (1024, 148), tuple(panel[::-1]) + (255,))
    d = ImageDraw.Draw(pil)
    for k in range(1, 6):
        x = int(k * 1024 / 6)
        d.line([(x, 0), (x, 148)], fill=tuple(max(0, c - 30) for c in panel[::-1]) + (255,), width=3)
    d.rectangle((0, 0, 1024, 7), fill=(240, 240, 236, 255))
    d.rectangle((0, 140, 1024, 148), fill=(140, 140, 142, 255))
    ink = (70, 84, 128, 255)
    draw_text_fit(pil, 'BRIGHT DAY SCHOOL', (24, 16, 872, 136), 'timesbd.ttf', ink, spacing=4, shadow=(2, 3, (30, 30, 40, 80)))
    ex, ey, er = 944, 74, 48
    d.ellipse((ex - er, ey - er, ex + er, ey + er), outline=ink, width=8)
    d.ellipse((ex - 26, ey - 2, ex + 26, ey + 30), fill=ink)                    # diya bowl
    d.rectangle((ex - 28, ey - 4, ex + 28, ey + 12), fill=tuple(panel[::-1]) + (255,))
    d.pieslice((ex - 26, ey - 18, ex + 26, ey + 30), 0, 180, fill=ink)
    d.polygon([(ex, ey - 36), (ex + 11, ey - 14), (ex, ey - 6), (ex - 11, ey - 14)], fill=(214, 150, 40, 255))  # flame
    noise = np.random.default_rng(3).normal(0, 4, (148, 1024, 1))
    sgc = np.clip(pil2cv(pil).astype(np.float32) + noise, 0, 255).astype(np.uint8)
    sgc = grade(sgc, warm=0.03, lift=0.0, contrast=1.0, sat=1.0, smooth=0.3, sharpen=0.0)
    save('brightday-sign.jpg', sgc)


# ================================================================== PETAL TRILLIUM
def petals():
    im = load('petals-trillium.webp')
    # canopy letters: cream condensed caps standing on the roof edge (photo letters are ~25 px, so re-set crisp)
    pil = Image.new('RGBA', (1024, 192), (0, 0, 0, 0))
    draw_text_fit(pil, 'PETAL  TRILLIUM', (10, 8, 1014, 184), 'ARIALNB.TTF', (238, 230, 192, 255), spacing=6, max_size=260, stroke=4, stroke_fill=(92, 80, 58, 255))
    a = np.array(pil)
    yy = np.linspace(1.08, 0.84, a.shape[0])[:, None]
    a[:, :, :3] = np.clip(a[:, :, :3].astype(np.float32) * yy[:, :, None], 0, 255).astype(np.uint8)
    save('petals-letters.webp', cv2.cvtColor(a, cv2.COLOR_RGBA2BGRA), 90)
    # supermarket fascia: white board with red condensed caps (re-lettered; photo letters are ~20 px)
    rng = np.random.default_rng(5)
    base = np.zeros((160, 1024, 3), np.float32)
    base[:] = (232, 236, 238)
    base += np.linspace(6, -14, 160)[:, None, None]
    base += rng.normal(0, 3, (160, 1024, 1))
    base[:8] = (180, 186, 190)
    base[-10:] = (150, 156, 160)
    pil = cv2pil(np.clip(base, 0, 255).astype(np.uint8))
    draw_text_fit(pil, 'TRILLIUM SUPER MARKET', (34, 20, 990, 140), 'impact.ttf', (196, 38, 34, 255), spacing=8, shadow=(3, 3, (120, 40, 40, 70)))
    mk = grade(pil2cv(pil), warm=0.03, lift=0.0, contrast=1.0, sat=1.0, smooth=0.3, sharpen=0)
    save('petals-market.jpg', mk)
    # canopy underside: big steel panels with corrugation, colours sampled from the photo
    dark = np.float32(mean_bgr(im, 700, 200, 760, 240))
    lite = np.float32(mean_bgr(im, 620, 260, 650, 280))
    COLORS['petals_canopy'] = hexcol([int(v) for v in dark])
    T = 256
    yy, xx = np.mgrid[0:T, 0:T].astype(np.float32)
    corr = 0.5 + 0.5 * np.sin(xx / T * 2 * np.pi * 16)
    tile = dark[None, None, :] * (0.88 + 0.16 * corr[:, :, None])
    edge = (np.minimum(xx, T - 1 - xx) < 5) | (np.minimum(yy, T - 1 - yy) < 5)
    tile[edge] = lite * 0.9
    rim = (np.minimum(xx, T - 1 - xx) < 9) | (np.minimum(yy, T - 1 - yy) < 9)
    tile[rim & ~edge] *= 0.78
    tile += rng.normal(0, 3, (T, T, 1))
    save('petals-canopy.jpg', grade(np.clip(tile, 0, 255).astype(np.uint8), warm=0.03, lift=0.04, contrast=1.0, sat=0.9, smooth=0.3, sharpen=0))
    # top-floor glass curtain wall with YOGA / MEDITATION letters (left wing)
    gl = warp(im, [[350, 432], [536, 458], [528, 576], [347, 556]], 640, 384)
    gl = flatten_light(gl, 0.3, 40)
    gl = grade(gl, warm=0.02, lift=0.05, contrast=1.0, sat=1.05, smooth=0.55, sharpen=0.5)
    save('petals-glass.jpg', gl)


def contact_sheet():
    if not PREV:
        return
    ims = []
    for name, w, h, _ in REPORT:
        p = os.path.join(PREV, os.path.splitext(name)[0] + '.png')
        im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
        if im.shape[2] == 4:
            bg = np.full(im.shape[:2] + (3,), (90, 140, 90), np.uint8)
            a = im[:, :, 3:4].astype(np.float32) / 255
            im = (im[:, :, :3] * a + bg * (1 - a)).astype(np.uint8)
        ims.append(im)


if __name__ == '__main__':
    only = set(sys.argv[3:])
    for fn in (shangrila, adda, vidhi, brightday, petals):
        if not only or fn.__name__ in only:
            fn()
    for name, w, h, size in REPORT:
        print('%-26s %4dx%-4d %6.1f KB' % (name, w, h, size / 1024))
    print('colours', COLORS)
