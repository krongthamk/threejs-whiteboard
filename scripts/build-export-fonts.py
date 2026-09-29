"""Unwrap shipped WOFF fonts to TTF and record their exact cmap coverage for export.

Requires fonttools==4.59.2. Run from the repository root after deliberately
changing a shipped WOFF; glyph data and licenses stay unchanged. Prebuilt TTF
files and the generated coverage JSON are committed for ordinary builds.
"""
import argparse
import hashlib
import json
from pathlib import Path
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--coverage-only', action='store_true', help='Keep existing TTF bytes and regenerate only their exact cmap coverage.')
args = parser.parse_args()
project = Path(__file__).resolve().parent.parent
root = project / 'packages/app/public/fonts'
faces = [('Inter', 'inter-latin-400-normal'), ('IBM Plex Mono', 'ibm-plex-mono-latin-400-normal'), ('Noto Sans JP', 'noto-sans-jp-400')]
coverage = {}
for family, stem in faces:
    path = root / f'{stem}.ttf'
    if not args.coverage_only:
        font = TTFont(root / f'{stem}.woff', recalcTimestamp=False)
        font.flavor = None
        font.save(path)
    font = TTFont(path)
    ranges = []
    for codepoint in sorted(font.getBestCmap()):
        if ranges and codepoint == ranges[-1][1] + 1:
            ranges[-1][1] = codepoint
        else:
            ranges.append([codepoint, codepoint])
    coverage[family] = {'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'ranges': ranges}
(project / 'packages/app/src/export-font-coverage.generated.json').write_text(json.dumps(coverage, ensure_ascii=False, separators=(',', ':')) + '\n')
