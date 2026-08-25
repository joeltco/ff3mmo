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
const CID_TILE = [6, 23];   // record $2c — the end of the Kazus pub's bar
const ghost = room.find((e) => e.key === 'cid_ghost');
const man = room.find((e) => e.key === 'cid');
if (ghost && man) ok('both of Cid’s states are declared');
else bad('the Kazus pub is missing one of cid_ghost / cid');
if (ghost && man) {
  // ⛔ THE TILE IS THE POINT. (6,23) sat in `npc-dump.mjs 12` marked DRAWN the
  // whole time and got walked past twice — once onto the STREET outside the pub
  // (map 10, 18,22), once onto a BAR STOOL (9,25).
  for (const e of [ghost, man]) {
    if (e.x === CID_TILE[0] && e.y === CID_TILE[1]) ok(`${e.key} stands on the ROM tile (${CID_TILE})`);
    else bad(`${e.key} stands at (${e.x},${e.y}) — Cid's record is (${CID_TILE})`);
  }
  if (man.spec.romOffset === 0x01D910) ok('uncursed Cid wears his OWN sprite (0x01D910)');
  else bad(`uncursed Cid wears 0x${(man.spec.romOffset || 0).toString(16).toUpperCase()}`);
  if (ghost.spec.romOffset === 0x01ED10) ok('cursed Cid wears the Djinn’s ghost (0x01ED10)');
  else bad(`cursed Cid wears 0x${(ghost.spec.romOffset || 0).toString(16).toUpperCase()}`);
  if (ghost.spec.romOffset !== man.spec.romOffset) ok('the two states wear different faces — the curse lifting is visible');
  else bad('both states wear the same bundle — the curse lifting is invisible');
  if (RESERVED_BUNDLES.get(0x01D910) === 'cid') ok('0x01D910 is reserved to Cid alone');
  else bad('0x01D910 is not reserved to Cid');
  // Exactly one of him in the room, in either story state.
  const none = () => false, done = (id) => id === Q.id;
  const before = [ghost, man].filter((e) => !e.when || e.when(none));
  const after = [ghost, man].filter((e) => !e.when || e.when(done));
  if (before.length === 1 && before[0].key === 'cid_ghost') ok('before the quest, only the cursed Cid stands there');
  else bad(`before the quest ${before.length} Cid(s) are placed: ${before.map((e) => e.key).join(', ')}`);
  if (after.length === 1 && after[0].key === 'cid') ok('after the quest, only the uncursed Cid stands there');
  else bad(`after the quest ${after.length} Cid(s) are placed: ${after.map((e) => e.key).join(', ')}`);
  // ⛔ A still NPC never yields — he must not stand on a door.
  const md = loadMap(rom, Q.giver.mapId);
  if (!md.triggerMap.get(`${CID_TILE[0]},${CID_TILE[1]}`)) ok(`(${CID_TILE}) carries no door — he blocks no entrance`);
  else bad(`(${CID_TILE}) is a trigger tile — a still Cid there seals it permanently`);
  if (!ghost.spec.wander && !man.spec.wander) ok('neither state wanders — correct for a man who is waiting');
  else bad('a Cid state WANDERS');
}

console.log(failed ? `\ncheck-cid-airship: ${failed} FAILED` : '\ncheck-cid-airship: OK');
process.exit(failed ? 1 : 0);
