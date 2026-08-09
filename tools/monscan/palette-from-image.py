#!/usr/bin/env python3
"""Recover a monster's real pal0/pal1 from a reference screenshot.

    python3 tools/monscan/palette-from-image.py <image> <monsterId hex>

Six monsters (0x35 Fury, 0x63 Captain, 0x66 Phoenix, 0x8D Hobgoblin,
0xBE Spriggan, 0xBF TerribleD) appear in no encounter monster list in either
ROM, so there is no palette to capture off the PPU — the emulator can never be
made to draw them. A reference image of the real sprite is the only remaining
source, and this reads it rather than guessing.

Method avoids having to align the image with our sprite at all:

  1. Collect the distinct colors in the image, ignoring the background.
  2. Snap each to the nearest of the 64 NES system colors.
  3. Search PALETTE_TABLE for the (pal0, pal1) pair whose six visible colors
     best cover that set.

Alignment-free matters because reference shots are often scaled, padded, or
sitting on a wiki background, and a misaligned per-pixel read would silently
produce a wrong answer that still looks plausible.

Reports the residual so a poor match is visible rather than assumed good: a
real hit should place every image color exactly on a palette color.
"""
import sys, json, re, collections
from PIL import Image

REPO = '/home/joeltco/projects/ff3mmo'
SPRITES = REPO + '/src/data/monster-sprites-rom.js'


def nes_palette():
    """The 64-entry NES system palette, read from src/tile-decoder.js."""
    src = open(REPO + '/src/tile-decoder.js').read()
    blk = src[src.index('NES_SYSTEM_PALETTE = ['):]
    blk = blk[:blk.index('];')]
    return [tuple(int(x, 16) for x in m)
            for m in re.findall(r'\[0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2})\]', blk)]


def palette_table():
    src = open(SPRITES).read()
    blk = src[src.index('export const PALETTE_TABLE = ['):]
    blk = blk[:blk.index('\n];')]
    return [[int(x, 16) for x in m]
            for m in re.findall(r'\[0x([0-9a-f]{2}),\s*0x([0-9a-f]{2}),\s*0x([0-9a-f]{2}),\s*0x([0-9a-f]{2})\]', blk)]


def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    path, mid = sys.argv[1], int(sys.argv[2], 16)
    SYS = nes_palette()
    TABLE = palette_table()

    im = Image.open(path).convert('RGB')
    counts = collections.Counter(im.getdata())
    # The most common color is the backdrop; drop it and anything vanishingly
    # rare (JPEG ringing, antialiased wiki captions bleeding in).
    bg, _ = counts.most_common(1)[0]
    total = sum(counts.values())
    colors = [c for c, n in counts.items() if c != bg and n / total > 0.002]
    print(f'image {path}: {len(counts)} distinct colors, backdrop {bg}, {len(colors)} significant')

    def nearest(c):
        return min(range(len(SYS)), key=lambda i: sum((SYS[i][k] - c[k]) ** 2 for k in range(3)))

    snapped = {}
    for c in colors:
        i = nearest(c)
        d = sum((SYS[i][k] - c[k]) ** 2 for k in range(3)) ** 0.5
        snapped[c] = (i, d)
        print(f'  rgb{c} -> NES ${i:02x} {SYS[i]}  dist {d:.1f}')

    want = set(i for i, _ in snapped.values())
    best = []
    for a in range(len(TABLE)):
        for b in range(len(TABLE)):
            have = set(TABLE[a][1:]) | set(TABLE[b][1:])
            missing = len(want - have)
            best.append((missing, len(have - want), a, b))
    best.sort()
    print('\nbest (pal0, pal1) candidates — missing = image colors the pair cannot produce:')
    for missing, extra, a, b in best[:5]:
        f = lambda p: ' '.join(f'${c:02x}' for c in p)
        print(f'  pal0 #{a:<3} [{f(TABLE[a])}]   pal1 #{b:<3} [{f(TABLE[b])}]   missing {missing}, unused {extra}')
    if best and best[0][0] > 0:
        print(f'\nNOTE: best pair still cannot produce {best[0][0]} of the image colors — '
              'the reference may be recompressed, recolored, or not this sprite.')


main()
