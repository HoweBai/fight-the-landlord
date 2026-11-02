#!/usr/bin/env python3
"""从 FluffyStuff CC0 源图生成四方向麻将牌面（180x240 / 240x180，64 色量化）。

源图：scripts/assets/mahjong/fluffystuff/（Front.png + Man/Pin/Sou 1-9 + Back.png）
输出：apps/client/src/pages/table/static/mahjong/{my,top,left,right}/ + manifest.json

依赖：Pillow、numpy（见 scripts/assets/mahjong/requirements.txt）。
生成结果入库；本脚本不参与构建。
"""
from PIL import Image, ImageOps
import hashlib
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "scripts/assets/mahjong/fluffystuff")
OUT = os.path.join(ROOT, "apps/client/src/pages/table/static/mahjong")
SUITS = {"Man": "wan", "Pin": "tong", "Sou": "tiao"}
# PIL 正角度=逆时针；left 需要顺时针（牌面上方朝右/中心），right 逆时针。
ANGLES = {"my": 0, "top": 180, "left": -90, "right": 90}
SOURCE_COMMIT = "26e127ba2117f45cdce5ea0225748cc0cfad3169"


def composed(stem: str) -> Image.Image:
    """冷白牌面 + 字形，保持 600x800 画布。"""
    front = Image.open(os.path.join(SRC, "Front.png")).convert("RGBA")
    gray = ImageOps.grayscale(front)
    face = ImageOps.colorize(
        gray,
        black=(190, 195, 205),
        mid=(232, 236, 241),
        white=(240, 244, 250),
    ).convert("RGBA")
    face.putalpha(front.split()[3])
    glyph = Image.open(os.path.join(SRC, f"{stem}.png")).convert("RGBA")
    return Image.alpha_composite(face, glyph)


def royal_back() -> Image.Image:
    """红牌背 → 亮宝蓝（灰度着色），保留源图透明圆角与立体高光。"""
    back = Image.open(os.path.join(SRC, "Back.png")).convert("RGBA")
    gray = ImageOps.grayscale(back)
    out = ImageOps.colorize(
        gray,
        black=(35, 55, 100),
        mid=(91, 126, 192),
        white=(160, 178, 214),
    ).convert("RGBA")
    out.putalpha(back.split()[3])
    return out


def emit(im: Image.Image, direction: str, name: str) -> dict:
    portrait = direction in ("my", "top")
    im = im.resize((180, 240) if portrait else (240, 180), Image.LANCZOS)
    q = im.quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)
    path = os.path.join(OUT, direction, f"{name}.png")
    q.save(path, optimize=True)
    buf = open(path, "rb").read()
    return {
        "file": f"{direction}/{name}.png",
        "direction": direction,
        "sha256": hashlib.sha256(buf).hexdigest(),
        "width": q.width,
        "height": q.height,
    }


def main() -> None:
    faces = {
        f"{suit}-{rank}": composed(f"{stem}{rank}")
        for stem, suit in SUITS.items()
        for rank in range(1, 10)
    }
    back = royal_back()
    files = []
    for direction, angle in ANGLES.items():
        out_dir = os.path.join(OUT, direction)
        os.makedirs(out_dir, exist_ok=True)
        # 整批替换：删掉旧文件（含历史 *z.png），避免残留
        for f in os.listdir(out_dir):
            if f.endswith(".png"):
                os.remove(os.path.join(out_dir, f))
        for name, im in faces.items():
            files.append(emit(im.rotate(angle, expand=True), direction, name))
        files.append(emit(back.rotate(angle, expand=True), direction, "back"))

    manifest = {
        "source": "FluffyStuff/riichi-mahjong-tiles",
        "commit": SOURCE_COMMIT,
        "license": "CC0-1.0",
        "files": files,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    main()
