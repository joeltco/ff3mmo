// build-capture-rom.cjs — build a ROM that can actually be captured from.
//
// Two patches, both lifted verbatim from spell-sweep.cjs so the capture
// conditions match the sweep exactly:
//
//   1. UNKILLABLE, HARMLESS GOBLIN — 32767 HP, attack set 0, no status resist,
//      every spell forced to 100% hit, and every goblin encounter reduced to a
//      single one. Without it a strong spell KILLS the target and the trace
//      fills with the death cue and the victory fanfare, which is exactly the
//      confound that makes a death sound look like a spell's impact.
//
//   2. SPELL UNLOCK (--unlock <id>) — byte 7 of a spell's 8-byte record is its
//      castability/level gate: level-8 spells carry 0x3d, level-7/6 carry 0x2e,
//      level-1 carries 0x2f. Black Mage caps at magic level 7, so a level-8
//      spell can never be cast headlessly and the sweep's cursor DRIFTS onto the
//      level-7 spell in the same column — which is how Meteo (0x02) came to be
//      recorded with Drain's (0x09) sound. Rewriting that one byte to 0x2f
//      leaves the spell at its own id, in its own menu slot, with its own
//      animation and its own sound lookup, and simply lets it be cast.
//
//   node tools/monscan/build-capture-rom.cjs out.nes --unlock 0x02
//   node tools/monscan/build-capture-rom.cjs out.nes            # goblin patch only
//
// NEVER writes over FF3-English.nes.

const { readFileSync, writeFileSync } = require('fs');

const BASE_ROM = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const MONSTER_PROPS = 0x060010;
const SPELL_DATA = 0x0618D0;
const CASTABLE_BYTE7 = 0x2f;   // the value level-1 spells carry

const args = process.argv.slice(2);
const out = args[0];
if (!out) { console.error('usage: build-capture-rom.cjs <out.nes> [--unlock <spellId>]...'); process.exit(2); }
const unlocks = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--unlock') unlocks.push(parseInt(args[++i], 16 | 0) || Number(args[i]));
}

const rom = readFileSync(BASE_ROM);
const p = Buffer.from(rom);

// ── 1. one goblin, unkillable and harmless ───────────────────────────────
const gob = [];
for (let e = 0; e < 256; e++) {
  const m = rom[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
  const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter(v => v !== 0xFF);
  if (ids.length && ids.every(v => v === 0x00)) gob.push(e);
}
let list = null;
for (let m = 0; m < 256 && list === null; m++) {
  const o = ENCOUNTER_MON + m * 6;
  for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === 0x00) { list = m; break; }
}
const mo = ENCOUNTER_MON + list * 6;
p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
const props = MONSTER_PROPS + 0x00 * 16;
p[props + 1] = 0xFF; p[props + 2] = 0x7F;        // 32767 HP
p[props + 9] = p[props + 9] & 0xC0;              // harmless attack set
p[props + 13] = 0x00;                            // no status resistance
for (let sp = 0; sp < 88; sp++) p[SPELL_DATA + sp * 8 + 1] = 100;   // 100% hit
p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
console.log('goblin patch: unkillable (32767 HP), harmless, 100% hit, single-target');

// ── 2. spell unlocks ─────────────────────────────────────────────────────
for (const id of unlocks) {
  const off = SPELL_DATA + id * 8 + 7;
  const before = p[off];
  p[off] = CASTABLE_BYTE7;
  console.log(`unlocked spell 0x${id.toString(16).padStart(2, '0')}: byte7 0x${before.toString(16)} -> 0x${CASTABLE_BYTE7.toString(16)}`);
}

writeFileSync(out, p);
console.log('wrote ' + out);
