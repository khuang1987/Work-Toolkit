"""Generate work-toolbox.ico from the same "Wt" brand badge used in the window header and floating dock."""
from __future__ import annotations

import json
from pathlib import Path

from main import DEFAULT_ACCENT, render_badge

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "work-toolbox.ico"
SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)


def main() -> None:
    try:
        accent = json.loads((HERE / "tools.json").read_text(encoding="utf-8")).get("app", {}).get("accent", DEFAULT_ACCENT)
    except (OSError, ValueError):
        accent = DEFAULT_ACCENT
    # Pillow derives each ICO size from the largest source image.
    render_badge("Wt", "brand", 256, accent).save(OUTPUT, format="ICO", sizes=[(size, size) for size in SIZES])
    print(OUTPUT)


if __name__ == "__main__":
    main()
