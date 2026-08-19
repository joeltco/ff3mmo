#!/usr/bin/env node
// check-area-banners.mjs — every place the game names gets its name banner.
//
// Kazus and Castle Sasune shipped for months with no name banner. `setupTopBox`
// tested `mapId === 114` literally, so every other town fell through to the
// battle-scene strip, and nothing failed a build over it. Ur's own shops were
// one step from the same fate: they only kept the banner because the else-branch
// is skipped while `topBoxSt.isTown` is still true from walking in, so loading a
// save made inside a shop opened with a battle strip too.
//
//   node tools/check-area-banners.mjs
//
// ⭐ THIS CALLS THE REAL `setupTopBox`. Asserting on the data tables alone would
// pass with the `mapId === 114` branch still in place — the tables were never
// the thing that was broken, the consumer was. The banner text itself is
// MEASURED off the real ROM (warp to the head map, read the banner off the PPU):
// "Kazus" (10), "Castle Sasune" (18), "Sasune Throne Room" (29), "Ur" (114).

import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { AREAS, AREA_NAMES, BANNER_FOR_MAP, TOWN_MAPS, ROSTER_LOC } = await import('../src/data/areas.js');
const { setupTopBox } = await import('../src/map-loading.js');
const { topBoxSt } = await import('../src/transitions.js');
const { hudSt } = await import('../src/hud-state.js');

// A LOCAL exact inverse, on purpose. `text-utils.js#_nesNameToString` drops
// $FF, because its callers decode item names whose $FF bytes are padding and
// would come back as trailing spaces. A banner's $FF bytes are real spaces, so
// decoding with that function silently turns "Castle Sasune" into
// "CastleSasune" and this file would compare two wrong strings and pass.
// Decoding here rather than comparing `encodeName(expected)` bytes keeps the
// encoder itself inside what is being checked.
const decode = (bytes) => [...bytes].map(b =>
  b === 0xFF ? ' '
  : b >= 0xA4 && b <= 0xBD ? String.fromCharCode(b - 0xA4 + 97)
  : b >= 0x8A && b <= 0xA3 ? String.fromCharCode(b - 0x8A + 65)
  : b >= 0x80 && b <= 0x89 ? String.fromCharCode(b - 0x80 + 48)
  : '\u00bf').join('');

let fails = 0;
const fail = (msg) => { console.log('  ⛔ ' + msg); fails++; };
const ok = (msg) => console.log('  ✓ ' + msg);

// The names as read off the PPU in the real ROM. Hard-coded HERE on purpose:
// deriving the expectation from `areas.js` would make this test agree with any
// typo the table happens to contain.
const MEASURED = new Map([
  [10, 'Kazus'], [18, 'Castle Sasune'], [29, 'Sasune Throne Room'], [114, 'Ur'],
]);

console.log('area banners');

// 1. the table says what the ROM says
for (const [mapId, expect] of MEASURED) {
  const bytes = AREA_NAMES.get(mapId);
  if (!bytes) { fail(`map ${mapId} has no AREA_NAMES entry — the ROM names it "${expect}" on entry`); continue; }
  const got = decode(bytes);
  if (got !== expect) fail(`map ${mapId} banner reads "${got}", the ROM prints "${expect}"`);
}
if (!fails) ok(`${MEASURED.size} head maps carry the name the ROM prints`);
for (const mapId of AREA_NAMES.keys()) {
  if (!MEASURED.has(mapId)) fail(`map ${mapId} claims a banner nobody measured — warp to it and read the PPU first`);
}

// 2. ⭐ the CONSUMER paints it. Entered cold (isTown false), exactly as a save
//    loaded inside the map does — the case the old `mapId === 114` branch and
//    the `isTown` latch both got wrong.
const before = fails;
for (const mapId of BANNER_FOR_MAP.keys()) {
  topBoxSt.isTown = false; topBoxSt.nameBytes = null; hudSt.topBoxMode = null;
  // No ROM is loaded here, so the battle-scene branch throws on `romRaw[...]`.
  // That throw IS the defect being tested — falling through to a battle strip
  // is exactly what a map with no banner does — so report it, don't crash.
  try { setupTopBox(mapId, false); }
  catch { fail(`setupTopBox(${mapId}) fell through to the battle-scene strip — no name banner`); continue; }
  if (hudSt.topBoxMode !== 'name') { fail(`setupTopBox(${mapId}) left topBoxMode=${hudSt.topBoxMode} — no name banner`); continue; }
  const want = BANNER_FOR_MAP.get(mapId);
  if (!topBoxSt.nameBytes || decode(topBoxSt.nameBytes) !== decode(want)) {
    fail(`setupTopBox(${mapId}) painted "${topBoxSt.nameBytes ? decode(topBoxSt.nameBytes) : 'nothing'}", expected "${decode(want)}"`);
  }
}
if (fails === before) ok(`setupTopBox paints a banner on all ${BANNER_FOR_MAP.size} named maps, entered cold`);

// 3. a head map inside another area still repaints. Walking 18 -> 25 -> 29 must
//    end on the throne room's OWN name, not Castle Sasune's latched banner.
topBoxSt.isTown = false; topBoxSt.nameBytes = null;
try { for (const step of [18, 25, 29]) setupTopBox(step, false); }
catch { fail('walking 18 -> 25 -> 29 hit the battle-scene strip'); }
const walked = decode(topBoxSt.nameBytes || new Uint8Array());
if (walked !== 'Sasune Throne Room') fail(`walking 18 -> 25 -> 29 ends showing "${walked}", expected "Sasune Throne Room"`);
else ok('a named map inside another area repaints the banner (18 -> 25 -> 29)');

// 4. rooms inherit, and the two tables cover the same maps. Adding a room to
//    one list only is the drift this file exists to catch.
for (const a of AREAS) {
  for (const room of a.rooms.keys()) {
    const b = BANNER_FOR_MAP.get(room);
    if (!b) { fail(`room ${room} of ${a.banner} shows no banner`); continue; }
    const want = AREA_NAMES.has(room) ? AREA_NAMES.get(room) : AREA_NAMES.get(a.head);
    if (decode(b) !== decode(want)) fail(`room ${room} shows "${decode(b)}", expected "${decode(want)}"`);
  }
}
for (const mapId of BANNER_FOR_MAP.keys()) {
  if (!ROSTER_LOC.has(mapId)) fail(`map ${mapId} has a banner but no roster location — players there report as being in Ur`);
}
for (const mapId of ROSTER_LOC.keys()) {
  if (!BANNER_FOR_MAP.has(mapId)) fail(`map ${mapId} has a roster location but no banner`);
}

// 4a. the text has to FIT. `_drawTopBoxOverlay` centres it in the 240px between
// the top box's 8px borders and does no wrapping or clipping of its own, so a
// name wider than that runs under the border instead of failing loudly.
const { measureText } = await import('../src/font-renderer.js');
const TOPBOX_TEXT_W = 240;
for (const [mapId, bytes] of AREA_NAMES) {
  const w = measureText(bytes);
  if (w > TOPBOX_TEXT_W) fail(`map ${mapId} banner "${decode(bytes)}" is ${w}px wide — the top box fits ${TOPBOX_TEXT_W}px`);
}
ok(`every banner fits the ${TOPBOX_TEXT_W}px strip (widest ${Math.max(...[...AREA_NAMES.values()].map(measureText))}px)`);

// 4b. ⭐ AN INDEPENDENT SOURCE OF "this map is part of a town".
//
// Steps 4's two loops both read tables DERIVED FROM `AREAS`, so deleting a room
// from `AREAS` deletes it from both and they agree about a map that no longer
// exists — verified by deleting Kazus's armor shop, which this file passed. A
// map that has a shop or a cast of NPCs is inhabited, and an inhabited map that
// shows no banner is the exact defect: walk into Kazus's armor shop and the
// name strip goes blank.
const { SHOPS } = await import('../src/data/shops.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const inhabited = new Map();
for (const [key, shop] of Object.entries(SHOPS)) if (shop && shop.mapId != null) inhabited.set(Number(shop.mapId), `shop ${key}`);
for (const [mapId, cast] of (TOWN_NPCS instanceof Map ? TOWN_NPCS : new Map(Object.entries(TOWN_NPCS)))) {
  if (cast && cast.length) inhabited.set(Number(mapId), `${cast.length} NPC(s)`);
}
const beforeInhabited = fails;
for (const [mapId, why] of inhabited) {
  if (!BANNER_FOR_MAP.has(mapId)) fail(`map ${mapId} has ${why} but belongs to no area — it shows a battle strip, not a name`);
}
if (fails === beforeInhabited) ok(`all ${inhabited.size} inhabited maps (shops + NPC casts) belong to a named area`);

// 5. TOWN_MAPS drives ps.lastTown (the respawn fallback) — head maps you can
//    walk into from the overworld, NOT every map that names itself.
for (const mapId of TOWN_MAPS) {
  if (!AREA_NAMES.has(mapId)) fail(`TOWN_MAPS has ${mapId}, which is not a head map`);
}
if (TOWN_MAPS.has(29)) fail('map 29 is a throne room reached through Sasune’s interior — it must not be a respawn town');

console.log(fails ? `\ncheck-area-banners: ${fails} FAILURE(S)` : '\ncheck-area-banners: OK');
process.exit(fails ? 1 : 0);
