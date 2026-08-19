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

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

// Maps a player can actually be in today. Kept explicit: sweeping all 256
// re-reports the long-known unreachable slots (`map-triggers.js` STRANDING_MAPS)
// and buries a real regression in noise.
const LIVE = [
  [114, 'Ur'], [1, 'Ur secret2'], [2, 'Ur secret'], [3, 'Ur magic'], [4, 'Ur armor'],
  [5, 'Ur weapon'], [6, 'Ur elder1'], [7, 'Ur elder2'], [8, 'Ur inn'], [9, 'Ur tavern'],
  [10, 'Kazus'], [12, 'Kazus inn'], [15, 'Kazus magic'], [16, 'Kazus weapon'], [17, 'Kazus armor'],
  [18, 'Castle Sasune'],
  // Not reachable on foot yet — both sit past the choke boulder — but they
  // carry the SAME defect Sasune did (exit tiles with collision $80, refused by
  // isPassable) and are fixed by the same fire-on-attempt change. Listed now so
  // opening the world later cannot quietly re-introduce a map with no way out;
  // that is exactly how Sasune shipped.
  [124, 'map 124 (world entrance 63,32)'],
  [167, 'map 167 (world entrance 88,66)'],
];

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

for (const [mapId, name] of LIVE) {
  const md = loadMap(rom, mapId);
  const mr = new MapRenderer(md, md.entranceX, md.entranceY);
  const sx = md.entranceX, sy = calcSpawnY(md, md.entranceX, md.entranceY);

  // Every exit the map offers, of any kind: to-world (1), to-previous (0),
  // and doors (4,5) that lead somewhere else.
  const exits = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const raw = md.tilemap[y * 32 + x];
      const m = raw < 128 ? raw : raw & 0x7F;
      // ⛔ The VOID metatile decodes as trigger-type 0 ("exit to previous"), so
      // every map shows a row of phantom exits along y=0. They are unreachable
      // today, but a map with reachable void at the edge would satisfy this
      // gate on an exit that does not exist. Skip the fill tile.
      if (m === (md.fillTile < 128 ? md.fillTile : md.fillTile & 0x7F)) continue;
      const t = ((md.collisionByte2[m] || 0) >> 4) & 0x0F;
      if (t === 0 || t === 1 || t === 4 || t === 5) exits.push({ x, y, t });
    }
  }
  if (!exits.length) { bad(`${name} (map ${mapId}) has NO exit tiles of any kind`); continue; }

  // Flood from the spawn through the game's own passability.
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32 || seen.has(k)) continue;
      if (!mr.isPassable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }

  // An exit counts as usable when the player can STAND ON it, or stand next to
  // it and walk in (fire-on-attempt).
  const usable = exits.filter(e =>
    seen.has(`${e.x},${e.y}`) ||
    [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => seen.has(`${e.x + dx},${e.y + dy}`)));

  if (!usable.length) {
    bad(`${name} (map ${mapId}): ${exits.length} exit tile(s), NONE reachable from spawn ` +
        `(${sx},${sy}) — the player walks in and is stuck`);
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
