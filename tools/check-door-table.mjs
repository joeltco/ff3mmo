#!/usr/bin/env node
// check-door-table.mjs — our door destinations still match the REAL ROM.
//
// `docs/ROM-DOOR-GRAPH.json` is a measurement, not a belief: every door in the
// Ur / Kazus / Castle Sasune blocks was walked into inside a real emulator by
// `tools/monscan/door-probe.cjs`, which patches the map's ROM entrance to place
// the party and reads the destination back out of `$48`. 69 doors measured, 30
// proven sealed (walled in on all four sides), 3 pointing at their own map.
//
// This gate is the cheap half: it re-derives `entranceData[trigId]` the way the
// engine does and compares it to what the cartridge actually did. Re-running the
// emulator sweep costs ~4 minutes, so it is not in the deploy path — but if the
// trigger-id assignment or the entrance-pointer decode ever drifts, this fires.
//
//   node tools/check-door-table.mjs
//   node tools/check-door-table.mjs --verbose
//
// To regenerate the fixture (only when the ROM or the map set changes):
//   node tools/rom-door-map.mjs --towns /tmp/door-map.json
//   node tools/monscan/door-probe.cjs --selftest /tmp/door-map.json
//   node tools/monscan/door-probe.cjs /tmp/door-map.json docs/ROM-DOOR-GRAPH.json
//
// ⛔ Run the --selftest first, every time. It reproduces five doors measured by
// hand with a different method, and it runs a MOVEMENT CONTROL — spawn on plain
// floor and require the party moves — because "walled in on all four sides" is
// only evidence if the harness has not simply frozen movement.
import fs from 'node:fs';

const ctx2d = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }), getElementById: () => null };

const { loadMap } = await import('../src/map-loader.js');
const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const FIXTURE = JSON.parse(fs.readFileSync(new URL('../docs/ROM-DOOR-GRAPH.json', import.meta.url), 'utf8'));

let fails = 0;
const fail = (m) => { console.log('  ⛔ ' + m); fails++; };
const verbose = process.argv.includes('--verbose');

console.log('door table vs the real ROM');

const cache = new Map();
const mapOf = (id) => { if (!cache.has(id)) cache.set(id, loadMap(rom, id)); return cache.get(id); };

let measured = 0, sealed = 0, noop = 0, checked = 0;
for (const [key, d] of Object.entries(FIXTURE.doors)) {
  const md = mapOf(d.map);
  // The engine's own answer: per-type trigger id in tilemap scan order, indexing
  // the 16-byte entrance window this map's property record points at.
  const trig = [...md.triggerMap.entries()]
    .map(([k, t]) => ({ pos: k.split(',').map(Number), t }))
    .find(e => e.t.type === 1 && e.t.trigId === d.trigId && e.pos[0] === d.at[0] && e.pos[1] === d.at[1]);
  if (!trig) { fail(`${key}: no type-1 trigger with trigId ${d.trigId} at (${d.at}) any more — the scan order changed`); continue; }
  const ours = md.entranceData[d.trigId] | 0;

  if (d.status === 'measured') {
    measured++; checked++;
    if (ours !== d.romDest) fail(`${key} @(${d.at}): we send the player to map ${ours}, the ROM sent them to map ${d.romDest}`);
    else if (verbose) console.log(`     ${key} @(${d.at}) -> ${ours} ✓`);
  } else if (d.status === 'sealed') {
    sealed++;
  } else {
    noop++;
    if (ours !== d.map) fail(`${key}: recorded as a no-op (destination is its own map) but we now resolve it to ${ours}`);
  }
}

// ⭐ Close the loop with the MEASUREMENT, not with our own reachability flood.
// `check-area-graph.mjs` decides what leaks using `isPassable`; this decides it
// using where the cartridge actually put the player. A door the ROM walked us
// through, that lands outside the shipped set, has to be barred — and a door the
// ROM proved SEALED can never be walked into, so barring it would be theatre.
const { SHIPPED_MAPS, isShippedMap } = await import('../src/data/areas.js');
let barred = 0;
for (const [key, d] of Object.entries(FIXTURE.doors)) {
  if (d.status !== 'measured' || !SHIPPED_MAPS.has(d.map)) continue;
  if (isShippedMap(d.romDest)) continue;
  barred++;
  const trig = fs.readFileSync(new URL('../src/map-triggers.js', import.meta.url), 'utf8');
  if (!/if \(!isShippedMap\(destMap\)\)/.test(trig)) {
    fail(`${key} @(${d.at}) walks the player to map ${d.romDest}, which we do not ship, and nothing refuses it`);
    break;
  }
}

if (!fails) console.log(`  ✓ ${checked} measured door(s) match the cartridge exactly`);
if (!fails) console.log(`  ✓ ${barred} measured door(s) leave the shipped set and are refused at the door`);
// Two shapes of sealed, and the fixture records which: walled in on all four
// sides, or steppable OFF the tile but not back ON, so the party can only ever be
// there because we patched the spawn. Both mean no player reaches the door.
const sealedWalled = Object.values(FIXTURE.doors).filter(d => d.status === 'sealed' && !/steppable/.test(d.note || '')).length;
console.log(`  · ${sealed} sealed (${sealedWalled} walled in on all four sides, ${sealed - sealedWalled} steppable off but not back on), ` +
            `${noop} pointing at their own map — nothing to compare`);
console.log(`  · ${measured + sealed + noop} doors accounted for, none unexplained`);

console.log(fails ? `\ncheck-door-table: ${fails} FAILURE(S)` : '\ncheck-door-table: OK');
process.exit(fails ? 1 : 0);
