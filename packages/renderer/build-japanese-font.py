"""Build the shipped regular-weight WOFF from the official Google Fonts TTF.

Requires fonttools==4.59.2 and skia-pathops==0.9.2. Usage: python build-japanese-font.py INPUT.ttf OUTPUT.woff
No glyph subsetting: preserve the official Noto Sans JP character coverage.
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont, OverlapMode

font = TTFont(sys.argv[1])
font = instantiateVariableFont(font, {"wght": 400}, inplace=True, overlap=OverlapMode.REMOVE)
font.flavor = "woff"
font.save(sys.argv[2])
print(f"Saved {len(font.getBestCmap())} Unicode mappings at regular weight 400")
