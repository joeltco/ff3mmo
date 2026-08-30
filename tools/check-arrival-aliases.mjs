#!/usr/bin/env node
// check-arrival-aliases.mjs — the alias table is the cartridge's, not ours.
//
// `data/areas.js#ARRIVAL_ALIASES` says which ROM map ids are the SAME ROOM
// entered by a different staircase. Getting it wrong is not cosmetic: an id
// missing from the table is a door the engine bars (that is how the throne room
// shipped as a trap), and an id wrongly IN it is a real room the player can
// never reach because every door to it lands somewhere else.
//
//   node tools/check-arrival-aliases.mjs
//
// ⭐ THE WHOLE TABLE IS RE-DERIVED HERE, from the ROM, every run. A map id in
// FF3 is (tilemap, door table, arrival tile) — a door names an id and the engine
// drops you on that id's `entranceX/Y`, so one room needing four staircases
// costs four ids. Two ids are the same room when ALL of these match:
//
//     the 1024 decompressed tilemap bytes
//     the 16-byte entrance/door table
//     npcIdx, tileset, fill tile
//
// and they differ only in `entranceX/Y` (and, in Sasune's case, one background
// palette line — see areas.js).
//
// ⛔ SONG IS PART OF THE IDENTITY TEST, not of the match. Maps 11 / 32 / 64 / 77
// pass every check above and are NOT aliases: they carry four different songs,
// i.e. four different places that happen to reuse a tilemap. A group whose
// members disagree on the song is reported as a NON-alias family and must stay
// out of the table.
//
// This fails three ways, and a fix that only satisfies one of them is not a fix:
//   * an alias in the table whose coordinates are not that id's ROM entrance
//   * a ROM family member that is a door destination from a shipped map and is
//     NOT in the table (the barred-exit bug)
//   * a STALE entry — an id in the table that the ROM says is its own room

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { loadMap, parseMapProperties } = await import('../src/map-loader.js');
const { ARRIVAL_ALIASES, SHIPPED_MAPS, canonicalMapId } = await import('../src/data/areas.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

let fails = 0;
const fail = (m) => { console.error('  ✗ ' + m); fails++; };
const ok = (m) => console.log('  ✓ ' + m);

const md5 = (buf) => crypto.createHash('md5').update(Buffer.from(buf)).digest('hex');

// ── 1. group every map by room identity ──────────────────────────────────────
const info = new Map();
const groups = new Map();
for (let id = 0; id < 256; id++) {
  let p, md;
  try { p = parseMapProperties(rom, id); md = loadMap(rom, id); } catch { continue; }
  const key = [md5(md.tilemap), md5(md.entranceData), p.npcIdx, p.tileset, p.fillTile].join('|');
  info.set(id, { key, x: p.entranceX, y: p.entranceY, song: p.songId });
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(id);
}

// ── 2. every entry in the table is a real, correctly-placed alias ────────────
for (const [alias, a] of ARRIVAL_ALIASES) {
  const mine = info.get(alias), theirs = info.get(a.map);
  if (!mine)   { fail(`alias ${alias}: no such map in the ROM`); continue; }
  if (!theirs) { fail(`alias ${alias} -> ${a.map}: canonical map does not exist`); continue; }
  if (mine.key !== theirs.key) {
    fail(`STALE: map ${alias} is NOT the same room as ${a.map} — the ROM gives them different ` +
         `tilemap/door-table/npcIdx/tileset/fill. Delete the entry or fix the canonical.`);
    continue;
  }
  if (mine.song !== theirs.song) {
    fail(`map ${alias} and ${a.map} share a tilemap but play different songs (${mine.song} vs ${theirs.song}) — ` +
         `that is two PLACES reusing art, not one room. Not an alias.`);
    continue;
  }
  if (a.x !== mine.x || a.y !== mine.y) {
    fail(`alias ${alias} -> ${a.map} lands at (${a.x},${a.y}); the ROM entrance for map ${alias} is ` +
         `(${mine.x},${mine.y}). The arrival tile is the cartridge's, not ours.`);
  }
  if (!SHIPPED_MAPS.has(a.map)) fail(`alias ${alias} -> ${a.map}, which is not in SHIPPED_MAPS`);
  if (ARRIVAL_ALIASES.has(a.map)) fail(`alias ${alias} -> ${a.map}, which is itself an alias — canonicals must be terminal`);
}
if (!fails) ok(`${ARRIVAL_ALIASES.size} alias(es) match the ROM's own arrival tiles`);

// ── 3. no family member a shipped door can reach is left out ─────────────────
//
// This is the half that catches the barred-exit bug. Walk every door on every
// shipped room (including the ones reached through an alias, since they share
// the door table) and demand that any destination sharing a room identity with
// a shipped map is either that map or a declared alias of it.
const before = fails;
for (const mapId of SHIPPED_MAPS) {
  const md = loadMap(rom, mapId);
  for (const dest of md.entranceData) {
    if (!dest) continue;
    const d = info.get(dest);
    if (!d) continue;
    const family = groups.get(d.key) || [];
    const shippedTwin = family.find(f => SHIPPED_MAPS.has(f));
    if (shippedTwin === undefined || shippedTwin === dest) continue;
    if (info.get(shippedTwin).song !== d.song) continue;   // different place, see above
    if (canonicalMapId(dest) === shippedTwin) continue;     // declared — good
    fail(`map ${mapId}'s door table points at map ${dest}, which is the SAME ROOM as shipped map ` +
         `${shippedTwin} entered at (${d.x},${d.y}) — but it is not in ARRIVAL_ALIASES, so the engine ` +
         `bars that door. This is exactly how Castle Sasune's throne room shipped with no way out.`);
  }
}
if (fails === before) ok('every alias a shipped door can reach is declared');

// ── 4. report the non-alias families, so the exclusion stays deliberate ──────
if (process.argv.includes('--list')) {
  for (const [, ids] of groups) {
    if (ids.length < 2) continue;
    const songs = new Set(ids.map(i => info.get(i).song));
    const mark = songs.size > 1 ? 'NOT aliases (songs differ)' : 'alias family';
    console.log(`      ${mark}: ${ids.map(i => `${i}@(${info.get(i).x},${info.get(i).y})`).join(' ')}` +
                (songs.size > 1 ? ` songs ${[...songs].join('/')}` : '') +
                (ids.some(i => SHIPPED_MAPS.has(i)) ? '  [touches a shipped map]' : ''));
  }
}

console.log(fails ? `\ncheck-arrival-aliases: ${fails} FAILURE(S)` : '\ncheck-arrival-aliases: OK');
process.exit(fails ? 1 : 0);
