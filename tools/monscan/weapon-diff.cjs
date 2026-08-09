// Extract a weapon overlay by DIFFERENTIAL RENDERING.
//
//   node weapon-diff.cjs 17          # axe
//
// weapon-oam.cjs reads tiles/layout/palette out of OAM and then re-renders them
// to check the result — and that check never reached exact (30/190 pixels off),
// because re-rendering means re-implementing sprite compositing: priority
// against the background, palette selection, flips, the Y+1 offset. Every one of
// those is a chance to be wrong, and being wrong there is what CLAUDE.md's
// prohibition is about.
//
// So don't re-render. Let the emulator draw the frame twice — once as-is, once
// with the weapon's sprites parked off-screen — and subtract. Pixels that changed
// ARE the weapon, exactly as the PPU composited them. Nothing about priority,
// palettes or flips has to be modelled, because the emulator already applied it.
//
// Requires rewinding, which nes.cjs save()/load() provides.

const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM = REPO + '/FF3-English.nes';
const WPN_TILE_LO = 0x49, WPN_TILE_HI = 0x60;
const OAM_SHADOW = 0x0200;   // page the game DMAs into OAM each frame
const WEAPON_ID = parseInt(process.argv[2], 16);
const OUT = __dirname + `/weapon-diff-${WEAPON_ID.toString(16)}.json`;

const n = new Nes(ROM);
const WPN_SLOT = (c) => 0x6200 + c * 0x40 + 3;
function equip() { for (let c = 0; c < 4; c++) n.ram[WPN_SLOT(c)] = WEAPON_ID; }

n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
equip();

/** OAM indices currently holding weapon CHR. */
function weaponOam() {
  const p = n.nes.ppu, out = [];
  for (let i = 0; i < 64; i++) {
    const t = p.sprTile[i];
    if (t >= WPN_TILE_LO && t <= WPN_TILE_HI && p.sprY[i] < 0xEF) out.push(i);
  }
  return out;
}

/**
 * One frame with the weapon present, one with it hidden, then subtract.
 *
 * Hiding is done in spriteMem (the raw OAM bytes the PPU evaluates), not in the
 * decoded sprY mirror — writing the mirror alone would leave the real OAM
 * untouched and both renders identical.
 */
function extract() {
  const idx = weaponOam();
  if (!idx.length) return null;
  const state = n.save();

  n.nes.frame();
  const withWpn = Uint32Array.from(n.fb);
  const p = n.nes.ppu;
  const geom = idx.map((i) => ({ i, x: p.sprX[i], y: p.sprY[i], tile: p.sprTile[i] }));

  n.load(state);
  // Park the sprites in the OAM SHADOW at $0200, not in the PPU's OAM. The game
  // re-uploads the whole shadow page by DMA every frame, so writing spriteMem
  // (or its decoded mirror) is overwritten before rendering — both frames came
  // back pixel-identical, 0 of 61440 differing. $0200 confirmed by finding the
  // weapon's OAM bytes mirrored at $240 for OAM index 16.
  for (const i of idx) n.ram[OAM_SHADOW + i * 4] = 0xF0;
  n.nes.frame();
  const without = Uint32Array.from(n.fb);

  n.load(state);

  const px = [];
  let minX = 256, minY = 240, maxX = -1, maxY = -1;
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 256; x++) {
      const k = y * 256 + x;
      if (withWpn[k] === without[k]) continue;
      px.push({ x, y, rgb: withWpn[k] >>> 0 });
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!px.length) return null;
  return {
    frame: n.frames, geom,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    px: px.map((p2) => ({ dx: p2.x - minX, dy: p2.y - minY, rgb: p2.rgb })),
  };
}

const emuPalette = [...n.nes.ppu.palTable.curTable].map((v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
const found = new Map();
function scan(frames) {
  for (let f = 0; f < frames; f++) {
    n.run(1); equip();
    if (!weaponOam().length) continue;
    const r = extract();
    if (!r) continue;
    const key = r.geom.map((g) => `${g.tile}@${g.x},${g.y}`).join('|');
    if (!found.has(key)) found.set(key, r); else found.get(key).seen = (found.get(key).seen || 1) + 1;
  }
}
for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) { equip(); n.press('a', 8, 25); scan(30); }
  equip(); n.press('down', 8, 40); scan(15);
}
for (let i = 0; i < 25; i++) { equip(); n.press('a', 6, 10); scan(40); }

const poses = [...found.values()];
console.log(`weapon $${WEAPON_ID.toString(16)}: ${poses.length} distinct poses`);
for (const p of poses.slice(0, 8)) {
  const cols = new Set(p.px.map((q) => q.rgb));
  console.log(`  ${p.box.w}x${p.box.h} at ${p.box.x},${p.box.y}  ${p.px.length} px  ${cols.size} colors  tiles ${p.geom.map((g) => '$' + g.tile.toString(16)).join(',')}`);
}
writeFileSync(OUT, JSON.stringify({ emuPalette, poses }));
console.log('->', OUT);
