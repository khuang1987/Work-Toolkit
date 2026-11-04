from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parents[1]
sheet = Image.open(root / "assets" / "spritesheet.png").convert("RGBA")
idle = sheet.crop((0, 0, 192, 208))
head = idle.crop((0, 0, 192, 108))
bbox = head.getbbox()
if bbox:
    head = head.crop(bbox)
head.thumbnail((112, 112), Image.Resampling.LANCZOS)
canvas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
canvas.alpha_composite(head, ((128 - head.width) // 2, (128 - head.height) // 2))
canvas.save(root / "assets" / "tray.png", "PNG")
canvas.save(root / "assets" / "tray.ico", "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128)])
