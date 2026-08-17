#!/usr/bin/env node
// ff1-palette-table.mjs — find the ROM table that FF1 formation bytes 10/11 index.
//
// WHY
// `ff1-formation-palette.mjs` showed that formation bytes 10 and 11 each drive one
// BG palette in battle ($3F05-07 and $3F09-0B) while the SPECIES does not — which
// is why a formation could ship with "corrupted colors" (TCRF): the colors travel
// with the formation, not with the monster. If those bytes are INDICES, there is a
// 3-colour table in the ROM they point into. This finds it, the same way FF3's
// PALETTE_TABLE was found.
//
//   node tools/ff1-palette-table.mjs --state tools/states/ff1-world.state.gz
//   node tools/ff1-palette-table.mjs --n 24
//
// HOW IT IS KEPT HONEST
//   ⭐ The colours are READ OFF THE PPU for each index, then the ROM is searched
//      for a table that reproduces ALL of them. One index agreeing is meaningless
//      (index 1 matching entry 1 happens by accident); the match must hold across
//      every index measured, and the report says how many that was.
//   ⭐ Byte 11 must land on the SAME table as byte 10. Two independent fields
//      agreeing on one base is the check that a coincidence cannot pass.
//   ⛔ Indices whose battle never started are dropped, never treated as a colour.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', 'tools/states/ff1-world.state.gz');
const N = Number(flag('n', '16'));
const FORMATION = Number(flag('formation', '0'));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync(STATE);
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const REC = MN.FORMATION_TABLE + FORMATION * MN.FORMATION_STRIDE;

/** Byte 10 paints BG palette 1, byte 11 paints BG palette 2. */
export const PAL_BYTE_SLOTS = { 10: 0x3F05, 11: 0x3F09 };

function fight(off, val) {
  const p = Uint8Array.from(rom);
  p[REC + off] = val & 0xFF;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(20);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  const hasRun = () => {
    const v = nes.ppu.vramMem;
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      if (/\bRUN\b/.test(s)) return true;
    }
    return false;
  };
  for (let step = 0; step < 300; step++) {
    const b = D[Math.floor(step / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (hasRun()) {
      run(30);
      const at = PAL_BYTE_SLOTS[off];
      return [...nes.ppu.vramMem.slice(at, at + 3)];
    }
  }
  return null;
}

console.log(`FF1 — the palette table behind formation bytes 10 and 11\n`);
const measured = {};
for (const off of [10, 11]) {
  const rows = [];
  for (let v = 0; v < N; v++) {
    const c = fight(off, v);
    rows.push(c);
    process.stdout.write(`\r  measuring byte ${off}: ${v + 1}/${N}   `);
  }
  measured[off] = rows;
  const got = rows.filter(Boolean).length;
  console.log(`\r  byte ${off}: ${got}/${N} indices produced a battle`);
  for (let v = 0; v < N; v++)
    if (rows[v]) console.log(`     ${hx(v)} -> ${rows[v].map(c => hx(c)).join(' ')}`);
    else console.log(`     ${hx(v)} -> NO BATTLE (dropped)`);
}

// ── search the ROM for a table that reproduces EVERY measured index ──────────
console.log('\n  searching the ROM for a table that reproduces all of them...');
function findTable(rows, stride) {
  const idx = [...rows.keys()].filter(v => rows[v]);
  if (idx.length < 4) return [];
  const hits = [];
  const maxV = Math.max(...idx);
  for (let base = 16; base < rom.length - (maxV + 1) * stride; base++) {
    let ok = true;
    for (const v of idx) {
      const at = base + v * stride;
      if (rom[at] !== rows[v][0] || rom[at + 1] !== rows[v][1] || rom[at + 2] !== rows[v][2]) { ok = false; break; }
    }
    if (ok) hits.push(base);
  }
  return hits;
}

const found = {};
for (const stride of [3, 4]) {
  for (const off of [10, 11]) {
    const hits = findTable(measured[off], stride);
    if (hits.length) {
      found[`${off}/${stride}`] = hits;
      console.log(`   byte ${off}, stride ${stride}: ${hits.length} match(es) -> ` +
                  hits.slice(0, 4).map(h => `0x${hx(h, 5)}`).join(' '));
    }
  }
}

if (!Object.keys(found).length) {
  console.log('\n⛔ no 3- or 4-byte-stride table in the ROM reproduces the measured colours.');
  console.log('   So bytes 10/11 are NOT a plain index into a colour table — they select');
  console.log('   the palette some other way. The colours above are still measured fact.');
  process.exit(1);
}

// ⭐ the check a coincidence cannot pass: both fields on ONE base.
for (const stride of [3, 4]) {
  const a = found[`10/${stride}`] || [], b = found[`11/${stride}`] || [];
  const shared = a.filter(x => b.includes(x));
  if (shared.length) {
    console.log(`\n⭐ bytes 10 AND 11 index the SAME table at 0x${hx(shared[0], 5)} (stride ${stride})`);
    const bank = ((shared[0] - 16) / 0x4000) | 0, w = (shared[0] - 16) % 0x4000;
    console.log(`   bank ${bank}, CPU $${hx(0x8000 + w, 4)} (or $${hx(0xC000 + w, 4)} if fixed-high)`);
    console.log(`   ${measured[10].filter(Boolean).length} + ${measured[11].filter(Boolean).length} measured indices agree`);
    process.exit(0);
  }
}
console.log('\n⛔ bytes 10 and 11 matched tables, but NOT the same one — that is weaker than');
console.log('   it looks and may be coincidence. Re-run with a larger --n before believing it.');
process.exit(1);
