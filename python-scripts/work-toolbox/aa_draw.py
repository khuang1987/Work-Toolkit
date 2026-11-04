"""Anti-aliased canvas shapes.

Tk's Canvas draws polygons, ovals and lines through GDI without anti-aliasing, so
circles and rounded corners look jagged. These helpers render the shape at 4x with
Pillow, downsample it and place it as an RGBA image, falling back to plain GDI
items when Pillow is unavailable.
"""
from __future__ import annotations

import math
import tkinter as tk
from collections import OrderedDict

try:
    from PIL import Image, ImageDraw, ImageTk
except ImportError:  # pragma: no cover - Pillow is bundled with the toolbox
    Image = ImageDraw = ImageTk = None

SCALE = 4
_CACHE: "OrderedDict[tuple, object]" = OrderedDict()
_CACHE_LIMIT = 600


def _rgba(color: str, canvas: tk.Misc) -> tuple[int, int, int, int] | None:
    if not color:
        return None
    r, g, b = canvas.winfo_rgb(color)
    return r >> 8, g >> 8, b >> 8, 255


def _photo(key: tuple, canvas: tk.Misc, build) -> object:
    photo = _CACHE.get(key)
    if photo is None:
        photo = ImageTk.PhotoImage(build(), master=canvas._root())
        _CACHE[key] = photo
        while len(_CACHE) > _CACHE_LIMIT:
            _CACHE.popitem(last=False)
    else:
        _CACHE.move_to_end(key)
    return photo


def _shape(canvas: tk.Canvas, kind: str, x1: float, y1: float, x2: float, y2: float, radius: float,
           fill: str = "", outline: str = "", width: float = 1.0, tags=None, check: str = "") -> int:
    left, top = math.floor(x1), math.floor(y1)
    w, h = max(1, math.ceil(x2) - left + 1), max(1, math.ceil(y2) - top + 1)
    fill_rgba, outline_rgba = _rgba(fill, canvas), _rgba(outline, canvas)
    check_rgba = _rgba(check, canvas)
    width = float(width or 0) if outline_rgba else 0.0
    key = (kind, round(x1 - left, 2), round(y1 - top, 2), round(x2 - x1, 2), round(y2 - y1, 2), round(radius, 2),
           fill_rgba, outline_rgba, round(width, 2), check_rgba)

    def build():
        image = Image.new("RGBA", (w * SCALE, h * SCALE), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        half = width / 2
        box = [((x1 - left) + half) * SCALE, ((y1 - top) + half) * SCALE,
               ((x2 - left) - half) * SCALE, ((y2 - top) - half) * SCALE]
        box[2], box[3] = max(box[0], box[2]), max(box[1], box[3])
        stroke = max(1, round(width * SCALE)) if width else 0
        if kind == "oval":
            draw.ellipse(box, fill=fill_rgba, outline=outline_rgba if stroke else None, width=stroke)
        else:
            r = max(0.0, min(radius - half, (box[2] - box[0]) / SCALE / 2, (box[3] - box[1]) / SCALE / 2)) * SCALE
            draw.rounded_rectangle(box, radius=r, fill=fill_rgba, outline=outline_rgba if stroke else None, width=stroke)
        if check_rgba:
            cw, ch = box[2] - box[0], box[3] - box[1]
            points = [(box[0] + cw * 0.27, box[1] + ch * 0.52), (box[0] + cw * 0.44, box[1] + ch * 0.69), (box[0] + cw * 0.74, box[1] + ch * 0.33)]
            draw.line(points, fill=check_rgba, width=max(1, round(cw * 0.13)), joint="curve")
            for px, py in (points[0], points[-1]):
                dot = cw * 0.065
                draw.ellipse((px - dot, py - dot, px + dot, py + dot), fill=check_rgba)
        return image.resize((w, h), Image.LANCZOS)

    options = {"anchor": "nw", "image": _photo(key, canvas, build)}
    if tags is not None:
        options["tags"] = tags
    return canvas.create_image(left, top, **options)


def round_rect(canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, radius: float, **options) -> int:
    if Image is None:
        radius = max(1.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
        points = [x1 + radius, y1, x2 - radius, y1, x2, y1, x2, y1 + radius, x2, y2 - radius, x2, y2,
                  x2 - radius, y2, x1 + radius, y2, x1, y2, x1, y2 - radius, x1, y1 + radius, x1, y1]
        return canvas.create_polygon(points, smooth=True, splinesteps=12, **options)
    return _shape(canvas, "rect", x1, y1, x2, y2, radius, options.get("fill", ""), options.get("outline", ""),
                  options.get("width", 1.0), options.get("tags"))


def oval(canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, **options) -> int:
    if Image is None:
        return canvas.create_oval(x1, y1, x2, y2, **options)
    return _shape(canvas, "oval", x1, y1, x2, y2, 0, options.get("fill", ""), options.get("outline", ""),
                  options.get("width", 1.0), options.get("tags"))


def check_circle(canvas: tk.Canvas, x1: float, y1: float, x2: float, y2: float, fill: str, mark: str = "#ffffff") -> int:
    """Filled circle with a tick, drawn as one smooth image."""
    if Image is None:
        item = canvas.create_oval(x1, y1, x2, y2, fill=fill, outline=fill)
        w, h = x2 - x1, y2 - y1
        canvas.create_line(x1 + w * 0.25, y1 + h * 0.5, x1 + w * 0.43, y1 + h * 0.68, x1 + w * 0.75, y1 + h * 0.3, fill=mark, width=2)
        return item
    return _shape(canvas, "oval", x1, y1, x2, y2, 0, fill, "", 0, None, check=mark)
