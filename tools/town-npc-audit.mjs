#!/usr/bin/env node
// town-npc-audit.mjs — every townsperson, in one table: where they stand, what
// they wear, and whether they MOVE.
//
// The individual gates each answer one question (room, bundle, palette, words),
// and none of them answers "is this town right". This one walks all three and
// fails on the four ways a placement is wrong:
//
//   FROZEN     mode 'static' — a statue of a person. Standing still is fine;
//              standing still WITHOUT the walk animation is not. `addSceneNpc`
//              resolves mode = wander ? 'pause' : (animate ? 'idle-march'
//              : 'static'), so a spec that turns wandering off without turning
//              animation on freezes.
//   STUCK      a wanderer on a tile it can never legally step off
//   OUT OF THE ROOM  not talkable from where the player walks in
//   WRONG SPRITE     standing on a ROM record while wearing a different bundle
//                    than the record does (reported, not failed — see below)
//
//   node tools/town-npc-audit.mjs            # table + verdict
//   node tools/town-npc-audit.mjs --quiet    # verdict only

import fs from 'node:fs';

const _ctx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _ctx }) };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const quiet = process.argv.includes('--quiet');

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { AREAS } = await import('../src/data/areas.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');
const { playerRegion, isTalkable, isTransitionTile } = await import('./lib/talkable.mjs');
const { isOpenAreaTile, isWalkableForNpc, MIN_OPEN_NEIGHBOURS } = await import('../src/data/npc-walk-area.js');
const { bundleForNpcId } = await import('../src/data/npc-gfx.js');

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const W = 32;

// Placed outside TOWN_NPCS by map-loading.js — they are townspeople too, and a
// frozen shop keeper is the same bug.
const SPECIAL = new Map([
  [3,  [{ key: 'bm_shop (ur_magic)',    x: 4, y: 4, mode: 'idle-march', wander: false }]],
  [15, [{ key: 'bm_shop (kazus_magic)', x: 4, y: 4, mode: 'idle-march', wander: false }]],
]);

const townOf = new Map();
for (const a of AREAS) for (const m of [a.head, ...a.rooms.keys()]) townOf.set(m, a.banner);

let frozen = 0, stuck = 0, exiled = 0, wrongSprite = 0, total = 0;
const rows = [];

const maps = new Set([...TOWN_NPCS.keys(), ...SPECIAL.keys()]);
for (const mapId of [...maps].sort((a, b) => a - b)) {
  const md = loadMap(rom, mapId);
  const { stand } = playerRegion(md, MapRenderer, calcSpawnY);
  // ⛔ THE NEIGHBOUR COUNT USES `isWalkableForNpc`, NOT `isOpenAreaTile`. This
  // tool first counted neighbours that were themselves open-AREA tiles, which is
  // a stricter rule than the game's and reported two Ur wanderers as STUCK when
  // the shipped predicate says they are fine. `isOpenAreaTile` is walkable AND
  // >= MIN_OPEN_NEIGHBOURS *walkable* neighbours — call it, never restate it.
  const openN = (x, y) => {
    let n = 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W) continue;
      if (isWalkableForNpc(md, nx, ny)) n++;
    }
    return n;
  };

  const list = [
    ...(TOWN_NPCS.get(mapId) || []).map((e) => ({
      key: e.key, x: e.x, y: e.y, bundle: e.spec.romOffset,
      // The game's own resolution, from npc.js#addSceneNpc.
      mode: e.spec.wander ? 'pause' : (e.spec.animate ? 'idle-march' : 'static'),
      wander: !!e.spec.wander, when: e.when,
    })),
    ...(SPECIAL.get(mapId) || []),
  ];

  for (const n of list) {
    total++;
    const nb = openN(n.x, n.y);
    const flags = [];
    if (n.mode === 'static') { flags.push('FROZEN'); frozen++; }
    if (n.wander && !isOpenAreaTile(md, n.x, n.y)) { flags.push('STUCK'); stuck++; }
    if (!isTalkable(md, stand, n.x, n.y)) { flags.push('OUT-OF-ROOM'); exiled++; }
    if (isTransitionTile(md, n.x, n.y)) { flags.push('ON-A-DOOR'); exiled++; }
    let sprite = '';
    if (n.bundle != null) {
      const here = md.npcs.filter((r) => r.x === n.x && r.y === n.y);
      const wants = [...new Set(here.map((r) => bundleForNpcId(rom, r.id)).filter((b) => b != null))];
      if (wants.length && !wants.includes(n.bundle)) {
        sprite = 'ROM record wears ' + wants.map((b) => '0x' + b.toString(16).toUpperCase()).join('/');
        wrongSprite++;
      }
    }
    rows.push({
      town: townOf.get(mapId) || '?', mapId, key: n.key, x: n.x, y: n.y,
      mode: n.mode, nb, when: n.when ? 'quest-gated' : '', flags, sprite,
    });
  }
}

if (!quiet) {
  let town = null;
  for (const r of rows) {
    if (r.town !== town) { town = r.town; console.log(`\n── ${town} ──`); }
    console.log(
      `  ${String(r.mapId).padStart(3)}  ${r.key.padEnd(24)} (${String(r.x).padStart(2)},${String(r.y).padStart(2)})  ` +
      `${r.mode.padEnd(11)} nb=${r.nb} ${r.when.padEnd(11)} ` +
      `${r.flags.length ? '⛔ ' + r.flags.join(' ') : '✓'}${r.sprite ? '  ⚠ ' + r.sprite : ''}`);
  }
}

const byMode = rows.reduce((m, r) => (m[r.mode] = (m[r.mode] || 0) + 1, m), {});
console.log(`\n${total} townspeople — ${byMode['pause'] || 0} walk, ${byMode['idle-march'] || 0} march in place, ${byMode['static'] || 0} frozen`);
// ⚠ WRONG SPRITE IS REPORTED, NOT FAILED. Some are deliberate: Ur's wanderers
// re-roll their spawn from a grass pool on every map entry, so their declared
// tile is a fallback rather than where they stand.
if (wrongSprite) console.log(`⚠ ${wrongSprite} wearing a different sprite than the ROM record they stand on (see the table)`);

const bad = frozen + stuck + exiled;
if (bad) console.error(`\n⛔ ${frozen} frozen, ${stuck} stuck, ${exiled} out of place`);
else console.log('✅ everyone is in their room, reachable, and moving');
process.exit(bad ? 1 : 0);
