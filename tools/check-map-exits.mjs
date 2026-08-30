#!/usr/bin/env node
// check-map-exits.mjs — you can get back OUT of every map you can get into.
//
// Castle Sasune shipped with no way out. Its three exit tiles carry collision
// bit $80, so `MapRenderer.isPassable` refuses them, so the step-on
// `checkTrigger` could never see them — you walked in and were stuck. Maps 124
// and 167 are the same. `map-renderer.js` has carried a comment describing this
// exact consequence for versions; nothing failed a build over it.
//
//   node tools/check-map-exits.mjs
//
// The fix is fire-on-attempt (`map-triggers.js#tryExitToWorldAt`): walking INTO
// an exit tile leaves the map, and the player never stands on one. So this gate
// does NOT check that exit tiles are passable — they must not be. It checks
// that from the spawn you can REACH a tile adjacent to one, which is what the
// player actually needs to be able to do.
//
// ── ⛔ AND THEN IT SHIPPED THE SAME BUG AGAIN, TWO WAYS ────────────────────
//
// v1.11.16. Players reported Castle Sasune had barred exits. Three of its rooms
// — the THRONE ROOM among them, where the King gives and takes back
// `sasune_missing_daughter` — were absolute traps: walk in, no way out but a
// relog. This gate passed the whole time, for two separate reasons, and BOTH
// are fixed here rather than in a comment:
//
//   1. ITS LIST WAS TOWNS-ONLY. `LIVE` named Ur's eleven rooms, Kazus's five and
//      Castle Sasune's COURTYARD, and stopped. Every interior of the castle —
//      19, 20, 21, 23, 25, 28, 29, 174 — went unexamined. A hand-written list of
//      the maps to check is a list of the maps you already thought about. It is
//      now derived from `SHIPPED_MAPS`, so shipping a room enrolls it.
//
//   2. IT COUNTED TILES, NOT EXITS THE ENGINE ALLOWS. "An exit tile adjacent to
//      the flood" is true of a door the game refuses with "The way is barred."
//      All three trapped rooms had exactly one exit tile, reachable, and barred.
//      This gate now asks the SHIPPED PREDICATES — `isShippedMap` for door
//      destinations and `map-triggers.js#STRANDING_MAPS` — what actually
//      happens when the player walks into it.
//
// The exits it now recognises, which is the engine's own dispatch
// (`map-triggers.js#checkTrigger`):
//
//   dynamic type 1  a door: `entranceData[trigId]`, allowed iff the destination
//                   is shipped and not a stranding map. Alias destinations
//                   resolve through `areas.js#ARRIVAL_ALIASES`.
//   dynamic type 0  exit to the previous map — pops the stack, always allowed
//   collision type 0  same, from the tile's collision byte rather than a
//                   placeholder tile. This is how every tower and upper floor in
//                   the game returns, and missing it is what made an earlier
//                   pass of this investigation wrongly call maps 19/20/21/23/174
//                   traps.
//   collision type 1  exit straight to the overworld — always allowed

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { SHIPPED_MAPS, isShippedMap, ARRIVAL_ALIASES } = await import('../src/data/areas.js');
// ⭐ THE ENGINE OPENS PASSAGES BEFORE THE PLAYER WALKS. `map-loading.js` calls
// `applyPassage` on every regular map load ($5B -> $5D doorframe, $5C -> $5E the
// walkable passage). Every reachability tool here used to skip it, which models
// each map more CLOSED than the game is — Ur's secret house read as 28 tiles
// with its treasure room walled off, against 49 tiles and an open way in live.
const { applyPassage } = await import('../src/map-passage.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// ⛔ NOT A HAND-WRITTEN LIST ANY MORE. `SHIPPED_MAPS` is the content list, so
// every place the game lets you walk into is checked whether or not anyone
// remembered to add it here. Arrival aliases are excluded: they are not rooms,
// they are other ways into a room this list already holds.
const FUTURE = [
  // Not reachable on foot yet — both sit past the choke boulder — but they
  // carry the SAME defect Sasune did (exit tiles with collision $80, refused by
  // isPassable) and are fixed by the same fire-on-attempt change. Listed now so
  // opening the world later cannot quietly re-introduce a map with no way out;
  // that is exactly how Sasune shipped.
  [124, 'map 124 (world entrance 63,32)'],
  [167, 'map 167 (world entrance 88,66)'],
];
const LIVE = [...[...SHIPPED_MAPS].sort((a, b) => a - b).map(id => [id, `map ${id}`]), ...FUTURE];

// The stranding guard, read from its one definition rather than restated —
// a copy here would agree with itself after somebody edited the real one.
const _trigSrc = fs.readFileSync(new URL('../src/map-triggers.js', import.meta.url), 'utf8');
const _sm = /const STRANDING_MAPS = new Set\(\[([^\]]*)\]\)/.exec(_trigSrc);
if (!_sm) { console.error('  \u26d4 could not find STRANDING_MAPS in map-triggers.js'); process.exit(1); }
const STRANDING = new Set(_sm[1].split(',').map(t => Number(t.trim())).filter(n => Number.isFinite(n)));

let failed = 0;
const bad = (m) => { console.error('  \u2717 ' + m); failed++; };

// Maps declared unreachable in areas.js are not in the play area; they are
// refused at the door, so they cannot trap anybody.
const DECLARED_UNREACHABLE = new Set();
{
  const { AREAS } = await import('../src/data/areas.js');
  for (const a of AREAS) for (const id of (a.unreachable || [])) DECLARED_UNREACHABLE.add(id);
}

for (const [mapId, name] of LIVE) {
  if (DECLARED_UNREACHABLE.has(mapId)) continue;
  const md = loadMap(rom, mapId);
  applyPassage(md.tilemap);
  const mr = new MapRenderer(md, md.entranceX, md.entranceY);

  // Seed from every tile the player can ARRIVE on. One tilemap can hold two
  // disjoint rooms joined by an internal staircase, and the cartridge addresses
  // the far one with an arrival alias — flooding from `entranceX/Y` alone sees
  // half the keep hall.
  const seeds = [[md.entranceX, calcSpawnY(md, md.entranceX, md.entranceY)]];
  for (const [alias, a] of ARRIVAL_ALIASES) {
    if (a.map !== mapId) continue;
    const am = loadMap(rom, alias);
    seeds.push([am.entranceX, calcSpawnY(am, am.entranceX, am.entranceY)]);
  }

  const seen = new Set(seeds.map(([x, y]) => `${x},${y}`));
  const q = seeds.slice();
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32 || seen.has(k)) continue;
      if (!mr.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  const near = (x, y) => seen.has(`${x},${y}`)
    || [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => seen.has(`${x + dx},${y + dy}`));

  // ⭐ ASK THE ENGINE, NOT THE TILEMAP. `getTriggerAt` is the very lookup
  // `checkTrigger` performs, so what comes back here is what the player gets.
  const usable = [];
  const refused = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const t = mr.getTriggerAt(x, y);
      if (!t || !near(x, y)) continue;
      if (t.source === 'dynamic') {
        if (t.type === 0) { usable.push(`(${x},${y}) exit-prev`); continue; }
        if (t.type !== 1) continue;
        const dest = md.entranceData[t.trigId] | 0;
        if (dest === 0) continue;                       // inert door, no destination
        if (STRANDING.has(dest)) { refused.push(`(${x},${y}) -> ${dest} stranding`); continue; }
        if (!isShippedMap(dest)) { refused.push(`(${x},${y}) -> ${dest} not shipped`); continue; }
        usable.push(`(${x},${y}) door -> ${dest}`);
      } else if (t.trigType === 0) usable.push(`(${x},${y}) collision exit-prev`);
      else if (t.trigType === 1) usable.push(`(${x},${y}) collision exit-to-world`);
    }
  }

  if (!usable.length) {
    bad(`${name}: no way out. ${refused.length} reachable exit(s), ALL refused by the engine` +
        (refused.length ? ` — ${refused.join('; ')}` : '') +
        ` — the player walks in and is stuck`);
  }
}

// ── the fire-on-attempt path itself ──────────────────────────────────────
// Reachability above passes whether or not the hook exists — standing NEXT to
// an exit tile is true either way. These two assert the mechanism.
{
  const { isExitToWorldTile } = await import('../src/map-triggers.js');
  const md18 = loadMap(rom, 18);
  if (!isExitToWorldTile(md18, 15, 31)) bad('Castle Sasune (15,31) is not recognised as an exit-to-world tile');
  if (isExitToWorldTile(md18, 15, 30)) bad('Castle Sasune (15,30) is plain floor but reads as an exit tile');

  // ⛔ And movement must actually CALL it on a blocked move. Comments stripped
  // so the sentence describing the call cannot satisfy the check.
  const mv = fs.readFileSync(new URL('../src/movement.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Match the REFUSED-MOVE block by its shape, not by one spelling of the
  // condition. v1.10.0 renamed the test to `!passable` when vehicles introduced
  // isPassableForMode; the requirement (tryExitToWorldAt must run when a move is
  // refused) is unchanged, so the pattern must not be tied to the old wording.
  const blocked = (mv.match(/!(?:renderer\.isPassable\(tileX, tileY\)|passable)\)[\s\S]{0,400}?\n {2}\}/) || [''])[0];
  if (!/tryExitToWorldAt\(tileX, tileY\)/.test(blocked)) {
    bad('movement.js does not call tryExitToWorldAt when a move is refused — exit tiles carry ' +
        'collision $80, so the step-on trigger can never fire and the map has no way out');
  }
}

if (failed) { console.error(`\ncheck-map-exits: FAIL (${failed})`); process.exit(1); }
console.log(`  ✓ all ${LIVE.length} live maps have a reachable way out`);
console.log('\ncheck-map-exits: OK');
