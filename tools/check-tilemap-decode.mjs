#!/usr/bin/env node
// check-tilemap-decode.mjs — our decompressed tilemap vs the one the ENGINE walks.
//
// `docs/ROM-LIVE-TILEMAPS.json` is $7400-$77FF read out of a running cartridge
// after its own go-to-map warp — the exact 1024 bytes the ROM's trigger routine
// walks (3A/9197 sets $80/$81 = $7400). It is the only ground truth there is for
// `map-loader.js#decompressTilemap`, which is otherwise only checkable against
// itself.
//
//   node tools/check-tilemap-decode.mjs
//   node tools/check-tilemap-decode.mjs --map 12     # where they differ
//
// ⛔ SOME DIFFERENCES ARE CORRECT. The ROM rewrites every trigger tile in place
// at load — 3A/91B4 replaces the tile with `base[tileId] + nth-of-that-tile-id`,
// which is why $60-$7C tiles read back as $80+ values. Those are excluded. What
// is left is real disagreement about the map.
//
// ⛔ THIS CURRENTLY FAILS, ON PURPOSE, and is NOT in deploy.sh. It is the
// measurement behind "the spawn is in the wrong room" on maps 2/5/12/16: our
// collision reads are correct (verified 128/128 against live $0400) and the
// collision RULE matches the ROM's routine at 3B/90EB exactly — but they are
// being applied to tiles that are not the ones the engine has.
import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }), getElementById: () => null };

const { loadMap, parseMapProperties } = await import('../src/map-loader.js');
const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const LIVE = JSON.parse(fs.readFileSync(new URL('../docs/ROM-LIVE-TILEMAPS.json', import.meta.url), 'utf8'));

const only = process.argv.includes('--map') ? Number(process.argv[process.argv.indexOf('--map') + 1]) : null;
const isTrigger = (t) => (t >= 0x60 && t < 0x64) || (t >= 0x70 && t < 0x7D);

let worst = 0, totalBad = 0;
console.log('tilemap decode vs the live cartridge');
console.log('  map   ours==live   fill   worst rows');
for (const [idStr, live] of Object.entries(LIVE.maps)) {
  const id = Number(idStr);
  if (only !== null && id !== only) continue;
  const md = loadMap(rom, id);
  const p = parseMapProperties(rom, id);
  let same = 0, bad = [];
  for (let i = 0; i < 1024; i++) {
    // a trigger tile is rewritten in place by the ROM — not a disagreement
    if (isTrigger(md.tilemap[i])) { same++; continue; }
    if (md.tilemap[i] === live[i]) same++;
    else bad.push(i);
  }
  totalBad += bad.length;
  if (bad.length > worst) worst = bad.length;
  const rows = {};
  for (const i of bad) { const y = (i - (i % 32)) / 32; rows[y] = (rows[y] || 0) + 1; }
  const topRows = Object.entries(rows).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([y, n]) => `y${y}:${n}`).join(' ');
  console.log(`  ${String(id).padStart(3)}   ${String(same).padStart(4)}/1024   $${p.fillTile.toString(16).padStart(2, '0')}   ${topRows || '—'}`);
  if (only !== null && bad.length) {
    console.log(`\n  first 20 disagreements on map ${id}:`);
    for (const i of bad.slice(0, 20)) {
      console.log(`    (${i % 32},${(i - (i % 32)) / 32})  ours $${md.tilemap[i].toString(16).padStart(2, '0')}   live $${live[i].toString(16).padStart(2, '0')}`);
    }
  }
}
console.log(`\n${totalBad} disagreeing tile(s) across ${Object.keys(LIVE.maps).length} maps; worst map has ${worst}`);
console.log(totalBad ? '\ncheck-tilemap-decode: DIVERGENT (known — see design-notes#followups)' : '\ncheck-tilemap-decode: OK');
