// Measure a weapon's on-screen overlay: which tiles, laid out how, in which
// sprite palette.
//
//   node weapon-oam.cjs 17            # axe
//
// combatant-pose.js draws a blade overlay only for knife / sword / nunchaku /
// staff and returns null for everything else, but the PPU loads distinct CHR
// for axe, spear, claw and rod too — so the game draws weapon art we throw away.
//
// Nothing here is inferred. jsnes decodes OAM into sprX/sprY/sprTile/sprCol,
// so the tiles AND their relative positions AND the palette are read directly;
// there is no "which tile probably goes top-left" step, which is the class of
// guess CLAUDE.md bans for sprite/animation work. Output is checked by
// rendering it back and diffing against the emulator's own framebuffer.

const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM = REPO + '/FF3-English.nes';
const WPN_TILE_LO = 0x49, WPN_TILE_HI = 0x60;   // slots the weapon CHR lands in
const WEAPON_ID = parseInt(process.argv[2], 16);
const OUT = __dirname + `/weapon-oam-${WEAPON_ID.toString(16)}.json`;

const n = new Nes(ROM);
const WPN_SLOT = (c) => 0x6200 + c * 0x40 + 3;
function equip() { for (let c = 0; c < 4; c++) n.ram[WPN_SLOT(c)] = WEAPON_ID; }

n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
equip();

/** Sprites currently drawing weapon CHR, as one meta-sprite. */
function weaponSprites() {
  const ppu = n.nes.ppu;
  const out = [];
  for (let i = 0; i < 64; i++) {
    const t = ppu.sprTile[i];
    if (t < WPN_TILE_LO || t > WPN_TILE_HI) continue;
    const y = ppu.sprY[i], x = ppu.sprX[i];
    if (y >= 0xEF) continue;                       // off-screen parking spot
    out.push({ i, x, y, tile: t, pal: ppu.sprCol[i], hFlip: !!ppu.horiFlip[i], vFlip: !!ppu.vertFlip[i] });
  }
  if (!out.length) return null;
  // Normalise to the group's own top-left so poses can be compared across frames.
  const minX = Math.min(...out.map((s) => s.x)), minY = Math.min(...out.map((s) => s.y));
  for (const s of out) { s.dx = s.x - minX; s.dy = s.y - minY; }
  out.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
  return { minX, minY, sprites: out };
}

const seen = new Map();
// Palette RAM and CHR banks both change MID-FRAME on this machine, so reading
// either after n.run(1) returns whatever was mapped last — usually the UI bank
// at the bottom of the screen, not what was live on the weapon's scanline. This
// is the same trap the monster art capture hit. Snapshot per scanline and index
// by the sprite's own Y.
function frameWithScanlineSnapshots() {
  const ppu = n.nes.ppu;
  const chrByLine = new Map(), palByLine = new Map();
  const orig = ppu.endScanline.bind(ppu);
  ppu.endScanline = () => {
    orig();
    chrByLine.set(ppu.scanline, Buffer.from(n.vram.slice(0, 0x2000)));
    palByLine.set(ppu.scanline, n.palette());
  };
  try { n.nes.frame(); } finally { ppu.endScanline = orig; }
  return { chrByLine, palByLine };
}
function atLine(map, y) {
  for (let s = y; s < y + 30; s++) if (map.has(s)) return map.get(s);
  return map.values().next().value;
}

function watch(frames) {
  for (let f = 0; f < frames; f++) {
    n.run(1);
    equip();
    const g = weaponSprites();
    if (!g) continue;
    const key = g.sprites.map((s) => `${s.dx},${s.dy},${s.tile},${s.pal},${s.hFlip ? 1 : 0},${s.vFlip ? 1 : 0}`).join('|');
    if (seen.has(key)) { seen.get(key).frames++; return; }
    // Re-render one frame with per-scanline snapshots, then read each sprite's
    // CHR and the palette from the state live where that sprite is drawn.
    const { chrByLine, palByLine } = frameWithScanlineSnapshots();
    const g2 = weaponSprites();
    if (!g2) continue;
    const pal = atLine(palByLine, g2.minY + 4);
    const chr = {};
    for (const s of g2.sprites) {
      const bank = atLine(chrByLine, s.y + 4);
      chr[s.tile] = [...bank.slice(0x1000 + s.tile * 16, 0x1000 + s.tile * 16 + 16)];
    }
    seen.set(key, {
      key, frames: 1, firstFrame: n.frames, origin: { x: g.minX, y: g.minY },
      sprites: g.sprites.map(({ dx, dy, tile, pal: p, hFlip, vFlip }) => ({ dx, dy, tile, pal: p, hFlip, vFlip })),
      chr,
      spritePalettes: [0, 1, 2, 3].map((i) => pal.slice(16 + i * 4, 20 + i * 4)),
      // Framebuffer crop covering the group, captured at the same instant.
      // Re-rendering the tiles and diffing against this is what proves the
      // measurement is complete — tiles, layout, palette and flips together —
      // rather than merely self-consistent.
      fb: (() => {
        const w = Math.max(...g.sprites.map((s) => s.dx)) + 8;
        const h = Math.max(...g.sprites.map((s) => s.dy)) + 8;
        const px = [];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) px.push(n.fb[(g.minY + y) * 256 + (g.minX + x)] >>> 0);
        return { w, h, px };
      })(),
    });
  }
}

for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) { equip(); n.press('a', 8, 25); watch(40); }
  equip(); n.press('down', 8, 40); watch(20);
}
for (let i = 0; i < 40; i++) { equip(); n.press('a', 6, 10); watch(60); }

// jsnes renders through its OWN palette (0x525252... where the standard table
// has 0x626262), so verifying by comparing framebuffer RGB against
// NES_SYSTEM_PALETTE can never match even when every color index is right — it
// reported 131/190 "mismatches" on a capture that was correct. Ship the
// emulator's table with the capture so the check compares like with like.
const emuPalette = [...n.nes.ppu.palTable.curTable].map((v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);

const poses = [...seen.values()].sort((a, b) => b.frames - a.frames);
console.log(`weapon $${WEAPON_ID.toString(16)}: ${poses.length} distinct overlay poses`);
for (const p of poses.slice(0, 8)) {
  const tiles = p.sprites.map((s) => '$' + s.tile.toString(16)).join(',');
  const layout = p.sprites.map((s) => `${s.dx},${s.dy}`).join(' ');
  console.log(`  ${String(p.frames).padStart(4)} frames  ${p.sprites.length} spr  pal${p.sprites[0].pal}  tiles ${tiles}  at ${layout}`);
}
writeFileSync(OUT, JSON.stringify({ emuPalette, poses }));
console.log('->', OUT);
