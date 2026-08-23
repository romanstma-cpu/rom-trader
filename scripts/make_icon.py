# Generates the ROM Trader app icon: three ascending gradient candlesticks on a
# dark rounded square. Outputs assets/icon.png (1024) and assets/icon.ico.
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024
OUT = os.path.join(os.path.dirname(__file__), "..", "assets")

BG_TOP = (27, 20, 40)
BG_BOT = (13, 10, 20)
PURPLE = (124, 58, 237)
PINK = (255, 45, 154)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        c = lerp(top, bot, y / max(1, h - 1))
        for x in range(w):
            px[x, y] = c
    return img


# --- background: rounded square with vertical gradient + subtle border glow ---
radius = 220
bg = vgrad(S, S, BG_TOP, BG_BOT).convert("RGBA")
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)

icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon.paste(bg, (0, 0), mask)

# thin gradient border ring
ring = Image.new("L", (S, S), 0)
rd = ImageDraw.Draw(ring)
rd.rounded_rectangle([6, 6, S - 7, S - 7], radius=radius - 6, outline=255, width=14)
hgrad = Image.new("RGB", (S, S))
hp = hgrad.load()
for x in range(S):
    c = lerp(PURPLE, PINK, x / (S - 1))
    for y in range(S):
        hp[x, y] = c
border = Image.new("RGBA", (S, S), (0, 0, 0, 0))
border.paste(hgrad, (0, 0), ring)
icon = Image.alpha_composite(icon, border)

# --- bold "R" monogram with diagonal purple -> pink gradient ---
from PIL import ImageFont

font = ImageFont.truetype("C:/Windows/Fonts/seguibl.ttf", 780)  # Segoe UI Black
text_mask = Image.new("L", (S, S), 0)
td = ImageDraw.Draw(text_mask)
td.text((S // 2, S // 2 - 30), "R", font=font, anchor="mm", fill=255)

# diagonal gradient (top-left purple -> bottom-right pink)
dgrad = Image.new("RGB", (S, S))
dp = dgrad.load()
for y in range(S):
    for x in range(S):
        dp[x, y] = lerp(PURPLE, PINK, (x + y) / (2 * (S - 1)))

layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
layer.paste(dgrad, (0, 0), text_mask)

# soft glow behind the candles
glow = layer.filter(ImageFilter.GaussianBlur(28))
glow.putalpha(glow.split()[3].point(lambda a: a // 2))
icon = Image.alpha_composite(icon, glow)
icon = Image.alpha_composite(icon, layer)

icon.save(os.path.join(OUT, "icon.png"))
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon-256.png"))
icon.save(
    os.path.join(OUT, "icon.ico"),
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print("icon.png, icon-256.png, icon.ico written to", os.path.abspath(OUT))
