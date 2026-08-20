#!/usr/bin/env node
// check-stranding.mjs — every map we refuse really has no way out.
//
// `map-triggers.js#STRANDING_MAPS` refuses a destination with "The way is
// barred." because landing there leaves the player stuck. It was derived through
// the tilemap decoder that dropped whole rows of fill (fixed v1.10.9) and was
// wrong in BOTH directions — 24, 140 and 178 had exits and were refused for
// nothing, while map 135 traps and was not listed.
//
//   node tools/check-stranding.mjs
//
// ⛔ THIS DOES NOT MODEL REACHABILITY, ON PURPOSE. A version that did — flooding
// with `isPassable` and counting "a tile adjacent to an exit tile" as a way out —
// reported map 135 as escapable when the emulator walks 69 tiles there and
// touches no door at all. It was deleted rather than shipped. What this checks is
// the half that CAN be settled from data alone, on tilemaps verified byte for
// byte against a running cartridge (`check-tilemap-decode.mjs`):
//
//   * a map with NO door carrying a destination and NO exit tile has nothing to
//     reach, so it strands whatever the walk does. Eight entries are this shape.
//   * the two that DO have exits (34, 135) were walked in the emulator and are
//     pinned here by that measurement, not re-derived.
//
// The detector is SELF-TESTED first: six maps proven in the emulator to have a
// way out must count more than zero. A blind detector would otherwise call the
// whole game stranded and pass.
import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }), getElementById: () => null };

const { loadMap } = await import('../src/map-loader.js');
const { applyPassage } = await import('../src/map-passage.js');
const { SHIPPED_MAPS } = await import('../src/data/areas.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const src = fs.readFileSync(new URL('../src/map-triggers.js', import.meta.url), 'utf8');
const m = /const STRANDING_MAPS = new Set\(\[([^\]]*)\]\)/.exec(src);
if (!m) { console.log('  ⛔ could not find STRANDING_MAPS in map-triggers.js'); process.exit(1); }
const declared = new Set(m[1].split(',').map(s => Number(s.trim())).filter(Number.isFinite));

/** Doors with a destination + exit tiles. "Ways out that EXIST", not reachable ones. */
function waysOut(id) {
  const md = loadMap(rom, id);
  if (md.tilemap[16 * 32 + 8] !== 0x32) applyPassage(md.tilemap);
  let doors = 0, exits = 0;
  for (const [, t] of md.triggerMap) {
    if (t.type === 1 && (md.entranceData[t.trigId] | 0) !== 0) doors++;
  }
  for (let i = 0; i < md.tilemap.length; i++) {
    const mid = md.tilemap[i], x = i % 32, y = (i - x) / 32;
    if (md.triggerMap.has(`${x},${y}`)) continue;
    if (!(md.collision[mid & 0x7F] & 0x80)) continue;
    const tt = (md.collisionByte2[mid] >> 4) & 0x0F;
    if (tt === 0 || tt === 1) exits++;
  }
  return doors + exits;
}

// Maps walked in a real emulator: they HAVE a way out in the data, and the party
// still cannot get to it. `tools/monscan/reach-flood.cjs <id>`.
const WALKED_STRANDING = new Map([
  [34,  'spawn (22,27): 1 tile reachable, no door touched — its door at (4,12) is walled off'],
  [135, 'spawn (15,14): 69 tiles reachable, no door and no exit touched'],
]);

let fails = 0;
const fail = (s) => { console.log('  ⛔ ' + s); fails++; };
console.log('stranding list');

// 0. the detector must not be blind
const CONTROLS = [[140, 'walked to map 142'], [24, 'reaches a door at (0,26)'], [178, 'reaches a door at (27,30)'],
                  [114, 'Ur'], [12, 'Kazus inn'], [18, 'Castle Sasune']];
let blind = 0;
for (const [id, why] of CONTROLS) if (waysOut(id) === 0) { fail(`detector blind: map ${id} (${why}) counts 0 ways out`); blind++; }
if (!blind) console.log(`  ✓ detector self-test: all ${CONTROLS.length} maps with a proven way out count more than zero`);

// 1. every refused map is justified
let structural = 0;
for (const id of declared) {
  const n = waysOut(id);
  // 135 is BOTH — it has nothing to reach and was walked anyway. Count it once,
  // as walked, so the totals add up to the size of the list.
  if (n === 0 && !WALKED_STRANDING.has(id)) { structural++; continue; }
  if (n === 0) continue;
  if (WALKED_STRANDING.has(id)) continue;                     // measured in the emulator
  fail(`map ${id} is refused but has ${n} way(s) out in its data and no emulator measurement — ` +
       `walk it (tools/monscan/reach-flood.cjs ${id}) or drop it from the list`);
}
if (!fails) {
  console.log(`  ✓ ${declared.size} refused map(s): ${structural} contain no door and no exit at all, ` +
              `${WALKED_STRANDING.size} walked in the emulator`);
}

// 2. nothing we ship is refused
for (const id of declared) {
  if (SHIPPED_MAPS.has(id)) fail(`map ${id} is refused at the door but is a map we ship as a place`);
}

console.log(fails ? `\ncheck-stranding: ${fails} FAILURE(S)` : '\ncheck-stranding: OK');
process.exit(fails ? 1 : 0);
