"""Deterministic extraction of approved source strips; no synthetic poses."""
from pathlib import Path
import json
from PIL import Image
from restore_originals import extract

BASE = Path(__file__).resolve().parents[1]
OUT = BASE / 'qa-extra'


def main():
    OUT.mkdir(exist_ok=True)
    report = []
    for name, filename in [('climb', 'climb-v2.png'), ('lean', 'lean.png')]:
        source = BASE / 'extra-sources' / filename
        poses = extract(source, 4)
        scale = min(166 / max(p.width for p, _ in poses), 188 / max(p.height for p, _ in poses))
        strip = Image.new('RGBA', (768, 208))
        for i, (pose, _box) in enumerate(poses):
            pose = pose.resize((round(pose.width * scale), round(pose.height * scale)), Image.Resampling.LANCZOS)
            strip.alpha_composite(pose, (i * 192 + 178 - pose.width, 200 - pose.height))
        strip.save(OUT / (name + '-raw.png'))
        report.append({'action': name, 'source': str(source), 'frames': 4, 'scale': scale, 'contact_x': 178})
    (OUT / 'provenance.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
