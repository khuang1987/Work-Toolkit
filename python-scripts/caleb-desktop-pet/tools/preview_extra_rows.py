from pathlib import Path
from PIL import Image
BASE = Path(__file__).resolve().parents[1]
sheet = Image.new('RGBA', (768, 832), 'white')
for row, name in enumerate(('climb', 'lean')):
    source = Image.open(BASE / 'qa-extra' / (name + '.png')).convert('RGBA')
    sheet.alpha_composite(source, (0, row * 416))
    dark = Image.new('RGBA', source.size, '#172237')
    dark.alpha_composite(source)
    sheet.alpha_composite(dark, (0, row * 416 + 208))
    frames = [source.crop((i * 192, 0, (i + 1) * 192, 208)) for i in range(4)]
    frames[0].save(BASE / 'qa-extra' / (name + '.webp'), save_all=True, append_images=frames[1:], duration=220 if name == 'climb' else 650, loop=0, lossless=True)
sheet.save(BASE / 'qa-extra' / 'contact.png')
