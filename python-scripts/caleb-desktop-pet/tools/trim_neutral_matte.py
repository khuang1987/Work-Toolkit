from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


CELL_W, CELL_H = 192, 208


def trim_neutral_matte(
    image: Image.Image,
    passes: int,
    neutral_spread: int,
    alpha_maximum: int,
) -> tuple[Image.Image, list[int]]:
    image = image.convert("RGBA")
    pixels = image.load()
    removed_by_pass: list[int] = []

    for _ in range(passes):
        removed = 0
        for row in range(image.height // CELL_H):
            for col in range(image.width // CELL_W):
                x0, y0 = col * CELL_W, row * CELL_H
                alpha = [
                    [pixels[x0 + x, y0 + y][3] for x in range(CELL_W)]
                    for y in range(CELL_H)
                ]
                for y in range(1, CELL_H - 1):
                    for x in range(1, CELL_W - 1):
                        red, green, blue, current_alpha = pixels[x0 + x, y0 + y]
                        if current_alpha == 0:
                            continue
                        direct_edge = min(alpha[y][x - 1], alpha[y][x + 1], alpha[y - 1][x], alpha[y + 1][x]) == 0
                        if not direct_edge or current_alpha > alpha_maximum:
                            continue
                        is_neutral_matte = max(red, green, blue) - min(red, green, blue) <= neutral_spread
                        is_legacy_orange = (
                            red >= 190
                            and 55 <= green <= 150
                            and blue <= 90
                            and red - green >= 80
                        )
                        is_chroma_fringe = (
                            (red - 255) ** 2
                            + (green - 106) ** 2
                            + (blue - 32) ** 2
                            <= 96 ** 2
                        )
                        if not is_neutral_matte and not is_legacy_orange and not is_chroma_fringe:
                            continue
                        pixels[x0 + x, y0 + y] = (0, 0, 0, 0)
                        removed += 1
        removed_by_pass.append(removed)

    return image, removed_by_pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Trim neutral gray matte pixels from a v2 pet atlas.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--passes", type=int, default=2)
    parser.add_argument("--neutral-spread", type=int, default=32)
    parser.add_argument("--alpha-maximum", type=int, default=192)
    args = parser.parse_args()

    image, removed_by_pass = trim_neutral_matte(
        Image.open(args.input),
        max(1, args.passes),
        max(0, args.neutral_spread),
        max(1, min(255, args.alpha_maximum)),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output)
    args.report.write_text(
        json.dumps(
            {
                "ok": True,
                "input": str(args.input.resolve()),
                "output": str(args.output.resolve()),
                "passes": max(1, args.passes),
                "neutral_spread": max(0, args.neutral_spread),
                "alpha_maximum": max(1, min(255, args.alpha_maximum)),
                "removed_by_pass": removed_by_pass,
                "removed_pixels": sum(removed_by_pass),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
