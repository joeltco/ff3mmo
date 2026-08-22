#!/usr/bin/env node
// gen-encounters.mjs — rebuild `src/data/encounters.js` FROM THE ROM.
//
//   node tools/gen-encounters.mjs            # print
//   node tools/gen-encounters.mjs --write    # overwrite src/data/encounters.js
//
// Replaces `gen-encounters-js.js`, which decoded the 512 formations but had no
// way to say which map used which — so the zones underneath were hand-authored
// guesses. `tools/lib/ff3-map-encounters.mjs` carries the CPU trace that closed
// that gap; this walks it for every place the game can reach.
//
// The floor -> ROM map assignment lives in the dungeon registry
// (`romFloorMaps`), so adding a dungeon is still one row.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';
import { DUNGEONS, isBossFloor, romMapForFloor } from '../src/data/dungeons.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes');
const OUT = path.join(HERE, '..', 'src', 'data', 'encounters.js');
const rom = new Uint8Array(fs.readFileSync(ROMP));
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
  }
  return s.trim();
}
const mname = (id) => { try { return nesText(getMonsterName(id)) || `mon$${id.toString(16)}`; } catch { return `mon$${id.toString(16)}`; } };

/** A formation id -> the groups the battle expander would build. */
function formationGroups(f) {
  const [recIdx, countByte] = EN.setEntry(rom, f);
  const species = EN.speciesOf(rom, recIdx);
  const counts = EN.countsOf(rom, countByte & EN.COUNT_INDEX_MASK);
  const out = [];
  for (let g = 0; g < EN.SPECIES_SLOTS; g++) {
    const [min, max] = EN.countRange(counts[g]);
    if (max > 0 && species[g] !== EN.SPECIES_EMPTY) out.push({ id: species[g], min, max });
  }
  return out;
}

const hx = (v, n = 2) => '0x' + v.toString(16).padStart(n, '0');
const grpSrc = (gs) => '[' + gs.map((g) => `{ id: ${hx(g.id)}, min: ${g.min}, max: ${g.max} }`).join(', ') + ']';
const grpTxt = (gs) => gs.map((g) => `${mname(g.id)} x${g.min}-${g.max}`).join(' + ') || '(empty)';
/** ⭐ rate is a chance out of 256 PER STEP; say it in steps too. */
const steps = (rate) => (rate ? `~1 per ${(256 / rate).toFixed(0)} steps` : 'never');

/** One zone's source text, generated from a ROM map. */
function zoneFromMap(key, map, { rateOverride = null, note = null } = {}) {
  const group = ME.groupForMap(rom, map);
  const rate = rateOverride === null ? ME.rateForMap(rom, map) : rateOverride;
  return zoneFromGroup(key, group, rate, { rom: `{ map: ${map}, group: ${hx(group)} }`, note });
}

function zoneFromGroup(key, group, rate, { rom: romSrc, note } = {}) {
  const w = ME.weightedGroup(rom, group);
  const L = [];
  if (note) for (const line of note.split('\n')) L.push(`  // ${line}`);
  L.push(`  ['${key}', {`);
  L.push(`    rom: ${romSrc},`);
  L.push(`    rate: ${rate},   // out of 256 per step — ${steps(rate)}`);
  L.push('    formations: [');
  for (const { formation: f } of w) L.push(`      ${grpSrc(formationGroups(f))},   // ${hx(f)}  ${grpTxt(formationGroups(f))}`);
  L.push('    ],');
  L.push(`    weights: [${w.map((x) => x.weight).join(', ')}],   // out of 64`);
  L.push('  }],');
  return L.join('\n');
}

// ── the file ────────────────────────────────────────────────────────────────
const odds = ME.slotOdds(rom);
const worldRate = ME.world0FootRate(rom);
const out = [];

out.push(`// Encounter Catalog — GENERATED FROM THE FF3 ROM.
//
//   node tools/gen-encounters.mjs --write
//
// ⛔ DO NOT HAND-EDIT the generated zones. Every number below is pulled from the
// cartridge by \`tools/lib/ff3-map-encounters.mjs\`, which carries the CPU trace
// that decoded the chain:
//
//   map id ($48)  -> $92F0[map]            = the map's encounter GROUP
//   group         -> $94F0 + group*8       = EIGHT formation ids
//   slot          -> $BD78[random & 0x3F]  = ${odds.join('/')} out of 64
//   formation     -> $5C010                = species record + count pattern
//   rate          -> $BE00[map]            = chance out of 256, checked per step
//
// ⭐ THE ODDS ARE THE POINT. Before this, every formation in a zone was equally
// likely because the zones were authored by hand and nothing said otherwise. The
// cartridge gives each group eight weighted slots, so a group's last entry is a
// ${odds[7]}-in-64 rarity — Altar Cave B1F is Goblins ${64 - odds[7]} times out of 64 and Eye
// Fang + Carbuncle once, not the coin-flip we were shipping.
//
// ⛔ RATE IS A PER-STEP PROBABILITY OUT OF 256, not a step count. Dungeon floors
// are 6/256 (~1 per 43 steps) and world-0 grass is ${worldRate}/256 (~1 per ${(256 / worldRate).toFixed(0)}); the
// step-threshold model this replaced ran roughly twice as hot.

/** ROM $BD78: how many of the 64 random values land on each of a group's 8 slots. */
export const SLOT_ODDS = [${odds.join(', ')}];

/**
 * Does this step start a fight? The cartridge's own test, at bank 61 $BDBD:
 * \`JSR $C711 / CMP $F8 / BCS\` — random(0..255) < the map's rate.
 */
export function rollEncounter(zone, rnd = Math.random) {
  const rate = zone ? zone.rate | 0 : 0;
  return rate > 0 && Math.floor(rnd() * 256) < rate;
}

/**
 * Which world-0 zone a tile sits in.
 *
 * The cartridge's own arithmetic, bank 61 $BCE6 — the column is
 * \`(x+7) & $7F >> 5\` and the row is \`(y+7) & $60 >> 3\`, which already folds
 * in the *4. The +7 is the ROM's: it shifts the region boundaries half a
 * screen, so dropping it would silently mis-assign a 7-tile band along every
 * edge.
 */
export function world0ZoneKey(tileX, tileY) {
  const idx = (((tileX + 7) & 0x7F) >> 5) | (((tileY + 7) & 0x60) >> 3);
  return 'world_r' + idx;
}

/**
 * Pick one of a zone's formations using the ROM's weights.
 *
 * ⛔ SINGLE SOURCE — the client (\`battle-encounter.js\`) and the PvE arbiter
 * (\`pve-arbiter.js\`) both call this. A local copy in either would drift and the
 * arbiter's replay-validate would start rejecting honest battles.
 */
export function pickFormation(zone, rnd = Math.random) {
  const fs = zone && zone.formations;
  if (!fs || !fs.length) return [{ id: 0x00, min: 1, max: 3 }];
  const w = zone.weights;
  if (!w || w.length !== fs.length) return fs[Math.floor(rnd() * fs.length)];
  let total = 0;
  for (const x of w) total += x;
  let r = Math.floor(rnd() * total);
  for (let i = 0; i < fs.length; i++) { r -= w[i]; if (r < 0) return fs[i]; }
  return fs[fs.length - 1];
}

export const ENCOUNTERS = new Map([`);

// ── world 0 ─────────────────────────────────────────────────────────────────
out.push(`  // ── World map (FF3 world 0, 128x128) ──────────────────────────────────────
  //
  // The cartridge splits it into a 4x4 grid of 32-tile REGIONS (bank 61 $BCE6:
  // \`(x+7)&$7F >>5\` and \`(y+7)&$60 >>3\`), each with its own group. On foot the
  // rate is one constant, $9D47 = ${worldRate}/256.`);
for (let yr = 0; yr < 4; yr++) for (let xr = 0; xr < 4; xr++) {
  const idx = xr | (yr * 4);
  const g = rom[ME.WORLD0_GRID + idx];
  out.push(zoneFromGroup(`world_r${idx}`, g, worldRate, {
    rom: `{ world: 0, region: ${idx}, group: ${hx(g)} }`,
    note: `x ${xr * 32}-${xr * 32 + 31}, y ${yr * 32}-${yr * 32 + 31}`,
  }));
}

// ── the two hand-named world keys the game already routes to ────────────────
const UR_REGION = ME.world0Region(95, 41);
const UR_MAP = 114;   // the ROM map the Ur town overworld is loaded from
out.push(`  // ── The Ur starter zone — ⛔ THE ONE ZONE THAT IS NOT THE ROM'S ───────────
  //
  // A deliberate design decision (v1.7.945), kept: within 8 tiles of Ur the
  // world rolls Goblins instead of what the cartridge puts there. The
  // cartridge's own answer for Ur's region is \`world_r${UR_REGION}\` below — Killer Bees,
  // Werewolves and Berserkers, which an L1 party leaving town for the first
  // time does not survive. Everything OUTSIDE the radius is the ROM's.
  ['grasslands_valley', {
    rom: null,   // ⛔ ours, not the cartridge's
    rate: ${worldRate},   // out of 256 per step — ${steps(worldRate)}
    formations: [
      [{ id: 0x00, min: 1, max: 3 }],   // Goblin x1-3
    ],
    weights: [64],
  }],`);
// ⭐ The Ur dark-tile patch is a patch on ROM MAP 114, so it takes map 114's own
// row — NOT the world region Ur stands in. The cartridge gives that map a group
// of its own AND a rate of 18/256, more than three times the open grass, which
// is the "2x" the hand-authored version had guessed at.
out.push(zoneFromMap('grasslands_wild', UR_MAP, {
  note: `The Ur dark-tile encounter patch (src/map-loading.js). ⛔ NOT world_r${UR_REGION} —\nthat is the region Ur SITS IN; this is the town map's own table, and the\ntwo differ (no Berserker, and a much hotter rate).`,
}));

// ── dungeons ────────────────────────────────────────────────────────────────
for (const d of DUNGEONS) {
  // ⛔ A row with no `romFloorMaps` would simply produce no zones, and a floor
  // with no zone falls back to a lone Goblin — the exact silent failure the
  // registry exists to prevent. Refuse instead.
  if (!d.romFloorMaps) throw new Error(`dungeon '${d.id}' has no romFloorMaps — it would ship with no encounters`);
  out.push(`  // ── ${d.name} — ROM maps ${d.romFloorMaps.join(', ')} ──────────────────────────`);
  for (let f = 0; f < d.floors; f++) {
    const map = romMapForFloor(d, f);
    const key = `${d.encounterZonePrefix}_f${f + 1}`;
    if (isBossFloor(d, f)) {
      out.push(zoneFromMap(key, map, {
        rateOverride: 0,
        note: `Floor ${f + 1} is the BOSS CHAMBER. The cartridge gives map ${map} a rate of\n${ME.rateForMap(rom, map)}/256, but our chamber is a single room with a scripted fight, so\nthe rate is forced to 0 here. The group is kept so the formations it\nwould have rolled stay visible.`,
      }));
    } else {
      out.push(zoneFromMap(key, map));
    }
  }
  out.push(`  ['${d.encounterZonePrefix}_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: ${hx(d.bossId)}, min: 1, max: 1 }],
    ],
    weights: [64],
  }],`);
}

out.push(']);');
out.push('');

const text = out.join('\n');
if (process.argv.includes('--write')) { fs.writeFileSync(OUT, text); console.log(`wrote ${OUT} (${text.length} bytes)`); }
else console.log(text);
