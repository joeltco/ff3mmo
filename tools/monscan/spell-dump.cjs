// Emit a captured spell as a REC OAM dump, in the format the existing harness
// already parses.
//
//   node spell-dump.cjs 31 > /tmp/fire.txt
//   node tools/render-oam-dump.js /tmp/fire.txt
//   node tools/classify-spell-phases.js /tmp/fire.txt
//   node tools/parity-check-spell.js fire /tmp/fire.txt
//
// Deliberately does NOT decide what any of it means. tools/classify-spell-
// phases.js exists to assign cast / projectile / impact phases mechanically,
// and tools/parity-check-spell.js exists to gate the bytes — CLAUDE.md is
// explicit that phase-mapping by hand is where every previous spell attempt
// broke. This tool's whole job is to remove the manual Mesen capture step, so
// that harness can run on any spell instead of only the ones captured by hand.
//
// Tile bytes come from the ROM, at the offset the capture proved was copied
// into that slot — not from the framebuffer. Sprite palettes come from palette
// RAM at that frame. Neither path involves matching colours.

const { readFileSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const sweep = JSON.parse(readFileSync(__dirname + '/spell-sweep.json', 'utf8'));

const want = parseInt(process.argv[2] || '31', 16);
const rec = sweep.results.find((r) => r.id === want);
if (!rec) { console.error(`spell $${want.toString(16)} not in the sweep`); process.exit(2); }
if (!rec.frames || !rec.frames.length) { console.error(`spell $${want.toString(16)} drew no effect sprites`); process.exit(3); }

/** slot -> ROM offset, for the blocks live at `frame`. */
function slotSource(frame) {
  const map = new Map();
  for (const b of rec.blocks) {
    if (frame < b.first || frame > b.last) continue;
    for (const s of b.slots) map.set(s, b.off);
  }
  return map;
}

/**
 * Cluster sprites into meta-sprite groups by XY adjacency, the same way the
 * EMU tab's SNAP OAM does — the dump format is per-group with a shared origin,
 * and the classifier keys off group origins.
 */
function group(spr) {
  const parent = spr.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < spr.length; i++) {
    for (let j = i + 1; j < spr.length; j++) {
      if (Math.abs(spr[i].x - spr[j].x) <= 8 && Math.abs(spr[i].y - spr[j].y) <= 8) {
        parent[find(i)] = find(j);
      }
    }
  }
  const by = new Map();
  spr.forEach((s, i) => {
    const k = find(i);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  });
  return [...by.values()].map((tiles) => {
    // OAM y is one scanline above where the sprite actually draws.
    const ox = Math.min(...tiles.map((t) => t.x));
    const oy = Math.min(...tiles.map((t) => t.y)) + 1;
    return { ox, oy, tiles: tiles.sort((a, b) => (a.y - b.y) || (a.x - b.x)) };
  }).sort((a, b) => (a.oy - b.oy) || (a.ox - b.ox));
}

const p2 = (v) => '0x' + v.toString(16).toUpperCase().padStart(2, '0');
let t0 = rec.frames[0].f;
const NES_FRAME_MS = 1000 / 60.0988;

console.log(`// Headless REC OAM dump — spell $${want.toString(16).padStart(2, '0')} (${rec.school} level ${8 - rec.row} column ${rec.col})`);
console.log(`// tools/monscan/spell-dump.cjs; tile bytes read from ROM at the offsets the`);
console.log(`// capture proved were copied into each slot. BG palettes not captured.`);

// A sprite only belongs to the spell if the slot it names is holding one of the
// spell's ROM blocks ON THAT FRAME. The damage digits live in $56-$5F, inside
// the same $49-$60 window the effect is copied into, so without this the dump
// opens with digit sprites — which is exactly the tile mix-up that produced the
// v1.7.87 "scorch impact" that was really a damage popup.
const live = rec.frames
  .map((fr) => ({ ...fr, src: slotSource(fr.f) }))
  .map((fr) => ({ ...fr, spr: fr.spr.filter((s) => fr.src.has(s.tile)) }))
  .filter((fr) => fr.spr.length);
if (!live.length) { console.error(`spell $${want.toString(16)}: no frame draws a sprite from its own blocks`); process.exit(4); }

t0 = live[0].f;
live.forEach((fr, idx) => {
  const src = fr.src;
  console.log(`// ═══ frame ${idx} (snap @ f${fr.f}, t≈${Math.round((fr.f - t0) * NES_FRAME_MS)}ms) ═══════════════════════`);
  for (let i = 0; i < 4; i++) {
    console.log(`//  SP${i}: [${fr.pal.slice(i * 4, i * 4 + 4).map(p2).join(', ')}]`);
  }
  group(fr.spr).forEach((g, gi) => {
    console.log(`// ── group ${gi} (${g.tiles.length} tiles, origin ${g.ox},${g.oy}) ──`);
    for (const t of g.tiles) {
      const off = src.get(t.tile);
      const flags = `${t.v ? ' VFLIP' : ''}${t.h ? ' HFLIP' : ''}`;
      console.log(`//   [${t.x - g.ox},${t.y + 1 - g.oy}] tile=$${t.tile.toString(16).toUpperCase()} pal${t.pal}${flags}`);
      const bytes = [...rom.slice(off, off + 16)].map((b) => '0x' + b.toString(16).padStart(2, '0'));
      console.log(`new Uint8Array([${bytes.join(',')}]),`);
    }
  });
});
console.error(`spell $${want.toString(16)}: ${rec.frames.length} frames, blocks ` +
  rec.blocks.map((b) => '$' + b.off.toString(16)).join(','));
