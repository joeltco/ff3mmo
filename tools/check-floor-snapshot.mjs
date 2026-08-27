#!/usr/bin/env node
// check-floor-snapshot.mjs — a refactor of the dungeon generator must change
// NOTHING. Hashes every generated map for a fixed seed list and compares against
// a committed fixture.
//
// This is the safety net for the phase-1 vocabulary extraction
// (docs/DUNGEON-CHAMBERS-PLAN.md §4): moving carve code into modules is only
// correct if the output is byte-identical, and "I looked at a few floors" is not
// that. 5 floors x N seeds, plus the three side maps.
//
// ⛔ IT HASHES THE WIRING, NOT JUST THE TILEMAP. A refactor can preserve every
// tile and still break `triggerMap` / `dungeonDestinations` / `falseWalls` /
// `lockedDoors` / `rockSwitch`, which is how a floor ends up looking perfect and
// having no way out. Everything structural the generator returns is in the
// digest. ROM-derived assets (chrTiles, metatiles, palettes) are not — they are
// cached, identical by construction, and huge.
//
// ⛔ IT WALKS EVERY ROW IN `DUNGEONS`, NOT THE DEFAULT ONE. It used to call
// `generateFloor(rom, f, seed)` with no dungeon argument, so every digest in the
// fixture was Altar Cave's — and the Cave of Seals, which has its own registry
// row and (since the layout block) its own floor layouts, was hashed by nothing.
// Altar Cave's rows keep their historical `floorN` keys so the existing fixture
// values still verify; every other dungeon is `<id>/floorN`.
//
//   node tools/check-floor-snapshot.mjs            # verify against the fixture
//   node tools/check-floor-snapshot.mjs --update   # re-baseline (INTENTIONAL changes only)
//   node tools/check-floor-snapshot.mjs --seeds 50 # fewer seeds while iterating

import fs from 'node:fs';
import crypto from 'node:crypto';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const FIXTURE = new URL('../docs/FLOOR-SNAPSHOT.json', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { generateFloor, generateSecretRoomMap } = await import('../src/dungeon-generator.js');
const { generateLockedRoomMap } = await import('../src/dungeon-locked-room.js');
const { DUNGEONS, STARTING_DUNGEON } = await import('../src/data/dungeons.js');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const SEEDS = parseInt((args[args.indexOf('--seeds') + 1] || '400'), 10) || 400;
const BASE = 1754900000000;

// Canonical text form of everything structural a generated map returns.
function digestOf(r) {
  const parts = [];
  parts.push('tm:' + Buffer.from(r.tilemap).toString('hex'));
  parts.push(`ent:${r.entranceX},${r.entranceY}`);
  parts.push(`ts:${r.tileset} fill:${r.fillTile} exit:${r.mapExit} clip:${r.skipRoomClip ? 1 : 0}`);
  const mapPairs = (m) => m ? [...m.entries()].map(([k, v]) => `${k}=${JSON.stringify(v)}`).sort().join('|') : '';
  const setList  = (s) => s ? [...s].sort().join('|') : '';
  parts.push('trig:' + mapPairs(r.triggerMap));
  parts.push('dest:' + mapPairs(r.dungeonDestinations));
  parts.push('false:' + mapPairs(r.falseWalls));
  parts.push('secret:' + setList(r.secretWalls));
  parts.push('traps:' + setList(r.hiddenTraps));
  parts.push('locked:' + setList(r.lockedDoors));
  parts.push('pond:' + setList(r.pondTiles));
  parts.push('rock:' + JSON.stringify(r.rockSwitch || null));
  parts.push('warp:' + JSON.stringify(r.warpTile || null));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const rows = {};
for (const dg of DUNGEONS) {
  // Altar Cave keeps the bare `floorN` key it has always had, so its committed
  // digests stay comparable across this change.
  const key = (f) => (dg === STARTING_DUNGEON ? `floor${f}` : `${dg.id}/floor${f}`);
  for (let f = 0; f < dg.floors; f++) {
    const h = crypto.createHash('sha256');
    for (let k = 0; k < SEEDS; k++) h.update(digestOf(generateFloor(rom, f, BASE + k * 7919, dg)));
    rows[key(f)] = h.digest('hex').slice(0, 16);
  }
}
{
  const h = crypto.createHash('sha256');
  for (const goLeft of [true, false]) h.update(digestOf(generateSecretRoomMap(rom, goLeft)));
  rows.secretRooms = h.digest('hex').slice(0, 16);
}
// ⛔ FROM THE REGISTRY, AND WITH ITS OWN DUNGEON. Hardcoding `[1010, 1011]`
// meant a new dungeon's locked room was hashed by nothing, and calling
// `generateLockedRoomMap` without a dungeon meant it was hashed wearing Altar
// Cave's art rather than the one `map-loading.js` actually builds.
for (const dg of DUNGEONS) {
  for (const { mapId } of dg.lockedRooms || []) {
    const h = crypto.createHash('sha256');
    for (let k = 0; k < SEEDS; k++) h.update(digestOf(generateLockedRoomMap(rom, ((BASE + k * 7919) | 0) ^ mapId | 0, dg)));
    rows[`locked${mapId}`] = h.digest('hex').slice(0, 16);
  }
}

const payload = { _what: 'Structural digest of every generated dungeon map. Phase-1 refactors must not change it. Regenerate with --update ONLY for an intentional change, and say so in the changelog.', seeds: SEEDS, base: BASE, rows };

if (UPDATE) {
  fs.writeFileSync(FIXTURE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`baselined ${Object.keys(rows).length} maps at ${SEEDS} seeds -> docs/FLOOR-SNAPSHOT.json`);
  for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(14)} ${v}`);
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.log('no fixture — run with --update first'); process.exit(1);
}
const prev = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
if (prev.seeds !== SEEDS) {
  console.log(`fixture was built at ${prev.seeds} seeds, this run used ${SEEDS} — digests are not comparable`);
  process.exit(1);
}
const bad = [];
for (const [k, v] of Object.entries(rows)) {
  const was = prev.rows[k];
  console.log(`${k.padEnd(14)} ${v} ${was === v ? 'ok' : `CHANGED (was ${was})`}`);
  if (was !== v) bad.push(k);
}
for (const k of Object.keys(prev.rows)) if (!(k in rows)) bad.push(`${k} MISSING from this run`);

if (bad.length) {
  console.log(`\nFAIL: ${bad.length} map set(s) changed: ${bad.join(', ')}`);
  console.log('A phase-1 refactor must be byte-identical. If the change is intentional, re-baseline with --update and say so in the changelog.');
  process.exit(1);
}
console.log('\ngenerator output unchanged');
