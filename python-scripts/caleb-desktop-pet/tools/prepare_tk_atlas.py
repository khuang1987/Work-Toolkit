from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def prepare_atlas(image: Image.Image, alpha_cutoff: int) -> tuple[Image.Image, dict[str, int]]:
    """Make a complete RGBA atlas safe for Tk's color-keyed window.

    Tk blends semi-transparent image pixels against the window color before
    Windows removes that color. Making the surviving edge pixels opaque keeps
    the original sprite RGB and prevents a green fringe. Only near-invisible
    pixels are discarded; pose pixels and frame geometry are otherwise kept.
    """
    image = image.convert("RGBA")
    source = image.copy()
    source_pixels = source.load()
    pixels = image.load()
    removed = 0
    made_opaque = 0
    recolored_edges = 0
    cleared_hidden = 0
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                if (red, green, blue) != (0, 0, 0):
                    cleared_hidden += 1
                pixels[x, y] = (0, 0, 0, 0)
            elif alpha < alpha_cutoff:
                pixels[x, y] = (0, 0, 0, 0)
                removed += 1
            elif alpha < 255:
                edge_color = None
                for distance in (1, 2):
                    candidates = []
                    for dx in range(-distance, distance + 1):
                        for dy in range(-distance, distance + 1):
                            if max(abs(dx), abs(dy)) != distance:
                                continue
                            nx, ny = x + dx, y + dy
                            if 0 <= nx < image.width and 0 <= ny < image.height:
                                candidate = source_pixels[nx, ny]
                                if candidate[3] == 255:
                                    candidates.append(candidate[:3])
                    if candidates:
                        edge_color = candidates[0]
                        break
                if edge_color is not None:
                    red, green, blue = edge_color
                    recolored_edges += 1
                pixels[x, y] = (red, green, blue, 255)
                made_opaque += 1
    return image, {
        "removed_near_invisible_pixels": removed,
        "made_edge_pixels_opaque": made_opaque,
        "recolored_edge_pixels": recolored_edges,
        "cleared_hidden_rgb_pixels": cleared_hidden,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a complete RGBA atlas for Tk color-key rendering.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--alpha-cutoff", type=int, default=24)
    args = parser.parse_args()
    cutoff = max(1, min(254, args.alpha_cutoff))
    image, counts = prepare_atlas(Image.open(args.input), cutoff)
    if image.size != (1536, 2288):
        raise SystemExit(f"expected 1536x2288 atlas, got {image.size}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG")
    args.report.write_text(
        json.dumps(
            {
                "ok": True,
                "input": str(args.input.resolve()),
                "output": str(args.output.resolve()),
                "alpha_cutoff": cutoff,
                "preserved_atlas_size": [1536, 2288],
                **counts,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
