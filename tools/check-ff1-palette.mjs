#!/usr/bin/env node
// check-ff1-palette.mjs — FF1's battle palette table stays decoded.
//
// Formation bytes 10 and 11 are the two BG palette indices for a battle, and both
// index one 4-byte-per-entry table at ROM 0x30F30. Three things can silently
// break the decode:
//
//   ⛔ moving BATTLE_PAL_TABLE — the colours the game paints stop matching the
//      table, and every derived palette is quietly wrong;
//   ⛔ folding bytes 10/11 back into FORMATION_UNKNOWN_OFF, which would put them
//      back on the "safe to overwrite" list;
//   ⛔ assuming the SPECIES picks the colours. It does not — that assumption is
//      what makes an FF1 formation draw in corrupted colours.
//
//   node tools/check-ff1-palette.mjs
//   node tools/check-ff1-palette.mjs --live       # re-fight two real battles
//   node tools/check-ff1-palette.mjs --prove-revert
//
// ⛔ Fast by default — pure ROM + pinned PPU measurements, no emulator.
//
// ⭐ THE EXPECTATIONS ARE MEASUREMENTS, NOT DERIVATIONS. `MEASURED` below was read
// off PPU $3F05-07 on a running battle, one index at a time, by
// `tools/ff1-palette-table.mjs`. It is never computed from the constant under
// test, so moving that constant makes these checks fail. `--prove-revert` runs
// exactly that experiment and fails if the gate would have survived it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MN from './lib/ff1-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

/** ⭐ Read off the PPU during 16 real battles, one per index. Evidence, not math. */
const MEASURED = [
  [0x36, 0x27, 0x16], [0x36, 0x22, 0x13], [0x25, 0x29, 0x1B], [0x23, 0x26, 0x16],
  [0x24, 0x30, 0x22], [0x26, 0x2B, 0x19], [0x3A, 0x16, 0x1B], [0x30, 0x31, 0x22],
  [0x37, 0x26, 0x16], [0x30, 0x2B, 0x1C], [0x36, 0x21, 0x12], [0x30, 0x28, 0x19],
  [0x30, 0x23, 0x1B], [0x37, 0x25, 0x16], [0x38, 0x26, 0x14], [0x23, 0x29, 0x19],
];

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
};

/** Every assertion that depends on the table's location, run against `base`. */
function tableChecks(base, assert) {
  const pal = (i) => [...rom.slice(base + i * MN.BATTLE_PAL_STRIDE,
                                   base + i * MN.BATTLE_PAL_STRIDE + MN.BATTLE_PAL_STRIDE)];
  const colourMatch = MEASURED.every((m, i) => {
    const e = pal(i);
    return e[1] === m[0] && e[2] === m[1] && e[3] === m[2];
  });
  const backdrop = Array.from({ length: 64 }, (_, i) => pal(i)[0])
    .every(b => b === MN.BATTLE_PAL_BACKDROP);
  // the reader's operand must be the table's own CPU address
  const w = (base - 16) % 0x4000;
  const op = rom[MN.BATTLE_PAL_READER_FILE];
  const operand = rom[MN.BATTLE_PAL_READER_FILE + 1] | (rom[MN.BATTLE_PAL_READER_FILE + 2] << 8);
  const reader = op === 0xBD && operand === (0x8000 + w);
  if (assert) {
    ok('the 16 PPU-measured palettes are exactly the ROM table entries', colourMatch);
    ok('every entry starts with the NES backdrop 0x0F', backdrop,
       `first 64 entries, byte 0 = 0x${hx(MN.BATTLE_PAL_BACKDROP)}`);
    ok('the reader is still LDA abs,X pointing at the table', reader,
       `$${hx(operand, 4)} at file 0x${hx(MN.BATTLE_PAL_READER_FILE, 5)}`);
  }
  return colourMatch && backdrop && reader;
}

console.log('FF1 battle palette — formation bytes 10/11 and the table they index\n');
console.log(`  table @ ROM 0x${hx(MN.BATTLE_PAL_TABLE, 5)}, stride ${MN.BATTLE_PAL_STRIDE}, ` +
            `reader $${hx(MN.BATTLE_PAL_READER_PC, 4)}\n`);

tableChecks(MN.BATTLE_PAL_TABLE, true);

// how far the table actually runs, reported rather than assumed
let entries = 0;
while (rom[MN.BATTLE_PAL_TABLE + entries * MN.BATTLE_PAL_STRIDE] === MN.BATTLE_PAL_BACKDROP) entries++;
ok('the table runs for at least 64 entries', entries >= 64, `${entries} consecutive entries`);

// ── the field wiring ────────────────────────────────────────────────────────
ok('bytes 10 and 11 are the palette fields',
   JSON.stringify(MN.FORMATION_PAL_OFF) === JSON.stringify([10, 11]));
ok('...and are NOT back on the unknown list',
   !MN.FORMATION_PAL_OFF.some(o => MN.FORMATION_UNKNOWN_OFF.includes(o)),
   `unknown = ${MN.FORMATION_UNKNOWN_OFF.join(',')}`);
ok('they do not collide with the species or count fields',
   !MN.FORMATION_PAL_OFF.some(o => MN.FORMATION_SPECIES_OFF.includes(o) || MN.FORMATION_COUNT_OFF.includes(o)));
ok('the two palette bytes drive BG palette 1 and BG palette 2',
   JSON.stringify(MN.FORMATION_PAL_PPU) === JSON.stringify([0x3F05, 0x3F09]));
ok('battlePalette() returns 4 colours', MN.battlePalette(rom, 0).length === 4,
   MN.battlePalette(rom, 0).map(v => hx(v)).join(' '));
// ⛔ Bytes 1 and 12 also move the palette and are NOT palette fields — 1 is the
// size/layout class, 12 is the ambush bit (an extra ROUND moves those slots).
// ⛔ This check used to be `every(...)` over that list; now the list is empty and
// `every` on an empty array is TRUE, so it passed vacuously. Assert the real
// thing instead: those two are identified, and nothing unknown still moves it.
ok('the other palette-moving bytes are identified, not parked as unknown',
   MN.FORMATION_MOVES_PALETTE_UNIDENTIFIED.length === 0
   && !MN.FORMATION_UNKNOWN_OFF.includes(MN.FORMATION_GFX_OFF)
   && !MN.FORMATION_UNKNOWN_OFF.includes(MN.FORMATION_AMBUSH_OFF),
   `byte ${MN.FORMATION_GFX_OFF} = size/layout, byte ${MN.FORMATION_AMBUSH_OFF} = ambush`);

// ── ⭐ the revert proof ─────────────────────────────────────────────────────
if (args.includes('--prove-revert')) {
  console.log('\n  revert proof — the same checks against a deliberately wrong base:');
  let survived = 0;
  for (const delta of [-4, 4, 16]) {
    const still = tableChecks(MN.BATTLE_PAL_TABLE + delta, false);
    console.log(`     base ${delta > 0 ? '+' : ''}${delta}: ${still ? '⛔ STILL PASSES' : 'fails, as it must'}`);
    if (still) survived++;
  }
  ok('a moved table base breaks the gate', survived === 0);
}

// ── optional: re-fight for real ─────────────────────────────────────────────
if (args.includes('--live')) {
  const { execFileSync } = await import('node:child_process');
  console.log('\n  --live: re-measuring two indices on a real battle...');
  const out = execFileSync('node', [path.join(HERE, 'ff1-palette-table.mjs'), '--n', '4'],
                           { encoding: 'utf8' });
  ok('the live probe still lands on the same table',
     out.includes(`0x${hx(MN.BATTLE_PAL_TABLE, 5)}`), out.trim().split('\n').pop());
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
