#!/usr/bin/env python3
"""从 FluffyStuff CC0 源图生成四方向麻将牌面（180x240 / 240x180，64 色量化）。

源图：scripts/assets/mahjong/fluffystuff/（Front.png + Man/Pin/Sou 1-9 + Back.png）
输出：apps/client/src/pages/table/static/mahjong/{my,top,left,right}/ + manifest.json

依赖：Pillow、numpy（见 scripts/assets/mahjong/requirements.txt）。
生成结果入库；本脚本不参与构建。
"""
from PIL import Image
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
    """空白牌面 + 字形，保持 600x800 画布。"""
    front = Image.open(os.path.join(SRC, "Front.png")).convert("RGBA")
    glyph = Image.open(os.path.join(SRC, f"{stem}.png")).convert("RGBA")
    return Image.alpha_composite(front, glyph)


def navy_back() -> Image.Image:
    """红牌背 → 海军蓝，保留源图透明圆角与立体高光。"""
    back = Image.open(os.path.join(SRC, "Back.png")).convert("RGBA")
    hsv = back.convert("HSV")
    h, s, v = hsv.split()
    h = ((np.array(h, dtype=np.int16) + 170) % 256).astype("uint8")
    hue = Image.merge("HSV", (Image.fromarray(h), s, v)).convert("RGBA")
    navy = Image.new("RGBA", hue.size, (27, 41, 80, 255))
    rgb = Image.blend(hue.convert("RGB"), navy.convert("RGB"), 0.38)
    out = rgb.convert("RGBA")
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
    back = navy_back()
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
