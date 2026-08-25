#!/usr/bin/env node
// check-cid-airship.mjs — Cid's quest must actually put the airship in the sand.
//
// The reward is not gil, it is a CRAFT parked on the world map, and every part
// of that can fail silently: the grant not firing, the tile being unreachable,
// the tile being the map-180 entrance (which is in STRANDING_MAPS and refuses
// entry at the door), or the coordinate being written in the wrong UNITS —
// which is exactly the bug this arc found in `movement.js`, where disembarking
// parked the craft at a PIXEL coordinate that boarding, comparing tiles, could
// never match.
//
//   node tools/check-cid-airship.mjs

import fs from 'node:fs';

globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, drawImage() {},
  }) }),
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { ps } = await import('../src/player-stats.js');
const quests = await import('../src/quests.js');
const { TOWN_NPCS, RESERVED_BUNDLES } = await import('../src/data/town-npcs.js');
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { loadMap } = await import('../src/map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

const Q = QUESTS.kazus_cid_airship;
if (!Q) { console.error('check-cid-airship: no kazus_cid_airship quest'); process.exit(2); }
const g = Q.grantsVehicle;
if (!g) { bad('the quest declares no grantsVehicle'); }

// ── 1. the quest hands the craft over ──────────────────────────────────────
ps.quests = {};
ps.vehicle = 0; ps.vehicleParked = 0; ps.vehicleParkedX = 0; ps.vehicleParkedY = 0; ps.vehicleParkedMode = 0;
quests.acceptQuest(Q.id);
for (let i = 0; i < Q.objective.count; i++) quests.noteEncounterVictory('altar_cave_f1');
const paid = [];
quests.talkQuest(Q.giver.mapId, Q.giver.npcKey, (r, id) => paid.push([r, id]));

if (ps.quests[Q.id] && ps.quests[Q.id].s === QUEST_DONE) ok('hand-in marks the quest done');
else bad('hand-in did not finish the quest');
if (paid.length === 1) ok('the ordinary reward is claimed exactly once');
else bad(`reward claimed ${paid.length} times`);

if (ps.vehicleParked === 1 && (ps.vehicleParkedMode | 0) === (g.mode | 0)) ok(`hand-in parks vehicle mode ${g.mode}`);
else bad(`hand-in left vehicleParked=${ps.vehicleParked} mode=${ps.vehicleParkedMode}`);
if ((ps.vehicleParkedX | 0) === (g.x | 0) && (ps.vehicleParkedY | 0) === (g.y | 0))
  ok(`parked at the declared tile (${g.x},${g.y})`);
else bad(`parked at (${ps.vehicleParkedX},${ps.vehicleParkedY}), declared (${g.x},${g.y})`);

// ⛔ TILES. 0-127 is the world in tiles; a pixel coordinate would sail past 127
// and `title-screen.js` would mask it into a different tile on the next load.
if ((g.x | 0) === g.x && (g.y | 0) === g.y && g.x >= 0 && g.x < 128 && g.y >= 0 && g.y < 128)
  ok('the grant coordinate is a TILE index, not pixels');
else bad(`(${g.x},${g.y}) is not a tile index — boarding compares tiles`);

// ── 2. the player can walk to it, and it is not the barred map's door ──────
const world = loadWorldMap(rom, 0);
const stub = { data: world };
const pass = (x, y) => WorldMapRenderer.prototype.isPassable.call(stub, x, y);
const W = world.mapWidth;

let seed = null;
const trig = new Map();
for (const [t, p] of world.triggerPositions) {
  const m = world.entranceTable[t];
  if (!trig.has(p.y * W + p.x)) trig.set(p.y * W + p.x, m);
  if (m === 114) seed = p;
}
const seen = new Set([seed.y * W + seed.x]);
const stack = [[seed.x, seed.y]];
while (stack.length) {
  const [x, y] = stack.pop();
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const nx = ((x + dx) % W + W) % W, ny = ((y + dy) % W + W) % W, k = ny * W + nx;
    if (seen.has(k) || !pass(nx, ny)) continue;
    seen.add(k); stack.push([nx, ny]);
  }
}
if (pass(g.x, g.y)) ok('the parking tile is passable on foot');
else bad(`(${g.x},${g.y}) is not walkable — the player could never reach the craft`);
if (seen.has(g.y * W + g.x)) ok('the parking tile is reachable on foot from Ur');
else bad(`(${g.x},${g.y}) is not reachable from Ur`);

const onTrigger = trig.get(g.y * W + g.x);
if (onTrigger === undefined) ok('the parking tile carries no map entrance of its own');
else bad(`(${g.x},${g.y}) is the entrance to map ${onTrigger} — stepping on it enters a map instead of boarding`);

// ── 3. Cid is THE REAL CID, and he does not seal the pub ──────────────────
//
// He used to be two entries in the Kazus INN — `cid_ghost` / `cid_man` — that
// were not him: they stood on records $27 ("This cave is the Mythril Mines.")
// and $26, identified through `npcId + 0x202`, wearing borrowed sprites.
// Cid is npc $1f and his sprite is 0x01D910, matched by PICTURE at 90.2%.
const room = TOWN_NPCS.get(Q.giver.mapId) || [];
const cids = room.filter((e) => e.key === Q.giver.npcKey);
if (cids.length === 1) ok(`exactly one Cid stands on map ${Q.giver.mapId}`);
else bad(`map ${Q.giver.mapId} holds ${cids.length} entries keyed ${Q.giver.npcKey}`);
if (cids.length === 1) {
  const cid = cids[0];
  if (cid.spec.romOffset === 0x01D910) ok('Cid wears his OWN sprite (0x01D910)');
  else bad(`Cid wears 0x${(cid.spec.romOffset || 0).toString(16).toUpperCase()} — not his own sprite`);
  if (RESERVED_BUNDLES.get(0x01D910) === Q.giver.npcKey) ok('0x01D910 is reserved to Cid alone');
  else bad('0x01D910 is not reserved to Cid — anyone may wear his sprite');
  // ⛔ HE IS INSIDE THE PUB. Map 10 (17,21) is trigId 2 -> map 12, so that door
  // IS the pub; v1.10.70 left him on the STREET outside it. The bundle argument
  // for keeping him out there was circular — map 12 lacks his sprite because the
  // cartridge never puts Cid inside, not because the room cannot show him.
  if (Q.giver.mapId === 12) ok('Cid is inside the pub (map 12), not out on the street');
  else bad(`Cid's quest giver is on map ${Q.giver.mapId} — he belongs in the pub, map 12`);
  // ⛔ A STILL NPC NEVER YIELDS (`npc.js#tryYieldToPlayer` returns false for
  // 'static'/'idle-march'), so he must not stand on a doorway or any tile the
  // player has to walk through.
  if (cid.spec.wander) bad('Cid WANDERS — he is a special character waiting in the pub, not a stroller');
  else ok('Cid stands still — correct for a character who is waiting');
  const md = loadMap(rom, Q.giver.mapId);
  const trig = md.triggerMap && md.triggerMap.get(`${cid.x},${cid.y}`);
  if (!trig) ok(`(${cid.x},${cid.y}) carries no door — he blocks no entrance`);
  else bad(`(${cid.x},${cid.y}) is a trigger tile — a still Cid there seals it permanently`);
}

console.log(failed ? `\ncheck-cid-airship: ${failed} FAILED` : '\ncheck-cid-airship: OK');
process.exit(failed ? 1 : 0);
