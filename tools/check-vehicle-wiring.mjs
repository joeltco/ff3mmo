#!/usr/bin/env node
// check-vehicle-wiring.mjs — the vehicle system's behaviour, gated.
//
// Three things this protects, all of which have already been got wrong once:
//
//  1. TERRAIN RULES match the ROM's own mask table ($C6CD). Not "the code runs" —
//     the actual reachability per mode, checked against the terrain classes.
//  2. DISEMBARK IS TESTED BEFORE PASSABILITY in movement.js. A ship's mask
//     blocks every land tile, so a disembark check placed after the terrain gate
//     can never fire and the player is stranded at sea. Source-order assertion,
//     because the bug is invisible to a unit test of either half alone.
//  3. INDOORS IS ALWAYS ON FOOT. `MapRenderer.isPassable`'s third argument is a
//     Z-LEVEL; passing a vehicle there would silently mean "z = 3".
//
//   node tools/check-vehicle-wiring.mjs
//
import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

let bad = 0;
const fail = (m) => { console.error('  ⛔ ' + m); bad++; };
const ok = (m) => console.log('  ✅ ' + m);

const world = loadWorldMap(rom, 0);
const r = {
  data: world,
  isPassable: WorldMapRenderer.prototype.isPassable,
  isPassableForMode: WorldMapRenderer.prototype.isPassableForMode,
  isFootWalkable: WorldMapRenderer.prototype.isFootWalkable,
};
const CLS = { 0b0110: 'land', 0b1110: 'forest', 0b1011: 'ocean', 0b1101: 'shallow', 0b1111: 'mtn' };
const find = (want) => {
  for (let y = 2; y < 126; y++) for (let x = 2; x < 126; x++) {
    const p = world.tileProps[world.tilemap[y * 128 + x] & 0x7F];
    if (p.byte1 & 0x80) continue;
    if (CLS[p.byte1 & 0x0F] === want) return [x, y];
  }
  return null;
};
const T = Object.fromEntries(['land', 'forest', 'ocean', 'shallow', 'mtn'].map(k => [k, find(k)]));

// ── 1. terrain rules ───────────────────────────────────────────────────────
const EXPECT = [
  ['on foot',  0, { land: true,  forest: true,  ocean: false, shallow: false, mtn: false }],
  ['canoe',    1, { land: true,  forest: true,  ocean: false, shallow: true,  mtn: false }],
  ['afloat',   2, { land: false, forest: false, ocean: false, shallow: true,  mtn: false }],
  ['ship',     3, { land: false, forest: false, ocean: true,  shallow: false, mtn: false }],
];
for (const [name, mode, exp] of EXPECT) {
  for (const [terr, want] of Object.entries(exp)) {
    if (!T[terr]) continue;
    const got = r.isPassableForMode(T[terr][0], T[terr][1], mode);
    if (got !== want) fail(`${name} (mode ${mode}) on ${terr}: expected ${want ? 'passable' : 'blocked'}, got ${got ? 'passable' : 'blocked'}`);
  }
}
if (!bad) ok('terrain rules match the ROM mask table for modes 0-3');

// flight: modes 4-7 cross everything except the bit-4 barrier
for (const mode of [4, 5, 6, 7]) {
  for (const terr of ['land', 'ocean', 'mtn']) {
    if (!T[terr]) continue;
    const p = world.tileProps[world.tilemap[T[terr][1] * 128 + T[terr][0]] & 0x7F];
    const want = (p.byte1 & 0x10) !== 0x10;
    if (r.isPassableForMode(T[terr][0], T[terr][1], mode) !== want)
      fail(`flying mode ${mode} on ${terr} disagrees with the bit-4 barrier`);
  }
}
if (!bad) ok('flying modes 4-7 gated only by the bit-4 barrier');

// ── 2. isFootWalkable == mode 0, everywhere ────────────────────────────────
let mism = 0;
for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++)
  if (r.isFootWalkable(x, y) !== r.isPassableForMode(x, y, 0)) mism++;
if (mism) fail(`isFootWalkable disagrees with mode 0 on ${mism} tiles`);
else ok('isFootWalkable == mode 0 on all 16384 tiles');

// ── 3. movement.js source order: disembark BEFORE the passability gate ─────
const mv = fs.readFileSync(new URL('../src/movement.js', import.meta.url).pathname, 'utf8');
const ts = fs.readFileSync(new URL('../src/title-screen.js', import.meta.url).pathname, 'utf8');
const iDisembark = mv.indexOf('isFootWalkable(tileX, tileY)');
const iGate = mv.indexOf('if (renderer && !passable)');
if (iDisembark < 0) fail('movement.js no longer calls isFootWalkable — auto-disembark is gone');
else if (iGate < 0) fail('movement.js passability gate not found');
else if (iDisembark > iGate) fail('auto-disembark runs AFTER the passability gate — a ship can never reach land, so it can never fire');
else ok('auto-disembark is tested before the passability gate');

// ── 4. indoors is always on foot ───────────────────────────────────────────
if (!/mapSt\.onWorldMap \? \(ps\.vehicle \| 0\) : 0/.test(mv))
  fail('movement.js no longer forces vehicle 0 indoors (MapRenderer arg 3 is a Z-LEVEL)');
else ok('indoor movement forces vehicle 0');

// ── 5. vehicles.js music/SFX match the ROM's own tables ────────────────────
// music  = bank 59 $A027 + mode ; SFX = $A047 + mode, and music.js's convention
// is "ROM SFX ID + 0x41" for the NSF track number.
const b59 = (a) => 16 + 59 * 0x2000 + (a - 0xA000);
const romMusic = (m) => rom[b59(0xA027) + m];
const romSfx   = (m) => rom[b59(0xA047) + m];
const { VEHICLES } = await import('../src/data/vehicles.js');
let audioBad = 0;
for (const [mode, v] of VEHICLES) {
  if (mode === 1 || mode === 2) continue;          // normalise away; table row is not their live one
  if (v.music !== romMusic(mode)) { fail(`vehicles.js mode ${mode} music $${v.music.toString(16)} != ROM $${romMusic(mode).toString(16)}`); audioBad++; }
  const rs = romSfx(mode);
  const want = rs === 0xFF ? null : rs + 0x41;
  if (v.sfx !== want) { fail(`vehicles.js mode ${mode} sfx ${v.sfx} != ROM ${want}`); audioBad++; }
}
if (!audioBad) ok('vehicles.js music/SFX match the ROM tables at $A027/$A047');

// ── 6. captured sprite art covers every REACHABLE mode ─────────────────────
const { CAPTURED_VEHICLE_SPRITES } = await import('../src/data/vehicle-sprites-captured.js');
for (const mode of [0, 2, 3, 5, 6, 7]) {
  const v = CAPTURED_VEHICLE_SPRITES.get(mode);
  if (!v) { fail(`no captured sprite for mode ${mode}`); continue; }
  if (!v.layout.length || !v.tiles.length) fail(`captured sprite for mode ${mode} is empty`);
  const have = new Set(v.tiles.map(([id]) => id));
  for (const [tileId] of v.layout)
    if (!have.has(tileId)) fail(`mode ${mode} layout references tile $${tileId.toString(16)} with no pattern data`);
}
if (!bad) ok('captured vehicle sprites cover modes 0,2,3,5,6,7 with complete tile data');

// ── 7. boarding is by POSITION, and parking uses the tile being LEFT ────────
if (!/ps\.vehicleParked\s*&&[\s\S]{0,160}tileX === \(ps\.vehicleParkedX/.test(mv))
  fail('movement.js no longer boards by comparing the target tile to the parked craft ($C633)');
else ok('boarding matches the parked craft by position');
// ⛔ THIS CHECK USED TO PIN THE BUG. It asserted the literal
// `ps.vehicleParkedX = mapSt.worldX`, which is a PIXEL coordinate, while
// boarding compares `tileX` — so the gate was enforcing a craft you could never
// board again. A gate must not take its expectation from the expression under
// test. Both sides are pinned in the same UNITS now, and the `& 127` clamp in
// title-screen.js (a tile index, 0-127) is the third witness.
if (!/ps\.vehicleParkedX = \(mapSt\.worldX \/ TILE_SIZE\)/.test(mv))
  fail('disembark must park the craft on the tile being LEFT, in TILES — boarding compares tileX');
else ok('disembark parks the craft on the tile being left, in tiles');
if (!/vehicleParkedX != null \? \(slot\.vehicleParkedX & 127\)|vehicleParkedX & 127/.test(ts))
  fail('title-screen must clamp the parked tile to 0-127; a pixel value would survive as a wrong tile');
else ok('the loaded parked coordinate is clamped to a tile index');

console.log(bad ? `\n⛔ ${bad} check(s) FAILED` : '\n✅ vehicle wiring OK');
process.exit(bad ? 1 : 0);
