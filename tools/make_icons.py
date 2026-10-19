"""앱 아이콘 만들기: 적정가 범위 막대 + 기준 눈금 + 그보다 왼쪽의 현재가 점선.

  python tools/make_icons.py      → app/icons/*.png
"""
import pathlib

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parents[1] / "app" / "icons"
BG = (31, 79, 134)        # --accent
BAR = (159, 180, 204)     # --bar
INK = (255, 255, 255)
PRICE = (245, 158, 91)    # 어두운 바탕 위 현재가 색


def glyph(d, s, scale):
    """s = 그림 영역 한 변(px). scale = 안전 영역 비율(마스커블은 작게)."""
    c = s / 2
    w = s * 0.62 * scale
    h = s * 0.15 * scale
    x0, x1 = c - w / 2, c + w / 2
    y0, y1 = c - h / 2, c + h / 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=h / 2, fill=BAR)
    # 기준 눈금 (적정가 Base)
    bx = c + w * 0.12
    tw = s * 0.06 * scale
    d.rounded_rectangle([bx - tw / 2, c - h * 1.55, bx + tw / 2, c + h * 1.55], radius=tw / 2, fill=INK)
    # 현재가 점선 (적정가보다 왼쪽 = 싸다)
    px = c - w * 0.28
    lw = s * 0.05 * scale
    top, bot = c - s * 0.30 * scale, c + s * 0.30 * scale
    n = 5                                   # 점선 조각 수 (위아래 대칭)
    seg = (bot - top) / (n + (n - 1) * 0.6)
    for i in range(n):
        y = top + i * seg * 1.6
        d.rounded_rectangle([px - lw / 2, y, px + lw / 2, y + seg], radius=lw / 2, fill=PRICE)


def make(size, maskable=False, rounded=True):
    k = 4
    S = size * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable or not rounded:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=BG)
    glyph(d, S, 0.72 if maskable else 1.0)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    make(192).save(OUT / "icon-192.png")
    make(512).save(OUT / "icon-512.png")
    make(512, maskable=True).save(OUT / "maskable-512.png")
    make(180, rounded=False).convert("RGB").save(OUT / "icon-180.png")  # 아이폰은 모서리를 알아서 깎음
    print("icons →", OUT)
