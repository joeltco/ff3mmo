#!/usr/bin/env node
// map-trigger-dump.mjs — where every trigger tile in the game actually is.
//
// `world-sfx-sweep.cjs` can spawn the party on any tile (SPAWN=x,y) but it is a
// CommonJS script and the map reader is ESM, so the coordinates are dumped here
// and handed over as JSON. That split is deliberate: the sweep should not be
// re-deriving map structure, and this should not be booting an emulator.
//
//   node tools/map-trigger-dump.mjs                 # summary, maps with triggers
//   node tools/map-trigger-dump.mjs 114             # one map, listed
//   node tools/map-trigger-dump.mjs --json out.json # every map, machine-readable
//
// Trigger tile ids come from `map-loader.js#TRIGGER_TYPE_TABLE` (ROM disasm at
// 3A/921F): $60-$63 events, $70-$77 entrances/doors, $78-$7C treasure. Anything
// else >= $60 is reported as unknown rather than guessed at — the $68 tiles in
// Ur are real and are not in that table.

import fs from 'node:fs';
import { loadMap } from '../src/map-loader.js';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const W = 32;

export function kindOf(tile) {
  if (tile >= 0x60 && tile < 0x64) return 'event';
  if (tile >= 0x70 && tile < 0x78) return 'door';
  if (tile >= 0x78 && tile < 0x7C) return 'vase';
  if (tile === 0x7C) return 'chest';
  return 'unknown';
}

/**
 * Can the party stand here? Mirrors the ordinary-tile half of
 * `map-renderer.js#isPassable` — bit 7 marks a collision-trigger tile, and the
 * low three bits are the z-level: 0 is open floor, >= 4 is a bridge, 1-3 are
 * walls at some height.
 *
 * This matters more than it looks. The first version of this dump picked the
 * tile BELOW each trigger unconditionally; on most maps that is a wall, so the
 * party spawned inside solid rock and 4 of the first 5 sweeps recorded no sound
 * at all. A spawn point that cannot be stood on produces a clean, silent, and
 * completely worthless run.
 *
 * The z rule is the game's, not a cautious approximation of it. Guessing
 * "passable means z === 0 or z >= 4" felt safely conservative and was simply
 * wrong: it rejects z 1 and 2, which covers essentially all ordinary town floor
 * — including (21,27) in Ur, a tile already PROVEN to work by a run that fired
 * the door sound 14 times from it. Only z === 3 is unconditionally blocked;
 * 1 and 2 block just when they conflict with the player's own z, which is 0 on
 * arrival. Checking the guess against a known-good tile is what caught it.
 */
function passable(r, x, y) {
  if (x < 0 || x >= W || y < 0 || y >= 32) return false;
  const id = r.tilemap[y * W + x];
  if (id >= 0x60) return false;                     // a trigger tile, not a standing spot
  const c = r.collision[id & 0x7F];
  if (c & 0x80) return false;                       // collision-driven trigger tile
  return (c & 0x07) !== 3;
}

/** Every trigger tile on one map, with a walkable tile to approach it from. */
export function triggersOf(mapId) {
  let r;
  try { r = loadMap(rom, mapId); } catch { return null; }
  if (!r || !r.tilemap || !r.collision) return null;
  const out = [];
  // Two INDEPENDENT trigger mechanisms, and only one of them lives in the
  // tilemap. Tile ids >= $60 are the placeholder triggers (doors, chests,
  // events). Separately, ANY metatile whose collision byte has bit 7 set is a
  // collision-driven trigger, with its kind in the high nibble of collision
  // byte 2 — that is `map-renderer.js#isPassable`'s first branch. Trap floors
  // and map exits are in that second group, so a dump that only walked the
  // tilemap would silently never offer them as targets.
  for (let i = 0; i < r.tilemap.length; i++) {
    const id = r.tilemap[i];
    if (id >= 0x60) continue;
    if (!(r.collision[id & 0x7F] & 0x80)) continue;
    const x = i % W, y = (i - x) / W;
    const b2 = r.collisionByte2 ? r.collisionByte2[id] : 0;
    const trigType = (b2 >> 4) & 0x0F;
    const cand = [[x, y + 1, 'up'], [x, y - 1, 'down'], [x + 1, y, 'left'], [x - 1, y, 'right']]
      .filter(([cx, cy]) => passable(r, cx, cy));
    if (!cand.length) continue;
    const [sx, sy, walk] = cand[0];
    out.push({ tile: id, kind: `coll${trigType}`, trigType, x, y, spawn: [sx, sy], walk });
  }
  for (let i = 0; i < r.tilemap.length; i++) {
    const t = r.tilemap[i];
    if (t < 0x60) continue;
    const x = i % W, y = (i - x) / W;
    // Approach from below first — FF3 doors are entered walking UP into them —
    // but only from a tile the party can actually stand on.
    const cand = [[x, y + 1, 'up'], [x, y - 1, 'down'], [x + 1, y, 'left'], [x - 1, y, 'right']]
      .filter(([cx, cy]) => passable(r, cx, cy));
    if (!cand.length) continue;                     // unreachable; do not emit a dead target
    const [sx, sy, walk] = cand[0];
    out.push({ tile: t, kind: kindOf(t), x, y, spawn: [sx, sy], walk });
  }
  return { mapId, entrance: [r.entranceX, r.entranceY], song: r.songId, tileset: r.tileset,
           dest: Array.from(r.entranceData || []).slice(0, 8), triggers: out };
}

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');

if (jsonAt >= 0) {
  const all = [];
  for (let m = 0; m < 512; m++) {
    const r = triggersOf(m);
    if (r && r.triggers.length) all.push(r);
  }
  const path = args[jsonAt + 1] || 'map-triggers.json';
  fs.writeFileSync(path, JSON.stringify(all, null, 1));
  console.log(`${all.length} maps with triggers -> ${path}`);
} else if (args.length && /^\d+$/.test(args[0])) {
  const r = triggersOf(parseInt(args[0], 10));
  if (!r) { console.error('map did not load'); process.exit(1); }
  console.log(`map ${r.mapId}  entrance ${r.entrance}  song ${r.song}  tileset ${r.tileset}`);
  console.log(`  destinations: ${r.dest.join(',')}`);
  for (const t of r.triggers) {
    console.log(`  0x${t.tile.toString(16)} ${t.kind.padEnd(8)} at (${t.x},${t.y})`
      + `   SPAWN=${t.spawn.join(',')} WALK=${t.walk}`);
  }
} else {
  const tally = {};
  let maps = 0;
  for (let m = 0; m < 512; m++) {
    const r = triggersOf(m);
    if (!r || !r.triggers.length) continue;
    maps++;
    for (const t of r.triggers) {
      const k = `0x${t.tile.toString(16)} ${t.kind}`;
      tally[k] = (tally[k] || 0) + 1;
    }
  }
  console.log(`${maps} maps carry trigger tiles. Tiles seen across the game:`);
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${n}`);
  }
}
