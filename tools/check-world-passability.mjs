#!/usr/bin/env node
// check-world-passability.mjs — two gates on the world-map passability rules.
//
//  1. MODE TABLE MATCHES THE ROM. `WORLD_MODE_MASKS` in world-map-renderer.js is
//     a transcription of the NES table at $C6CD (fixed bank). If the two ever
//     drift, the renderer is enforcing rules the cartridge does not have.
//
//  2. NOTHING CHANGED FOR THE PLAYER. `isPassable(x, y)` must still agree with
//     the pre-vehicle rule on ALL 16384 world tiles: trigger bit -> passable,
//     bit 0 -> blocked, otherwise passable, with the Ur choke boulder forced
//     blocked. Mode-aware passability is groundwork; it is not wired to anything,
//     and this gate is what says so.
//
//   node tools/check-world-passability.mjs
//
import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

let bad = 0;
const fail = (m) => { console.error('  ⛔ ' + m); bad++; };

// ── 1. the mask table is the ROM's ────────────────────────────────────────
const PRG = rom[4] * 16384, FIXED = 16 + PRG - 16384;
const romMasks = Array.from(rom.slice(FIXED + (0xC6CD - 0xC000), FIXED + (0xC6CD - 0xC000) + 8));
const src = fs.readFileSync(new URL('../src/world-map-renderer.js', import.meta.url).pathname, 'utf8');
const m = src.match(/const WORLD_MODE_MASKS = \[([^\]]+)\]/);
if (!m) fail('WORLD_MODE_MASKS not found in world-map-renderer.js');
else {
  const js = m[1].split(',').map((t) => parseInt(t.trim(), 16));
  const same = js.length === 8 && js.every((v, i) => v === romMasks[i]);
  console.log(`  mask table vs ROM $C6CD: js=[${js.map((v) => '$' + v.toString(16)).join(' ')}] ` +
              `rom=[${romMasks.map((v) => '$' + v.toString(16)).join(' ')}] ${same ? '✅' : '⛔'}`);
  if (!same) fail('WORLD_MODE_MASKS has drifted from the ROM table at $C6CD');
}

// ── 2. isPassable is byte-for-byte the old rule ───────────────────────────
const world = loadWorldMap(rom, 0);
// The constructor builds canvas atlases and needs a DOM. Passability only reads
// `this.data`, so call it through the prototype on a bare object instead of
// dragging a canvas shim into a collision check.
const r = {
  data: world,
  isPassable: WorldMapRenderer.prototype.isPassable,
  isPassableForMode: WorldMapRenderer.prototype.isPassableForMode,
};
const CHOKE_X = 81, CHOKE_Y = 54;          // must track world-map-renderer.js
let checked = 0, mismatch = 0, firstBad = null;
for (let y = 0; y < world.mapHeight; y++) {
  for (let x = 0; x < world.mapWidth; x++) {
    const props = world.tileProps[world.tilemap[y * world.mapWidth + x] & 0x7F];
    let legacy;
    if (x === CHOKE_X && y === CHOKE_Y) legacy = false;
    else if (props.byte1 & 0x80) legacy = true;
    else if (props.byte1 & 0x01) legacy = false;
    else legacy = true;
    const now = r.isPassable(x, y);
    checked++;
    if (now !== legacy) { mismatch++; if (!firstBad) firstBad = { x, y, byte1: props.byte1, legacy, now }; }
  }
}
console.log(`  isPassable vs pre-vehicle rule: ${checked - mismatch}/${checked} ${mismatch ? '⛔' : '✅'}`);
if (mismatch) {
  fail(`isPassable changed on ${mismatch} tiles — e.g. (${firstBad.x},${firstBad.y}) ` +
       `byte1=$${firstBad.byte1.toString(16)} was ${firstBad.legacy} now ${firstBad.now}`);
}

// ── 3. the modes are actually distinct (a table of all-$01 would pass #2) ──
const counts = WORLD_MODES().map((mode) => {
  let open = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) if (r.isPassableForMode(x, y, mode)) open++;
  return open;
});
function WORLD_MODES() { return [0, 1, 2, 3, 4]; }
console.log(`  tiles open per mode 0-4: ${counts.join(' ')}`);
if (new Set(counts).size < 4) fail('modes are not distinct — the mask table is not being applied');

console.log(bad ? `\n⛔ ${bad} check(s) FAILED` : '\n✅ world passability OK');
process.exit(bad ? 1 : 0);
