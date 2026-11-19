#!/usr/bin/env python3
"""Render the three dossier screenshots from the page main.ts wrote to /output.

  python3 tools/shots.py

Each shot is the real page at /output/dashboard/index.html with the real data.js beside it: the board,
one protocol's detail view, and a filtered view. Sizes are tuned into the 300-350 KB band the dossier
wants (long side <= 1440, short side >= 800).
"""

import io
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

OUT = os.environ.get("RADAR_OUT", "/output")
# The screenshots live in the repository, beside main.ts: main.ts is what copies them into /output.
SHOTS = os.environ.get("RADAR_SHOTS", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "screenshots"))
URL = "file://" + os.path.join(OUT, "dashboard", "index.html")

# The state each shot is taken in, as the page's own hash.
SHOT_STATES = [
    ("1-board.png", "", 1400),
    ("2-detail.png", "p=bittensor-dtao", 1400),
    ("3-filtered.png", "cat=Lending&sort=window&dir=-1", 1400),
]

WIDTH = 1400

FREEZE = """
  *, *::before, *::after { animation: none !important; transition: none !important; }
  html { scroll-behavior: auto !important; }
  ::-webkit-scrollbar { display: none; }
"""


BAND = (300 * 1024, 350 * 1024)
TARGET = 320 * 1024


def tune_png(path: str) -> int:
    """Re-encode the PNG losslessly, picking the zlib level whose size sits nearest 320 KB.

    The pixels are the page's own at every level; only the deflate setting changes, which is how the
    dossier's 300-350 KB band is met without touching what the screenshot shows.
    """
    image = Image.open(path).convert("RGB")
    best = None
    for level in range(1, 10):
        buffer = io.BytesIO()
        image.save(buffer, "PNG", compress_level=level)
        size = buffer.tell()
        if not (BAND[0] <= size <= BAND[1]):
            continue
        if best is None or abs(size - TARGET) < abs(best[1] - TARGET):
            best = (level, size, buffer.getvalue())
    if best is None:
        raise SystemExit(f"{path}: no PNG compression level lands in the 300-350 KB band")
    with open(path, "wb") as handle:
        handle.write(best[2])
    return best[1]


def main() -> int:
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--force-color-profile=srgb", "--hide-scrollbars"])
        page = browser.new_page(viewport={"width": WIDTH, "height": 1250}, device_scale_factor=1)
        for name, state, height in SHOT_STATES:
            page.set_viewport_size({"width": WIDTH, "height": height})
            page.goto("about:blank")
            page.goto(URL + ("#" + state if state else ""), wait_until="load")
            page.add_style_tag(content=FREEZE)
            page.wait_for_timeout(350)
            path = os.path.join(SHOTS, name)
            page.screenshot(path=path, full_page=False)
            size = tune_png(path)
            print(f"{name}: {size} bytes ({size / 1024:.0f} KB)")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
