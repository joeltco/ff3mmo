#!/usr/bin/env node
// ff1-monster-verify.mjs — make each FF1 monster appear, and read its name.
//
// WHY
// The name table was decoded and pinned to the instruction that reads it, but
// only index 0 (`IMP`) was ever witnessed, because a chosen monster could not be
// made to appear. This makes any of them appear.
//
// THE CHAIN, each hop measured by tracing a real encounter (writes first, then
// disassembly at the writing PC):
//
//   $CDC3  LDA $45 / BPL +           ; prop1 bit 7 = a dungeon encounter tile
//   $CDCE  LDA $48 / ADC #$40 / JSR $C54A
//   $C54A  ...($11:$10) = $8000 + (map+$40)*8, bank 11
//   $C56B  LDA ($10),Y / STA $6A     ; one of eight GROUP ids, weighted
//   $F2A3  ASL A / ROL $9B (x4) / ADC #$84
//   $F2BC  LDA ($9A),Y / STA $6D84,Y ; 16 bytes: $8400 + idx*16, bank 11
//   $A254  LDY $92 / LDA $6D84,Y / STA $6BB7,X
//   $BBB9  LDA $6BB7,X / STA $6BC9,Y ; the battle's monster slots
//   $FBD4  LDA $6BC9,X                ; ...which the name printer reads
//
// ⭐ BYTE 2 of the 16-byte formation record is the monster id. Found by patching
// each of the 16 bytes in turn to a distinctive id and seeing which one changed
// the name on the battle screen — byte 2 drew TIGER, the rest stayed IMP.
//
//   node tools/ff1-monster-verify.mjs --state world.state
//   node tools/ff1-monster-verify.mjs --state world.state --from 0 --to 31
//
// ⛔ The ROM on disk is never touched — the patch goes into the in-memory copy.
// ⛔ Earlier attempts poked RAM ($6BC9, $6BE4) and failed: the game rewrites
// those during setup, and $6BE4 is not the id's home at all. Patch the ROM.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const FROM = Number(flag('from', '0'));
const TO = Number(flag('to', '127'));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const rom = new Uint8Array(fs.readFileSync(ROMP));
if (!STATE) { console.error('--state is required (an FF1 overworld savestate)'); process.exit(1); }
const SNAP = fs.readFileSync(STATE, 'utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];

/** Force formation 0 to hold `id`, walk into an encounter, read the screen. */
function fight(id) {
  const p = Uint8Array.from(rom);
  p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = id;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(20);
  // ⛔ the start pocket has no walkable route out; $27/$28 ARE pokeable on the
  // overworld, unlike $68/$69 everywhere else.
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) {
        const g = F1.glyph(v[0x2000 + r * 32 + c]);
        s += (g === null || g === '\n') ? ' ' : g;
      }
      if (s.trim()) out.push(s.trim());
    }
    return out;
  };
  for (let step = 0; step < 300; step++) {
    const b = D[Math.floor(step / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) return lines();
  }
  return null;
}

console.log('FF1 monster names — each one made to appear in a real battle\n');
let bad = 0, seen = 0, noFight = 0;
for (let id = FROM; id <= TO; id++) {
  const want = MN.monsterName(rom, id, F1.glyph);
  if (!want) continue;
  seen++;
  const scr = fight(id);
  if (!scr) { bad++; noFight++; console.log(`  NO BATTLE id ${String(id).padStart(3)} (${want})`); continue; }
  const flat = scr.join(' ').replace(/\s/g, '');
  if (!flat.includes(want.replace(/\s/g, ''))) {
    bad++;
    console.log(`  MISMATCH id ${String(id).padStart(3)}: expected "${want}", screen had ` +
                scr.filter(l => /[A-Za-z]{3,}/.test(l)).join(' | ').replace(/AAAA|HP/g, '').slice(0, 60));
  }
}
console.log(`\n${seen - bad}/${seen} monster names drew on a real battle screen` +
            (noFight ? ` (${noFight} never reached a battle)` : ''));
process.exit(bad ? 1 : 0);
