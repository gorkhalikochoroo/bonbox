"""A realistic receipt PHOTO for the revisor-package tests (no real customer
data): a thermal receipt on a darker table, shot by a 12 MP phone — 3024 ×
4032 px, uneven light, sensor noise, slight blur, saved as the phone saves it
(JPEG quality 92, 2–4 MB). Every character sits in a known cell, so a test can
read it back after the package's re-encoding and prove it is still legible.

`receipt_photo(seed)` → (jpeg bytes, layout) where layout lists every line's
text, the cell size and the top-left of each character cell (in full-res px).
"""
from __future__ import annotations

import io
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 3024, 4032
GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ0123456789,.:-/%"


def _font(size: int):
    import reportlab
    path = os.path.join(os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf")
    return ImageFont.truetype(path, size)


# Body text 3 mm high on 80 mm paper filling ~55 % of the frame width — an
# ordinary photo of a till receipt; the footer is the receipt's small print.
BODY = 46
SMALL = 32


def _lines(rng: random.Random) -> list[tuple[str, int]]:
    items = ["KAFFEBØNNER 1KG", "HAVREMÆLK 6STK", "SMØR ØKO", "RUGBRØD", "ÆBLER 2KG",
             "FLØDE 38%", "TOMATER", "KARTOFLER", "SUKKER", "HVEDEMEL"]
    rng.shuffle(items)
    out = [("HØRKRAM FOODSERVICE A/S", BODY), ("CVR 12345678", BODY),
           (f"KVITTERING NR. {rng.randint(10000, 99999)}", BODY), ("", BODY)]
    total = 0
    for it in items[:7]:
        kr = rng.randint(1500, 49999)
        total += kr
        out.append((f"{it[:18]:<18}{kr // 100:>6},{kr % 100:02d}", BODY))
    moms = round(total * 0.2)
    out += [("", BODY), (f"{'I ALT':<18}{total // 100:>6},{total % 100:02d}", BODY),
            (f"{'HERAF MOMS':<18}{moms // 100:>6},{moms % 100:02d}", BODY), ("", BODY),
            (f"DATO 2026-10-{rng.randint(1, 28):02d} KL. {rng.randint(7, 20):02d}:{rng.randint(0, 59):02d}", SMALL),
            ("BYTTERET 30 DAGE MOD KVITTERING", SMALL),
            ("TAK FOR HANDLEN - WWW.HOERKRAM.DK", SMALL)]
    return out


def receipt_photo(seed: int = 1, quality: int = 92) -> tuple[bytes, dict]:
    rng = random.Random(seed)
    img = Image.new("L", (W, H), 92)                       # the table
    paper_x0, paper_x1 = int(W * 0.2), int(W * 0.8)
    d = ImageDraw.Draw(img)
    d.rectangle([paper_x0, 300, paper_x1, H - 300], fill=238)
    layout = {"lines": []}
    y = 520
    for text, size in _lines(rng):
        f = _font(size)
        cw, ch = int(size * 0.66), int(size * 1.15)        # fixed cells, like a thermal head
        x = paper_x0 + 110
        cells = []
        for i, c in enumerate(text):
            if c != " ":
                bx = f.getbbox(c)
                d.text((x + i * cw + (cw - (bx[2] - bx[0])) // 2 - bx[0], y), c, fill=28, font=f)
            cells.append((x + i * cw, y))
        layout["lines"].append({"text": text, "size": size, "cell": (cw, ch), "cells": cells})
        y += int(ch * 1.35)
    # The photo: soft focus, light falling off across the frame, sensor noise.
    img = img.filter(ImageFilter.GaussianBlur(1.1))
    falloff = Image.linear_gradient("L").rotate(90).resize((W, H))
    img = Image.composite(Image.eval(img, lambda v: max(0, v - 18)), img, falloff)
    noise = Image.effect_noise((W, H), 9)
    img = ImageChops.add(img, noise, 1.0, -128)
    rgb = Image.merge("RGB", (img, img.point(lambda v: min(255, v + 3)),
                              img.point(lambda v: max(0, v - 4))))
    buf = io.BytesIO()
    rgb.save(buf, "JPEG", quality=quality, subsampling=0)
    return buf.getvalue(), layout


def read_back(jpeg: bytes, layout: dict) -> dict:
    """Every printed character's cell is cut out of `jpeg` (at whatever size
    it now has) and matched to the closest of GLYPHS rendered clean at the
    same scale — a strict reader: one grey-scale correlation per cell, no
    language model, no guessing. Returns counts for letters+digits and for
    everything (punctuation included) and the misreads."""
    im = Image.open(io.BytesIO(jpeg)).convert("L")
    scale = im.size[0] / W
    ok = total = ok_an = total_an = 0
    misreads = []
    for line in layout["lines"]:
        size = line["size"]
        cw, ch = line["cell"]
        sw, sh = max(4, round(cw * scale)), max(6, round(ch * scale))
        f = _font(size)
        templates = {}
        for g in GLYPHS:
            t = Image.new("L", (cw, ch), 238)
            bx = f.getbbox(g)
            ImageDraw.Draw(t).text(((cw - (bx[2] - bx[0])) // 2 - bx[0], 0), g, fill=28, font=f)
            templates[g] = _vec(t.resize((sw, sh), Image.LANCZOS))
        for (x, y), c in zip(line["cells"], line["text"]):
            if c == " ":
                continue
            total += 1
            box = (round(x * scale), round(y * scale), round(x * scale) + sw, round(y * scale) + sh)
            v = _vec(im.crop(box))
            best = max(templates, key=lambda g: _corr(v, templates[g]))
            ok += best == c
            if c.isalnum():
                total_an += 1
                ok_an += best == c
            if best != c:
                misreads.append((c, best, size))
    return {"alnum": (ok_an, total_an), "all": (ok, total), "misreads": misreads}


def _vec(im: Image.Image) -> list[float]:
    px = list(im.getdata())
    m = sum(px) / len(px)
    return [p - m for p in px]


def _corr(a: list[float], b: list[float]) -> float:
    num = sum(x * y for x, y in zip(a, b))
    da = sum(x * x for x in a) ** 0.5
    db = sum(y * y for y in b) ** 0.5
    return num / (da * db) if da and db else -1.0
