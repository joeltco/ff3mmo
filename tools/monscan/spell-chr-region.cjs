// Render the battle-effect CHR region straight out of the ROM.
//
//   node spell-chr-region.cjs [startHex] [endHex] > /dev/null
//
// Every one of the 66 already-verified animation tiles in spell-anim.js /
// cast-anim.js / cure-anim.js was found verbatim in the ROM between $55610 and
// $563BF — uncompressed, 16 bytes per tile, in ascending sprite-slot order.
// So spell art is NOT compressed and NOT scattered: it is a linear tile bank
// that the game copies into sprite slots $49+ at animation time.
//
// That changes what a live capture has to prove. It no longer has to reproduce
// pixels — it only has to identify WHICH block was copied, which is an exact
// 16-byte match against this region. The bytes themselves then come from here.
//
// This tool draws the region so its block structure can be seen and counted,
// and prints where each known-good constant falls inside it.

const { readFileSync, writeFileSync } = require('fs');
const { encodePng } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const START = parseInt(process.argv[2] || '55400', 16);
const END = parseInt(process.argv[3] || '56800', 16);
const PER_ROW = 16;
const SCALE = 4;

// Flat greyscale ramp. The real palettes are per-spell and live in PPU RAM at
// cast time; this is for reading STRUCTURE, so colour would only mislead.
const RAMP = [0x000000, 0x555555, 0xAAAAAA, 0xFFFFFF];

const tileCount = (END - START) / 16;
const rows = Math.ceil(tileCount / PER_ROW);
const W = PER_ROW * 8 * SCALE, H = rows * 8 * SCALE;
const fb = new Uint32Array(W * H);

for (let t = 0; t < tileCount; t++) {
  const off = START + t * 16;
  const tx = (t % PER_ROW) * 8, ty = Math.floor(t / PER_ROW) * 8;
  for (let y = 0; y < 8; y++) {
    const lo = rom[off + y], hi = rom[off + y + 8];
    for (let x = 0; x < 8; x++) {
      const bit = 7 - x;
      const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      const c = RAMP[v];
      // jsnes' encoder wants 0xAABBGGRR.
      const px = 0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          fb[(ty + y) * SCALE * W + sy * W + (tx + x) * SCALE + sx] = px;
        }
      }
    }
  }
}
const out = '/tmp/spell-chr-region.png';
writeFileSync(out, encodePng(fb, W, H));

// ── where the known-good constants land ────────────────────────────
const known = [];
for (const f of ['src/spell-anim.js', 'src/cast-anim.js', 'src/projectile-anim.js', 'src/cure-anim.js']) {
  let src;
  try { src = readFileSync(REPO + '/' + f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/const ([A-Z0-9_]+) = new Uint8Array\(\[([^\]]+)\]\)/g)) {
    const b = m[2].split(',').map((s) => parseInt(s.trim(), 16));
    if (b.length !== 16) continue;
    // Search WITHIN the region, so a duplicate copy elsewhere in the ROM
    // (FLAME_T_4C also lives at $41640) cannot pull the anchor off-region.
    const idx = rom.indexOf(Buffer.from(b), START);
    if (idx >= 0 && idx < END) known.push({ name: m[1], off: idx, tile: (idx - START) / 16 });
  }
}
known.sort((a, b) => a.off - b.off);
console.log(`region $${START.toString(16)}-$${END.toString(16)}: ${tileCount} tiles, ${rows} rows of ${PER_ROW}`);
console.log(`${known.length} verified constants fall inside it\n`);
let prev = null;
for (const k of known) {
  const gap = prev === null ? 0 : k.off - prev;
  if (gap > 16) console.log(`      ---- ${(gap / 16 - 1)} unidentified tile(s) ----`);
  console.log(`  $${k.off.toString(16)}  row ${String(Math.floor(k.tile / PER_ROW)).padStart(2)} col ${String(k.tile % PER_ROW).padStart(2)}  ${k.name}`);
  prev = k.off;
}
console.log(`\n-> ${out}  (${W}x${H})`);
