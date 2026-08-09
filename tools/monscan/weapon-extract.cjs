// Extract one weapon's battle overlay, end to end.
//
//   node weapon-extract.cjs 17            # axe
//
// Combines the two measurements that each solve half the problem:
//
//   1. WHICH TILES are this weapon's. The $49-$60 slot range also holds the
//      character's fist and the damage digits ($56-$5F), so "a sprite in that
//      range" is not "the weapon". But the slots are re-decompressed per
//      equipped weapon, so the tiles that DIFFER from a knife baseline are
//      exactly this weapon's. Measured, not chosen.
//
//   2. WHAT IT LOOKS LIKE. Render the frame twice, once with those sprites
//      parked in the OAM shadow at $0200, and subtract. The changed pixels are
//      the weapon as the PPU composited it — priority, palette and flips already
//      applied, so none of it has to be re-implemented.
//
// Deliberately NOT filtered by "capture twice and keep what repeats": jsnes is
// deterministic, so a second identical run reproduces the damage numbers too and
// filters nothing. The noise came from comparing runs of DIFFERENT weapons,
// which roll different damage.

const { writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM = REPO + '/FF3-English.nes';
const LO = 0x49, HI = 0x60;
const OAM_SHADOW = 0x0200;
const BASELINE = 0x1E;                     // the knife the party starts with

const WEAPON_ID = parseInt(process.argv[2], 16);
const OUT = __dirname + `/weapon-extract-${WEAPON_ID.toString(16)}.json`;

function boot(weaponId) {
  const n = new Nes(ROM);
  const slot = (c) => 0x6200 + c * 0x40 + 3;
  const equip = () => { for (let c = 0; c < 4; c++) n.ram[slot(c)] = weaponId; };
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  equip();
  return { n, equip };
}
const wpnOam = (n) => {
  const p = n.nes.ppu, o = [];
  for (let i = 0; i < 64; i++) {
    const t = p.sprTile[i];
    if (t >= LO && t <= HI && p.sprY[i] < 0xEF) o.push(i);
  }
  return o;
};

/** Every distinct byte-pattern the weapon slots hold across a fight, per slot. */
function chrBySlot(weaponId) {
  const { n, equip } = boot(weaponId);
  const bySlot = new Map();
  const sample = () => {
    for (let t = LO; t <= HI; t++) {
      const hex = Buffer.from(n.vram.slice(0x1000 + t * 16, 0x1000 + t * 16 + 16)).toString('hex');
      if (hex === '0'.repeat(32)) continue;
      if (!bySlot.has(t)) bySlot.set(t, new Set());
      bySlot.get(t).add(hex);
    }
  };
  for (let b = 0; b < 10; b++) {
    for (let k = 0; k < 6; k++) { equip(); n.press('a', 8, 25); for (let f = 0; f < 30; f++) { n.run(1); equip(); sample(); } }
    equip(); n.press('down', 8, 40); for (let f = 0; f < 15; f++) { n.run(1); equip(); sample(); }
  }
  for (let i = 0; i < 25; i++) { equip(); n.press('a', 6, 10); for (let f = 0; f < 40; f++) { n.run(1); equip(); sample(); } }
  return bySlot;
}

console.log(`baseline knife $${BASELINE.toString(16)}...`);
const base = chrBySlot(BASELINE);
console.log(`weapon $${WEAPON_ID.toString(16)}...`);
const mine = chrBySlot(WEAPON_ID);

// A slot is this weapon's if it ever holds bytes the knife never puts there.
const ownTiles = new Set();
for (const [slot, pats] of mine) {
  const basePats = base.get(slot) || new Set();
  for (const p of pats) if (!basePats.has(p)) { ownTiles.add(slot); break; }
}
console.log(`slots carrying weapon-specific CHR: ${[...ownTiles].map((t) => '$' + t.toString(16)).join(',') || '(none)'}`);
if (!ownTiles.size) { console.log('no weapon-specific CHR — this class may reuse the knife art'); process.exit(2); }

// Differential render, keeping only groups built entirely from those slots.
const { n, equip } = boot(WEAPON_ID);
const emuPalette = [...n.nes.ppu.palTable.curTable].map((v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
const poses = new Map();

function grab() {
  const idx = wpnOam(n).filter((i) => ownTiles.has(n.nes.ppu.sprTile[i]));
  if (!idx.length) return;
  const state = n.save();
  n.nes.frame();
  const A = Uint32Array.from(n.fb);
  const p = n.nes.ppu;
  const geom = idx.map((i) => ({ x: p.sprX[i], y: p.sprY[i], tile: p.sprTile[i] }));
  n.load(state);
  for (const i of idx) n.ram[OAM_SHADOW + i * 4] = 0xF0;
  n.nes.frame();
  const B = Uint32Array.from(n.fb);
  n.load(state);

  let minX = 256, minY = 240, maxX = -1, maxY = -1;
  const px = [];
  for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) {
    const k = y * 256 + x;
    if (A[k] === B[k]) continue;
    px.push({ x, y, rgb: A[k] >>> 0 });
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!px.length) return;
  const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  if (box.w > 24 || box.h > 24) return;                    // not a weapon overlay
  const key = geom.map((g) => `${g.tile}`).sort().join(',') + `#${box.w}x${box.h}`;
  // Store CHR and the sprite palettes too. Colors must come from palette RAM,
  // not from framebuffer RGB: jsnes renders through its own palette, so nearest-
  // matching those pixels against NES_SYSTEM_PALETTE lands on the wrong index for
  // 62% of them (median distance 46.9). The diff is for deciding WHICH pixels are
  // the weapon; CHR + palette RAM is for deciding what color they are.
  const pl = p.f_spPatternTable ? 0x1000 : 0x0000;
  const chr = {};
  for (const g of geom) chr[g.tile] = [...n.vram.slice(pl + g.tile * 16, pl + g.tile * 16 + 16)];
  const palRam = n.palette();
  const sprPal = [0, 1, 2, 3].map((i) => palRam.slice(16 + i * 4, 20 + i * 4));
  const attrs = idx.map((i) => ({ tile: p.sprTile[i], pal: p.sprCol[i] >> 2, hFlip: !!p.horiFlip[i], vFlip: !!p.vertFlip[i], x: p.sprX[i], y: p.sprY[i] }));
  const rec = { key, box, geom, chr, sprPal, attrs, px: px.map((q) => ({ dx: q.x - minX, dy: q.y - minY, rgb: q.rgb })) };
  if (!poses.has(key)) poses.set(key, { ...rec, seen: 1 }); else poses.get(key).seen++;
}

for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) { equip(); n.press('a', 8, 25); for (let f = 0; f < 30; f++) { n.run(1); equip(); grab(); } }
  equip(); n.press('down', 8, 40); for (let f = 0; f < 15; f++) { n.run(1); equip(); grab(); }
}
for (let i = 0; i < 25; i++) { equip(); n.press('a', 6, 10); for (let f = 0; f < 40; f++) { n.run(1); equip(); grab(); } }

const out = [...poses.values()].sort((a, b) => b.seen - a.seen);
console.log(`${out.length} distinct weapon poses`);
for (const p of out.slice(0, 6)) {
  const cols = new Set(p.px.map((q) => q.rgb)).size;
  console.log(`  ${String(p.seen).padStart(4)}x  ${p.box.w}x${p.box.h}  ${p.px.length}px  ${cols} colors  tiles ${p.geom.map((g) => '$' + g.tile.toString(16)).join(',')}`);
}
writeFileSync(OUT, JSON.stringify({ weaponId: WEAPON_ID, ownTiles: [...ownTiles], emuPalette, poses: out }));
console.log('->', OUT);
