#!/usr/bin/env node
// find-structures.mjs — what STRUCTURES exist in a tileset, straight from the
// ROM maps that use it.
//
// A dungeon skin needs decorations drawn from real cartridge art (altars,
// daises, doors, machinery). Those are RARE tile ids arranged in small
// clusters, sitting in a sea of ceiling/rock/floor. This histograms every map
// on a tileset, drops the bulk terrain, and reports the leftovers grouped into
// contiguous blobs with their bounding boxes — so a candidate can be rendered
// and looked at instead of guessed.
//
// Built because the Cave of Seals boss chamber has no pedestal: tiles $3a-$3f
// only depict an altar in TILESET 2, and asking "should it have one?" is not an
// answer when the ROM can be asked instead.
//
//   node tools/find-structures.mjs 0            # cave tileset
//   node tools/find-structures.mjs 0 --min 2 --max 40
//   node tools/find-structures.mjs 2            # crystal tileset (the altar)

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadMap } = await import('../src/map-loader.js');

const args = process.argv.slice(2);
const TILESET = Number(args[0] ?? 0);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : Number(args[i + 1]); };
const MAXCOUNT = flag('max', 60);     // ids more common than this are terrain
const MINCOUNT = flag('min', 1);

const PROPS = 0x004010;
const maps = [];
for (let m = 0; m < 256; m++) {
  if (((rom[PROPS + m * 16] >> 5) & 7) !== TILESET) continue;
  try { const md = loadMap(rom, m); maps.push({ id: m, tm: md.tilemap ?? md.tiles }); } catch {}
}

const hist = new Map();
for (const { tm } of maps) for (const v of tm) hist.set(v, (hist.get(v) || 0) + 1);

const rare = [...hist].filter(([, c]) => c >= MINCOUNT && c <= MAXCOUNT).map(([id]) => id);
const rareSet = new Set(rare);
console.log(`tileset ${TILESET}: ${maps.length} maps, ${hist.size} distinct tile ids`);
console.log(`bulk terrain (>${MAXCOUNT}): ${[...hist].filter(([, c]) => c > MAXCOUNT).sort((a,b)=>b[1]-a[1]).map(([id, c]) => `$${id.toString(16).padStart(2,'0')}(${c})`).join(' ')}`);
console.log(`\ncandidate structure ids (${rare.length}): ${rare.sort((a,b)=>a-b).map(id => `$${id.toString(16).padStart(2,'0')}`).join(' ')}\n`);

// Blob the rare tiles per map (8-way), so a 3x3 altar shows as one entry.
const blobs = [];
for (const { id: mapId, tm } of maps) {
  const seen = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    if (seen[i] || !rareSet.has(tm[i])) continue;
    const q = [i]; seen[i] = 1; const cells = [];
    while (q.length) {
      const p = q.pop(); cells.push(p);
      const px = p % 32, py = (p / 32) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
        const n = ny * 32 + nx;
        if (!seen[n] && rareSet.has(tm[n])) { seen[n] = 1; q.push(n); }
      }
    }
    const xs = cells.map(c => c % 32), ys = cells.map(c => (c / 32) | 0);
    const ids = [...new Set(cells.map(c => tm[c]))].sort((a, b) => a - b);
    blobs.push({ mapId, n: cells.length, x0: Math.min(...xs), x1: Math.max(...xs),
                 y0: Math.min(...ys), y1: Math.max(...ys), ids });
  }
}

// Biggest, most id-diverse blobs first — a multi-id cluster is a built thing,
// a 20-cell run of one id is usually a decoration strip.
blobs.sort((a, b) => (b.ids.length - a.ids.length) || (b.n - a.n));
console.log('structures (most distinct ids first):');
for (const b of blobs.slice(0, 30)) {
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
  console.log(`  map ${String(b.mapId).padStart(3)}  ${w}x${h} @(${b.x0},${b.y0})  ${String(b.n).padStart(3)} tiles  ids ${b.ids.map(i => '$' + i.toString(16).padStart(2,'0')).join(' ')}`);
}
