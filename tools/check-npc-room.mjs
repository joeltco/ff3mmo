#!/usr/bin/env node
// check-npc-room.mjs — every placed NPC must stand in the room the PLAYER
// walks into.
//
// FF3 packs several building interiors into one 32x32 tilemap. Map 2 holds at
// least four of them; the northern Ur house is the strip on row 31, and the
// other rooms are somewhere else entirely on the same grid. Picking a
// coordinate that looks like floor is therefore not enough — it has to be
// floor in the SAME connected region as that map's entrance, or the NPC is
// standing in a neighbouring house that the player never enters, visible as a
// body parked outside the room.
//
// That is exactly what shipped: `ur_householder` at (6,26) on map 2, while the
// player enters at (8,31) into a region that does not include it.
// check-npc-placement.mjs only checks sprite bundles and spacing, so it had
// nothing to say about it.
//
//   node tools/check-npc-room.mjs

import fs from 'node:fs';

const _ctx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _ctx }) };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');
const { playerRegion, isTalkable } = await import('./lib/talkable.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
let rom;
try { rom = new Uint8Array(fs.readFileSync(ROM)); }
catch { console.error(`check-npc-room: SKIP — no FF3 ROM at ${ROM}`); process.exit(0); }

const W = 32;
const fail = [];
const err = (m) => fail.push(m);

let checked = 0;
for (const [mapId, list] of TOWN_NPCS) {
  let md;
  try { md = loadMap(rom, mapId); }
  catch (e) { err(`map ${mapId}: loadMap threw — ${e.message}`); continue; }

  const { reach, stand, sx, sy, passable } = playerRegion(md, MapRenderer, calcSpawnY);
  if (!reach.size) { err(`map ${mapId}: the player's own spawn (${sx},${sy}) is not walkable`); continue; }

  for (const n of list) {
    checked++;
    const k = n.y * W + n.x;
    if (!passable(n.x, n.y)) {
      err(`map ${mapId} ${n.key} at (${n.x},${n.y}) stands on a SOLID tile`);
      continue;
    }
    // The real requirement is not "standing on a tile the player can reach" —
    // shop, inn and tavern keepers stand BEHIND a counter, on purpose, and the
    // counter tile is solid. What matters is that the player can walk up and
    // talk: the NPC must be on, or orthogonally beside, the region the entrance
    // opens into. Anything further away is in a neighbouring interior sharing
    // the tilemap, which is what "an NPC outside the house" looks like.
    // "Talkable" is defined once, in tools/lib/talkable.mjs: face to face, or
    // across a solid counter in a straight line. Never a diagonal, and never
    // from a door tile — stepping on one transitions the map.
    if (!isTalkable(md, stand, n.x, n.y)) {
      err(`map ${mapId} ${n.key} at (${n.x},${n.y}) is in a different room than the player ` +
          `— the entrance (${sx},${sy}) opens into ${reach.size} tiles and the player can never ` +
          `stand anywhere that reaches them`);
      continue;
    }
    // A wanderer must not be able to step onto the entrance tile either: the
    // player materialises there, and a body on it reads as a locked door.
    const leash = n.spec.wander ? (n.spec.leash != null ? n.spec.leash : 3) : 0;
    if (leash && Math.max(Math.abs(n.x - sx), Math.abs(n.y - sy)) <= leash) {
      err(`map ${mapId} ${n.key} at (${n.x},${n.y}) wanders within ${leash} of the entrance ` +
          `(${sx},${sy}) — it can stand on the tile the player arrives on`);
    }
  }
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-npc-room: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log(`check-npc-room: OK — all ${checked} placed NPCs share the player's room`);
