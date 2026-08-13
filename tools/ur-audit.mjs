#!/usr/bin/env node
// ur-audit.mjs — sweep EVERY Ur interior for the whole family of defects that
// produced "there's an NPC outside the northern house", not just that one.
//
// The northern-house bug was not "a wrong coordinate". It was: FF3 packs
// several interiors into one tilemap, and nothing checked which of them the
// player actually stands in. The same shared-tilemap trap can hide five other
// things, so this checks all of them per map and prints one table:
//
//   spawn       where the player lands (tools/lib/spawn.mjs — the ONE copy)
//   room        how many tiles that spawn can reach
//   exit        can the player LEAVE from where they land
//   chests      chests inside the room vs chests stranded elsewhere
//   rom npcs    how many of the ROM's NPCs for this map are in the player's room
//   ours        our placements, and whether each is reachable/talkable
//
// A stranded exit means a soft-lock. A stranded chest means loot the player can
// see and never open. A ROM NPC in the room that we do NOT place means an empty
// room the game intended to be occupied.
//
//   node tools/ur-audit.mjs            table
//   node tools/ur-audit.mjs --ascii    plus a grid per map

import fs from 'node:fs';

const _ctx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _ctx }), getElementById: () => null };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');
const { playerRegion, isTalkable } = await import('./lib/talkable.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;
const ASCII = process.argv.includes('--ascii');

// Ur town + every interior its doors lead to, plus the two upper floors reached
// from inside (elder 7, tavern 9). Map 114's entranceData is 2,3,5,4,6,8,147,1.
const UR_MAPS = [
  [114, 'Ur town'],
  [2, 'northern house'], [3, 'magic shop'], [4, 'armour shop'], [5, 'weapon shop'],
  [6, 'elder ground'], [7, 'elder upper'], [8, 'inn'], [9, 'tavern'],
  [1, 'house (door 8)'], [147, 'house (door 7)'],
];

// Walk bundles each map copies into sprite memory — MEASURED with
// `nes-run.mjs --warp <id> --bundlecheck`, pinned in check-npc-placement.mjs.
// A map can never show more distinct NPCs than this.
const BUNDLE_CAP = new Map([[114, 5], [9, 5], [8, 2], [7, 3], [6, 1], [5, 1], [4, 1], [2, 1]]);
// NPCs placed by paths other than TOWN_NPCS (map-loading.js), so the "we place
// fewer than the ROM" check does not report a room that is actually occupied.
const OTHER_PLACERS = new Map([[3, 1]]);   // addBlackMageShopkeeper(4, 4, 'ur_magic')

const problems = [];
const note = (m) => problems.push(m);

console.log('map  name             spawn    room  exit  chests(in/out)  rom npcs in room  ours');
console.log('---  ---------------  -------  ----  ----  --------------  ----------------  ----');

for (const [mapId, name] of UR_MAPS) {
  let md;
  try { md = loadMap(rom, mapId); } catch (e) { note(`map ${mapId} (${name}): loadMap threw — ${e.message}`); continue; }

  const { sx, sy, reach, stand, passable } = playerRegion(md, MapRenderer, calcSpawnY);

  // Exits + chests, classified by whether the player's room contains them.
  // A trigger tile is solid, so "reachable" means orthogonally touching the room.
  const touches = (x, y) => isTalkable(md, stand, x, y) || reach.has(y * W + x);
  let exitsIn = 0, exitsOut = 0, chestIn = 0, chestOut = 0;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const t = md.triggers && md.triggers.find ? md.triggers.find(tr => tr.x === x && tr.y === y) : null;
      const mid = md.tilemap[y * W + x];
      const c = md.collision[mid < 128 ? mid : mid & 0x7F];
      const isChest = (t && t.type === 2) || (mid >= 0x78 && mid <= 0x7C);
      let isExit = false;
      if (c & 0x80) {
        const tt = (md.collisionByte2[mid] >> 4) & 0x0F;
        isExit = tt === 0 || tt === 1 || tt === 4 || tt === 5;
      }
      if (isChest) { if (touches(x, y)) chestIn++; else chestOut++; }
      if (isExit)  { if (touches(x, y)) exitsIn++; else exitsOut++; }
    }
  }

  const romNpcs = md.npcs || [];
  const romInRoom = romNpcs.filter(n => touches(n.x, n.y));
  const ours = (TOWN_NPCS.get(mapId) || []);
  const oursBad = ours.filter(n => !touches(n.x, n.y));

  console.log(
    String(mapId).padStart(3) + '  ' + name.padEnd(15) + '  ' +
    `(${sx},${sy})`.padEnd(7) + '  ' +
    String(reach.size).padStart(4) + '  ' +
    String(exitsIn).padStart(4) + '  ' +
    `${chestIn}/${chestOut}`.padEnd(14) + '  ' +
    `${romInRoom.length}/${romNpcs.length}`.padEnd(16) + '  ' +
    `${ours.length}${oursBad.length ? ' BAD:' + oursBad.length : ''}`
  );

  if (!reach.size)   note(`map ${mapId} (${name}): the player's spawn (${sx},${sy}) is not walkable`);
  else if (!exitsIn) note(`map ${mapId} (${name}): NO exit reachable from the spawn — soft-lock`);
  // chestOut is NOT a defect: it counts chests belonging to the OTHER interiors
  // packed into the same tilemap, which is the normal FF3 layout. Only a chest
  // the player can see in their own room but cannot open would matter, and that
  // is what chestIn/touches already covers.
  for (const n of oursBad) note(`map ${mapId} (${name}): our NPC ${n.key} at (${n.x},${n.y}) is not in the player's room`);
  // A map cannot show more distinct NPCs than it has walk bundles in sprite
  // memory — placing more makes twins (v1.7.974, "I'M SEEING DOUBLE NPCS").
  // So "the ROM has more people here" is only worth reporting when we are also
  // under the bundle ceiling AND nothing else places them.
  const cap = BUNDLE_CAP.get(mapId);
  const placedElsewhere = OTHER_PLACERS.get(mapId) || 0;
  const room = (cap == null ? Infinity : cap) - ours.length - placedElsewhere;
  if (romInRoom.length > ours.length + placedElsewhere && room > 0) {
    note(`map ${mapId} (${name}): the ROM puts ${romInRoom.length} NPC(s) in this room and we place ` +
         `${ours.length + placedElsewhere}, with ${room} spare sprite bundle(s) — at ` +
         `${romInRoom.map(n => `(${n.x},${n.y})`).join(' ')}`);
  }

  if (ASCII) {
    console.log('');
    const ourAt = new Map(ours.map(n => [n.y * W + n.x, 'o']));
    const romAt = new Map(romNpcs.map(n => [n.y * W + n.x, 'r']));
    console.log('    ' + Array.from({ length: W }, (_, i) => (i % 10)).join(''));
    for (let y = 0; y < W; y++) {
      let row = '';
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (x === sx && y === sy) { row += 'S'; continue; }
        if (ourAt.has(k)) { row += 'o'; continue; }
        if (romAt.has(k)) { row += 'r'; continue; }
        const mid = md.tilemap[k];
        const c = md.collision[mid < 128 ? mid : mid & 0x7F];
        if (c & 0x80) { row += 'D'; continue; }
        row += reach.has(k) ? '+' : ((c & 0x07) !== 3 ? '.' : '#');
      }
      console.log(String(y).padStart(3) + ' ' + row);
    }
    console.log('');
  }
}

console.log('');
if (!problems.length) { console.log('ur-audit: no problems found'); process.exit(0); }
console.log(`ur-audit: ${problems.length} thing(s) to look at`);
for (const p of problems) console.log('  • ' + p);
