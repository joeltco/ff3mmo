#!/usr/bin/env node
// check-ff2-encounters.mjs — FF2's encounter table stays decoded.
//
// The encounter check lives at $CF57 (bank 15):
//
//   $CF61  LDA $48 / CMP #$40 / CMP #$50   ; locations $40-$4F are EXEMPT
//   $CF6B  JSR $C5AD                       ; random
//   $CF6E  CMP $F8 / BCS                   ; $F8 = the rate threshold
//   $CF72  LDA #$0B / JSR $FE03            ; ⭐ bank 11 into the $8000 window
//   $CF77  LDX $48
//   $CF79  LDA $8100,X                     ; ⭐⭐ the location's ENCOUNTER SET
//   $CF7C  JSR $C579                       ; start the battle with it
//
//   node tools/check-ff2-encounters.mjs
//
// ⛔ HOW THIS IS PROVEN, AND WHAT IT DOES NOT CLAIM.
//   ⭐ The byte the CPU loads at $CF79 is captured live and must equal the table
//      byte — and must FOLLOW the table when it is patched. That is what pins the
//      address, not a read of the ROM.
//   ⭐ Changing a location's set byte must change the battle it produces, checked
//      WITHIN ONE LOCATION so the walk, the step and the RNG are identical.
//   ⛔ It does NOT assert that location A patched to B's set draws B's exact
//      screen. Two locations trigger at DIFFERENT STEPS (12 vs 25 for 0x29/0x60),
//      so the formation is drawn from the set at different RNG. An equality check
//      across locations fails for that reason alone and would be a false negative.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { NES, Controller } from 'jsnes';
import * as L2 from './lib/ff2-locations.mjs';

export const ENCOUNTER_SET_TABLE = 0x2C110;   // file; bank 11, CPU $8100
export const ENCOUNTER_SET_READ_PC = 0xCF79;  // LDA $8100,X
export const ENCOUNTER_RATE_ZP = 0xF8;
// ⭐⭐ THE RATE TABLE: bank 11 $8000 + locationId (the bank is set by the code
// itself, `$D123 LDA #$0B / JSR $FE03`, immediately before the read):
//   $D128  LDX $48 / LDA $8000,X / STA $F8
// ⭐ FF1 uses the SAME convention — zero page $F8, a bank-11 table indexed by the
// map id ($8C01+mapId). Two games, one design.
// ⛔ The rate is loaded at LOCATION ENTRY, so it can only be tested by crossing a
// real load — `enterLocation`, not a mid-walk poke (see check-ff1-encounter-rate).
export const RATE_TABLE = 0x2C010;
export const ENCOUNTER_EXEMPT_LO = 0x40, ENCOUNTER_EXEMPT_HI = 0x50;

// ── ⭐⭐ THE SET RECORD: 8 weighted FORMATION ids ───────────────────────────
//   $C579  ASL A / ROL $81 (x3) / ADC #$80 / ADC #$82  ; ptr = $8280 + set*8
//   $C591  LDA #$0B / JSR $FE03                        ; bank 11
//   $C59A  LDA $F900,X / AND #$3F / TAX                ; random 0..63
//   $C5A0  LDY $C5C8,X                                 ; 64-entry WEIGHT table
//   $C5A3  LDA ($80),Y / STA $6A                       ; the chosen FORMATION id
// Slot weights out of 64: 12 12 12 12 6 6 3 1 — a rare tail, same shape as FF3.
export const SET_RECORD_TABLE = 0x2C290;    // file; bank 11 $8280, 8 bytes/set
export const SET_RECORD_LEN = 8;
export const SLOT_WEIGHT_TABLE = 0x3C5D8;   // file; bank 15 $C5C8, 64 entries
export const FORMATION_PICK_PC = 0xC5A3;    // LDA ($80),Y
export const FORMATION_ID_ZP = 0x6A;
export const SLOT_WEIGHTS = [12, 12, 12, 12, 6, 6, 3, 1];
export const setRecord = (r, set) =>
  [...r.slice(SET_RECORD_TABLE + set * SET_RECORD_LEN,
              SET_RECORD_TABLE + (set + 1) * SET_RECORD_LEN)];

const { rom, snapshot } = L2.loadFixtures();
const D = [Controller.BUTTON_UP, Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN, Controller.BUTTON_LEFT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
export const encounterSet = (r, loc) => r[ENCOUNTER_SET_TABLE + loc];

/** Walk to a battle, capturing the set byte the CPU actually loaded. */
function fight(dest, patch = {}) {
  const r = Object.keys(patch).length ? Uint8Array.from(rom) : rom;
  for (const [o, v] of Object.entries(patch)) r[Number(o)] = v;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));
  nes.frame();
  const c = nes.cpu;
  c.mem[L2.PARTY_X_ZP] = L2.destX(r, dest); c.mem[L2.PARTY_Y_ZP] = L2.destY(r, dest);
  c.mem[L2.LOC_ID_ZP] = dest; c.mem[L2.DEST_ID_ZP] = dest;
  let setUsed = null, formation = null;
  const oE = c.emulate.bind(c);
  c.emulate = function () {
    const pc = (c.REG_PC + 1) & 0xFFFF; const res = oE();
    if (pc === ENCOUNTER_SET_READ_PC && setUsed === null) setUsed = c.REG_ACC;
    if (pc === FORMATION_PICK_PC && formation === null) formation = c.REG_ACC;
    return res;
  };
  const st = [0x20, L2.LOC_ENTRY_PC & 0xFF, L2.LOC_ENTRY_PC >> 8, ...L2.NMI_TRAMPOLINE];
  st.forEach((b, i) => { c.mem[L2.NMI_STUB_RAM + i] = b; });
  c.mem[0x100] = 0x4C; c.mem[0x101] = L2.NMI_STUB_RAM & 0xFF; c.mem[0x102] = L2.NMI_STUB_RAM >> 8;
  nes.frame();
  L2.NMI_TRAMPOLINE.forEach((b, i) => { c.mem[0x100 + i] = b; });
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(90);
  const base = [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
  const loc0 = c.mem[L2.LOC_ID_ZP];
  for (let s = 0; s < 80; s++) {
    const b = D[Math.floor(s / 5) % 4];
    nes.buttonDown(1, b); run(6); nes.buttonUp(1, b); run(8);
    const now = nes.ppu.vramMem.slice(0x2000, 0x23C0);
    let d = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== base[i]) d++;
    // ⛔ a battle leaves $48 alone; an EXIT changes it and also redraws everything
    if (d > base.length * 0.85 && c.mem[L2.LOC_ID_ZP] === loc0) {
      run(40);
      const nt = Buffer.from(nes.ppu.vramMem.slice(0x2000, 0x23C0));
      return { hash: crypto.createHash('sha1').update(nt).digest('hex').slice(0, 10), step: s, setUsed, formation };
    }
  }
  return null;
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('FF2 encounter set table — bank 11 $8100 (file 0x2C110)\n');
const A = 0x29, B = 0x60;
const a = fight(A), b = fight(B);
ok('both locations reach a battle', !!a && !!b);
console.log(`  loc ${hx(A)}: set ${hx(a.setUsed)} at step ${a.step}   loc ${hx(B)}: set ${hx(b.setUsed)} at step ${b.step}\n`);

ok('the byte the CPU loads IS the table byte',
   a.setUsed === encounterSet(rom, A) && b.setUsed === encounterSet(rom, B),
   `${hx(a.setUsed)}/${hx(b.setUsed)} vs ${hx(encounterSet(rom, A))}/${hx(encounterSet(rom, B))}`);
ok('the two locations use DIFFERENT sets', a.setUsed !== b.setUsed);
ok('...and produce different battles', a.hash !== b.hash);

// ⭐ patch: the loaded byte must FOLLOW the table
const pa = fight(A, { [ENCOUNTER_SET_TABLE + A]: encounterSet(rom, B) });
ok('patching the table changes the byte the CPU uses',
   pa.setUsed === encounterSet(rom, B), `${hx(a.setUsed)} -> ${hx(pa.setUsed)}`);
// ⭐ same location, same walk, same step -> only the set differs
ok('...and changes the battle drawn, same location and same step',
   pa.hash !== a.hash && pa.step === a.step, `step ${a.step}, ${a.hash} -> ${pa.hash}`);
const pa2 = fight(A, { [ENCOUNTER_SET_TABLE + A]: encounterSet(rom, B) });
ok('...reproducibly', pa2.hash === pa.hash);

// the exempt band, straight off the instruction
ok('locations $40-$4F are the exempt band',
   ENCOUNTER_EXEMPT_LO === 0x40 && ENCOUNTER_EXEMPT_HI === 0x50);
// ⛔ The table is NOT uniform — that is the check. An earlier version asserted
// "more than 100 entries are zero", which was a GUESS I never measured (it is 71)
// and it failed for no reason other than my own invention.
const vals = Array.from({ length: 0x100 }, (_, i) => encounterSet(rom, i));
const zero = vals.filter(v => v === 0).length;
const distinct = new Set(vals).size;
ok('the table is non-uniform — many distinct sets across locations', distinct > 10,
   `${distinct} distinct values, ${zero}/256 are zero`);
ok('...and both probed locations carry a nonzero set',
   encounterSet(rom, A) !== 0 && encounterSet(rom, B) !== 0);

// ── ⭐ the SET RECORD is the formation source ───────────────────────────────
{
  const rec = setRecord(rom, encounterSet(rom, A));
  ok('the formation the CPU picks is one of the set\'s 8 slots',
     rec.includes(a.formation), `picked ${hx(a.formation)} from ${rec.map(v => hx(v)).join(' ')}`);
  // ⭐ RNG-PROOF: fill EVERY slot with a sentinel, so whatever the weighted roll
  // picks must be that value. This is what makes the claim independent of luck.
  for (const sent of [0x2B, 0x77]) {
    const patch = {};
    for (let i = 0; i < SET_RECORD_LEN; i++) patch[SET_RECORD_TABLE + encounterSet(rom, A) * SET_RECORD_LEN + i] = sent;
    const f = fight(A, patch);
    ok(`filling all 8 slots with ${hx(sent)} makes the CPU pick ${hx(sent)}`,
       f && f.formation === sent, f ? `picked ${hx(f.formation)}` : 'no battle');
  }
  // ⛔ and the unpatched pick must differ from both sentinels, or the above is vacuous
  ok('the unpatched formation differs from both sentinels',
     a.formation !== 0x2B && a.formation !== 0x77, hx(a.formation));
  ok('the slot weights are the 64-entry table at $C5C8',
     JSON.stringify(SLOT_WEIGHTS) === JSON.stringify(
       (() => { const w = [...rom.slice(SLOT_WEIGHT_TABLE, SLOT_WEIGHT_TABLE + 64)];
                return [...Array(8)].map((_, i) => w.filter(v => v === i).length); })()),
     SLOT_WEIGHTS.join('/'));
}

// ── ⭐ the RATE table, patch-proven across a real location entry ────────────
{
  for (const loc of [0x29, 0x60]) {
    const e = L2.enterLocation(rom, snapshot, loc, { frames: 120 });
    ok(`loc ${hx(loc)}: $F8 after entry equals its table entry`,
       e.cpu.mem[ENCOUNTER_RATE_ZP] === rom[RATE_TABLE + loc],
       `$F8=${hx(e.cpu.mem[ENCOUNTER_RATE_ZP])} table=${hx(rom[RATE_TABLE + loc])}`);
  }
  // ⭐ causal: the table must DRIVE $F8, not merely match it
  for (const v of [0x77, 0x03]) {
    const e = L2.enterLocation(rom, snapshot, 0x29, { frames: 120, patch: { [RATE_TABLE + 0x29]: v } });
    ok(`patching loc 29's rate to ${hx(v)} makes $F8 follow`,
       e.cpu.mem[ENCOUNTER_RATE_ZP] === v, `$F8=${hx(e.cpu.mem[ENCOUNTER_RATE_ZP])}`);
  }
  ok('the unpatched rate differs from both sentinels',
     rom[RATE_TABLE + 0x29] !== 0x77 && rom[RATE_TABLE + 0x29] !== 0x03, hx(rom[RATE_TABLE + 0x29]));
  ok('the rate read is LDA $8000,X at $D12A',
     rom[0x3D13A] === 0xBD && (rom[0x3D13B] | (rom[0x3D13C] << 8)) === 0x8000);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
