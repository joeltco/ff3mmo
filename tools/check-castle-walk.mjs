#!/usr/bin/env node
// check-castle-walk.mjs — WALK Castle Sasune with the shipped engine.
//
// Players reported barred exits in Castle Sasune. Three rooms — the THRONE
// ROOM, the keep's 2F, and half the keep hall — were rooms you walked into and
// could not walk out of, and every gate we had said the castle was fine:
//
//   * `check-map-exits` listed the courtyard and none of the interiors, and
//     counted exit TILES rather than exits the engine allows.
//   * `check-area-graph` printed the nine dead doors as a ✓, because refusing
//     an unbuilt destination is what it was written to want.
//   * `map-audit --play` reported "WALLED IN: 0 maps" — it walks the
//     CARTRIDGE's door graph and knows nothing about `isShippedMap`.
//
// Every one of those measures the map data. None of them walks the game. This
// one drives `map-triggers.js#checkTrigger`, `map-loading.js#loadMapById` and
// `transitions.js#updateTransition` — the real functions, in the real order —
// and reports where the player actually ends up.
//
//   node tools/check-castle-walk.mjs           # pass/fail
//   node tools/check-castle-walk.mjs --trace   # print every step
//
// The route is the round trip the quest forces on every player:
//
//   courtyard -> keep hall -> upper hall -> 2F -> THRONE ROOM (the King)
//   and all the way back out again.
//
// It is not hand-plotted. Each leg names a DOOR TILE; the harness pathfinds to
// it through `MapRenderer.isPassable`, stands on it, and lets the engine decide
// what happens. A leg fails if the engine refuses (the message box says "The way
// is barred."), if no path to the tile exists, or if the player lands on a map
// or tile the leg did not expect.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }), location: { href: '' } };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {}, body: { appendChild() {} } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// The player sprite is a RENDERING object; the walk never draws. `map-loading`,
// `map-triggers` and `transitions` between them call exactly two of its methods
// (`setDirection`, `resetFrame`), so a two-method double stands in for it. That
// is a test double for a canvas object, not a reimplementation of any game
// logic — every decision below is still made by the shipped modules.
const { setPlayerSprite } = await import('../src/player-sprite.js');
setPlayerSprite({ setDirection() {}, resetFrame() {} });

const { mapSt } = await import('../src/map-state.js');
const { transSt } = await import('../src/transitions.js');
const updateTransition = (await import('../src/transitions.js')).updateTransition;
const { initMapLoading, loadMapById } = await import('../src/map-loading.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { msgState } = await import('../src/message-box.js');
const { _nesNameToString } = await import('../src/text-utils.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
initMapLoading(new Uint8Array(fs.readFileSync(ROM)));

const TRACE = process.argv.includes('--trace');
const TILE = 16;
let fails = 0;
const fail = (m) => { console.error('  ✗ ' + m); fails++; };
const ok = (m) => console.log('  ✓ ' + m);

/** Let the wipe/door animation run to completion, however long it wants. */
function settle() {
  for (let i = 0; i < 400 && transSt.state !== 'none'; i++) updateTransition(64);
  // The door-opening path parks its work in `pendingAction` without entering a
  // wipe; `movement.js` runs it when the animation ends.
  if (transSt.pendingAction) { const a = transSt.pendingAction; transSt.pendingAction = null; a(); }
}

const at = () => ({ map: mapSt.currentMapId, x: mapSt.worldX / TILE, y: mapSt.worldY / TILE });

/** The message box's current text, or ''. */
function msgText() {
  if (!msgState.bytes) return '';
  // `_nesNameToString` is the engine's own byte->string reader; it keeps letters
  // and digits and drops punctuation, which is plenty to tell "The way is
  // barred" from any other refusal.
  return _nesNameToString(msgState.bytes) || '<non-text message>';
}

/** Shortest walk from the player's tile to (tx,ty) through the game's own passability. */
function pathTo(tx, ty) {
  const start = at();
  const r = mapSt.mapRenderer;
  const key = (x, y) => y * 32 + x;
  const prev = new Map([[key(start.x, start.y), null]]);
  const q = [[start.x, start.y]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) {
      const path = [];
      for (let k = key(x, y); k !== null; k = prev.get(k)) path.push([k % 32, Math.floor(k / 32)]);
      return path.reverse();
    }
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (nx < 0 || ny < 0 || nx > 31 || ny > 31 || prev.has(k)) continue;
      // The destination itself may be a door the player steps ONTO; anything
      // else must be walkable.
      if (!(nx === tx && ny === ty) && !r.isPassable(nx, ny)) continue;
      prev.set(k, key(x, y)); q.push([nx, ny]);
    }
  }
  return null;
}

/**
 * Walk to (tx,ty) on the current map, ONE TILE AT A TIME, and let the engine
 * act on each arrival.
 *
 * ⛔ Stepping straight onto the target would test the wrong thing. The engine
 * parks `mapSt.disabledTrigger` on the tile you land on, so a staircase you
 * just came out of does not immediately fire again — teleporting onto it finds
 * it disabled and reports a working stair as dead. The two lines below are the
 * tail of `movement.js#_onMoveComplete` (clear the flag once the player is off
 * the tile, then `checkTrigger`); everything they lead to is the shipped code.
 * See movement.js:427-433 and :452.
 */
function step(tx, ty) {
  let path = pathTo(tx, ty);
  if (!path) return { landed: null, pathErr: `no walkable path to (${tx},${ty})`, msg: '' };
  // Already standing on it — which is the normal case for a staircase you just
  // came up. The player steps OFF and back ON; so does this.
  if (path.length === 1) {
    const r = mapSt.mapRenderer;
    const side = [[0, 1], [0, -1], [1, 0], [-1, 0]]
      .map(([dx, dy]) => [tx + dx, ty + dy])
      .find(([x, y]) => x >= 0 && y >= 0 && x < 32 && y < 32 && r.isPassable(x, y));
    if (!side) return { landed: null, pathErr: `(${tx},${ty}) has no walkable tile beside it`, msg: '' };
    path = [[tx, ty], side, [tx, ty]];
  }
  msgState.bytes = null;
  const from = at();
  let consumed = false;
  for (const [x, y] of path.slice(1)) {
    mapSt.worldX = x * TILE; mapSt.worldY = y * TILE;
    const d = mapSt.disabledTrigger;
    if (d && (d.x !== x || d.y !== y)) mapSt.disabledTrigger = null;
    if (checkTrigger()) { consumed = true; settle(); break; }
  }
  const landed = at();
  const msg = msgText();
  const moved = landed.map !== from.map || landed.x !== tx || landed.y !== ty;
  return { landed, consumed, refused: !!msg || (consumed && !moved), msg, pathErr: '' };
}

// ── the route ────────────────────────────────────────────────────────────────
//
// `door` is the tile to walk onto; `expect` is where the cartridge puts you.
// Both halves matter: an alias that resolves to the right ROOM at the wrong
// TILE drops the player inside a wall or on the far side of the keep.
const ROUTE = [
  // ── the keep ───────────────────────────────────────────────────────────
  //
  // ⚠ ONE TILEMAP, THREE DISJOINT ROOMS. Tilemap 9f843cd0 holds the lower
  // hall, the upper hall and a small east chamber with no floor between them;
  // the staircases ARE the connection, which is why the cartridge needs six
  // arrival ids for it and why a route that assumes one walkable room fails to
  // find half these tiles. Tilemap a1a1ac50 (the 2F) is two rooms the same way:
  // a five-tile stair vestibule holding the throne-room door, and the big
  // chamber next to it.
  { leg: 'courtyard -> keep hall',          door: [15, 18], expect: { map: 25, x: 10, y: 29 } },
  { leg: 'hall -> upper hall',              door: [10, 21], expect: { map: 25, x: 10, y:  9 } },
  { leg: 'upper hall -> 2F vestibule',      door: [10,  5], expect: { map: 28, x: 10, y: 24 } },
  { leg: 'vestibule -> THRONE ROOM',        door: [10, 20], expect: { map: 29, x: 10, y: 14 } },
  // ⭐ THE LEG THAT WAS BROKEN. Map 29's one and only trigger tile, and the
  // King stands in this room: `sasune_missing_daughter` both starts and ends
  // here, so every player who takes the quest was walking into a dead end.
  { leg: 'THRONE ROOM -> 2F vestibule',     door: [10, 14], expect: { map: 28, x: 10, y: 20 } },
  { leg: '2F vestibule -> upper hall',      door: [10, 24], expect: { map: 25, x: 10, y:  5 } },
  // The other two stair pairs, both halves each — symmetry is not assumed.
  { leg: 'upper hall -> east chamber',      door: [16,  2], expect: { map: 25, x: 16, y: 21 } },
  { leg: 'east chamber -> upper hall',      door: [16, 21], expect: { map: 25, x: 16, y:  2 } },
  { leg: 'upper hall -> 2F chamber',        door: [14,  7], expect: { map: 28, x: 14, y: 24 } },
  { leg: '2F chamber -> upper hall',        door: [14, 24], expect: { map: 25, x: 14, y:  7 } },
  { leg: 'upper hall -> hall',              door: [10,  9], expect: { map: 25, x: 10, y: 21 } },
  { leg: 'hall -> courtyard (front door)',  door: [10, 31], expect: { map: 18, x: 15, y: 19 } },

  // ── the west tower ─────────────────────────────────────────────────────
  //
  // Four floors deep, and every one of them returns through a COLLISION
  // exit-prev on its arrival tile rather than through a door — the other half
  // of the engine's exit dispatch, and the half the return stack serves. Walked
  // here so the pop-if-top rule cannot quietly break it.
  { leg: 'courtyard -> tower 1F',           door: [ 7, 12], expect: { map: 19, x:  4, y:  8 } },
  { leg: 'tower 1F -> tower 2F',            door: [ 4,  5], expect: { map: 20, x:  4, y:  5 } },
  { leg: 'tower 2F -> tower 3F',            door: [ 4,  2], expect: { map: 23, x: 27, y:  2 } },
  { leg: 'tower 3F -> tower 4F',            door: [27,  7], expect: { map: 21, x:  4, y: 29 } },
  { leg: 'tower 4F -> tower 3F (exit-prev)', door: [ 4, 29], expect: { map: 23, x: 27, y:  7 } },
  { leg: 'tower 3F -> tower 2F (exit-prev)', door: [27,  2], expect: { map: 20, x:  4, y:  2 } },
  { leg: 'tower 2F -> tower 1F (exit-prev)', door: [ 4,  5], expect: { map: 19, x:  4, y:  5 } },
  { leg: 'tower 1F -> courtyard (exit-prev)', door: [ 4, 10], expect: { map: 18, x:  7, y: 12 } },
];

console.log('castle walk');
loadMapById(18);
settle();
{
  const s = at();
  if (s.map !== 18) fail(`start: expected map 18, got ${s.map}`);
  else if (TRACE) console.log(`      start  map ${s.map} (${s.x},${s.y})`);
}

let reachedThrone = false;
for (const leg of ROUTE) {
  const before = at();
  const r = step(leg.door[0], leg.door[1]);
  if (r.msg) {
    fail(`${leg.leg}: standing on (${leg.door}) from map ${before.map} — the game said "${r.msg}"`);
    break;
  }
  if (!r.landed) { fail(`${leg.leg}: ${r.pathErr || 'the walk went nowhere'}`); break; }
  const e = leg.expect, l = r.landed;
  if (l.map !== e.map || l.x !== e.x || l.y !== e.y) {
    fail(`${leg.leg}: expected map ${e.map} (${e.x},${e.y}), landed on map ${l.map} (${l.x},${l.y})`);
    break;
  }
  if (l.map === 29) reachedThrone = true;
  if (TRACE) console.log(`      ${leg.leg.padEnd(34)} (${leg.door}) -> map ${l.map} (${l.x},${l.y})`);
}

if (!fails) ok(`${ROUTE.length} legs walked with the shipped engine, every landing tile as the cartridge places it`);
if (!reachedThrone && !fails) fail('the route never entered the throne room');

// ── and the stack does not grow when you go back the way you came ────────────
//
// Every leg above is a door, and half of them are the return half of a pair. If
// each pushed a breadcrumb, bouncing between two floors would grow the return
// stack forever and map 25's exit-prev tiles would send the player upstairs
// instead of out to the courtyard.
{
  const depth = mapSt.mapStack.length;
  if (depth > 4) {
    fail(`the return stack is ${depth} deep after a round trip that ends where it started — ` +
         `doors that go back the way you came must pop the trail, not extend it`);
  } else ok(`return stack ${depth} deep after the round trip (bounded — back-doors pop)`);
}

console.log(fails ? `\ncheck-castle-walk: ${fails} FAILURE(S)` : '\ncheck-castle-walk: OK');
process.exit(fails ? 1 : 0);
