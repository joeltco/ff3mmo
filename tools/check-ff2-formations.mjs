#!/usr/bin/env node
// check-ff2-formations.mjs — FF2's formation record (the monsters) stays decoded.
//
// The last hop of the encounter chain. A formation id is turned into a record
// pointer in zero page $0E/$0F, and bank 11 copies the record out:
//
//   $98CA  STA $7B52,Y     ; the COUNTS
//   $98CD  LDA ($0E),Y
//   $98CF  STA $7B4E,Y     ; ⭐ the MONSTER IDS
//
// For formation 0x2B the pointer reads $8B3C in bank 11 = file 0x2CB4C, and the
// record's first two bytes are the monster ids.
//
//   node tools/check-ff2-formations.mjs
//
// ⛔ HOW THIS IS PROVEN — and why nothing weaker counts. Seven earlier candidates
// for this table were found by static search or by trace adjacency and ALL were
// wrong; one of them ($9BB7) held 0x00 while the value written was 0x6A. So:
//   ⭐ the record pointer is READ LIVE off $0E/$0F at the moment of the write,
//      never computed from an assumed table shape;
//   ⭐ the bank is CONFIRMED by matching live bytes against the ROM — a CPU
//      address is not an identity until you know what is mapped there;
//   ⭐ and each id byte is PATCHED INDEPENDENTLY and must move that exact slot.
// ⭐ The DERIVATION is now proven too (v1.9.4): ptr = $8AA0 + v*4 where v is byte 5
// of the record at ($0A). Patching that byte moves the pointer to the PREDICTED
// address and changes the monsters. ⛔ It is COMPUTED, not looked up — which is
// why a stride-2 pointer-table search returned 0 candidates and the records are
// not sequential. Don't go looking for a pointer table; there isn't one.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import * as L2 from './lib/ff2-locations.mjs';

export const FORMATION_REC_2B = 0x2CB4C;     // file; bank 11 $8B3C, read live
export const FORMATION_REC_BANK = 11;
export const FORMATION_ID_OFF = [0, 1];      // the two monster-id bytes
export const IDS_RAM = 0x7B4E, COUNTS_RAM = 0x7B52;
export const IDS_WRITE_PC = 0x98CF, COUNTS_WRITE_PC = 0x98CA;
export const REC_PTR_ZP = 0x0E;

// ── ⭐⭐ HOW THE RECORD POINTER IS DERIVED (bank 11 $98A1-$98BE) ────────────
//   $98AD  LDA ($0A),Y   (Y=5)      ; an index byte, 5 into the record at ($0A)
//   $98B1  JSR $FC79     (X=4)      ; x4
//   $98B4  LDA $02 / ADC #$A0 / STA $0E
//   $98BA  LDA $03 / ADC #$8A / STA $0F      ; ids    = $8AA0 + v*4
//   $98A1        ADC #$A0 / STA $0C
//   $98A5  LDA $03 / ADC #$8B / STA $0D      ; counts = $8BA0 + v*4
// ⛔ COMPUTED, NOT LOOKED UP — which is why a pointer-table search found nothing
// and why the records are not sequential.
export const IDS_PTR_BASE = 0x8AA0, COUNTS_PTR_BASE = 0x8BA0, PTR_SCALE = 4;
export const IDX_REC_ZP = 0x0A, IDX_REC_OFF = 5;
export const IDX_READ_PC = 0x98AD;

const { rom, snapshot } = L2.loadFixtures();
const SETS = 0x2C290, ENC = 0x2C110, LOC = 0x29, FORM = 0x2B;
const D = [Controller.BUTTON_UP, Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN, Controller.BUTTON_LEFT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

function probe(patch) {
  const r = Uint8Array.from(rom);
  const set = r[ENC + LOC];
  for (let i = 0; i < 8; i++) r[SETS + set * 8 + i] = FORM;
  for (const [o, v] of Object.entries(patch || {})) r[Number(o)] = v;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));
  nes.frame();
  const c = nes.cpu;
  c.mem[L2.PARTY_X_ZP] = L2.destX(r, LOC); c.mem[L2.PARTY_Y_ZP] = L2.destY(r, LOC);
  c.mem[L2.LOC_ID_ZP] = LOC; c.mem[L2.DEST_ID_ZP] = LOC;
  const st = [0x20, L2.LOC_ENTRY_PC & 0xFF, L2.LOC_ENTRY_PC >> 8, ...L2.NMI_TRAMPOLINE];
  st.forEach((b, i) => { c.mem[L2.NMI_STUB_RAM + i] = b; });
  c.mem[0x100] = 0x4C; c.mem[0x101] = L2.NMI_STUB_RAM & 0xFF; c.mem[0x102] = L2.NMI_STUB_RAM >> 8;
  nes.frame();
  L2.NMI_TRAMPOLINE.forEach((b, i) => { c.mem[0x100 + i] = b; });
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  run(90);
  const base = [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
  const loc0 = c.mem[L2.LOC_ID_ZP];
  let armed = false, curPC = 0, ptr = null, bank = null;
  const oW = c.write.bind(c), oE = c.emulate.bind(c);
  c.write = function (a, v) {
    if (armed && a >= IDS_RAM && a < IDS_RAM + 4 && v !== 0 && v !== 0xFF && ptr === null) {
      ptr = c.mem[REC_PTR_ZP] | (c.mem[REC_PTR_ZP + 1] << 8);
      // ⭐ confirm which bank is mapped, rather than assuming one
      const sig = Array.from({ length: 16 }, (_, k) => nes.mmap.load(0x9800 + k) & 0xFF);
      for (let bk = 0; bk < 16; bk++) {
        const off = 0x10 + bk * 0x4000 + (0x9800 - 0x8000);
        let ok = true;
        for (let j = 0; j < 16; j++) if (rom[off + j] !== sig[j]) { ok = false; break; }
        if (ok) { bank = bk; break; }
      }
    }
    return oW(a, v);
  };
  c.emulate = function () { curPC = (c.REG_PC + 1) & 0xFFFF; if (curPC === 0xC5A3) armed = true; return oE(); };
  for (let s = 0; s < 80; s++) {
    const b = D[Math.floor(s / 5) % 4];
    nes.buttonDown(1, b); run(6); nes.buttonUp(1, b); run(8);
    const now = nes.ppu.vramMem.slice(0x2000, 0x23C0);
    let d = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== base[i]) d++;
    if (d > base.length * 0.85 && c.mem[L2.LOC_ID_ZP] === loc0) {
      run(120);
      return { ids: [...c.mem.slice(IDS_RAM, IDS_RAM + 4)], counts: [...c.mem.slice(COUNTS_RAM, COUNTS_RAM + 2)], ptr, bank };
    }
  }
  return null;
}

/** Run a battle and report how the record pointer was derived. */
function derive(patch) {
  const r = Uint8Array.from(rom);
  const set = r[ENC + LOC];
  for (let i = 0; i < 8; i++) r[SETS + set * 8 + i] = FORM;
  for (const [o, v] of Object.entries(patch || {})) r[Number(o)] = v;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(r).toString('binary'));
  nes.fromJSON(JSON.parse(snapshot));
  nes.frame();
  const c = nes.cpu;
  c.mem[L2.PARTY_X_ZP] = L2.destX(r, LOC); c.mem[L2.PARTY_Y_ZP] = L2.destY(r, LOC);
  c.mem[L2.LOC_ID_ZP] = LOC; c.mem[L2.DEST_ID_ZP] = LOC;
  const st = [0x20, L2.LOC_ENTRY_PC & 0xFF, L2.LOC_ENTRY_PC >> 8, ...L2.NMI_TRAMPOLINE];
  st.forEach((b, i) => { c.mem[L2.NMI_STUB_RAM + i] = b; });
  c.mem[0x100] = 0x4C; c.mem[0x101] = L2.NMI_STUB_RAM & 0xFF; c.mem[0x102] = L2.NMI_STUB_RAM >> 8;
  nes.frame();
  L2.NMI_TRAMPOLINE.forEach((b, i) => { c.mem[0x100 + i] = b; });
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  run(90);
  const base = [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
  const loc0 = c.mem[L2.LOC_ID_ZP];
  let armed = false, curPC = 0, srcPtr = null, v5 = null, bank = null, ptr = null;
  const oW = c.write.bind(c), oE = c.emulate.bind(c);
  c.write = function (a, vv) { if (armed && a === 0x0F && ptr === null) ptr = c.mem[0x0E] | (vv << 8); return oW(a, vv); };
  c.emulate = function () {
    curPC = (c.REG_PC + 1) & 0xFFFF;
    if (curPC === 0xC5A3) armed = true;
    if (armed && curPC === IDX_READ_PC && srcPtr === null) {
      srcPtr = c.mem[IDX_REC_ZP] | (c.mem[IDX_REC_ZP + 1] << 8);
      const sig = Array.from({ length: 16 }, (_, k) => nes.mmap.load(0x9890 + k) & 0xFF);
      for (let bk = 0; bk < 16; bk++) {
        const off = 0x10 + bk * 0x4000 + (0x9890 - 0x8000);
        let okb = true;
        for (let j = 0; j < 16; j++) if (rom[off + j] !== sig[j]) { okb = false; break; }
        if (okb) { bank = bk; break; }
      }
      v5 = nes.mmap.load((srcPtr + IDX_REC_OFF) & 0xFFFF) & 0xFF;
    }
    return oE();
  };
  for (let s = 0; s < 80; s++) {
    const b = D[Math.floor(s / 5) % 4];
    nes.buttonDown(1, b); run(6); nes.buttonUp(1, b); run(8);
    const now = nes.ppu.vramMem.slice(0x2000, 0x23C0);
    let d = 0;
    for (let i = 0; i < now.length; i++) if (now[i] !== base[i]) d++;
    if (d > base.length * 0.85 && c.mem[L2.LOC_ID_ZP] === loc0) {
      run(120);
      return { srcPtr, v5, bank, ptr, ids: [...c.mem.slice(IDS_RAM, IDS_RAM + 4)] };
    }
  }
  return null;
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('FF2 formation record — the monsters\n');
const a = probe();
ok('the battle is reached and the ids are staged', !!a && a.ids.some(v => v !== 0xFF));
console.log(`  ids ${a.ids.map(v => hx(v)).join(' ')}   counts ${a.counts.map(v => hx(v)).join(' ')}   ` +
            `record ptr $${hx(a.ptr, 4)} bank ${a.bank}\n`);

ok('the record pointer was read LIVE and its bank confirmed',
   a.ptr !== null && a.bank === FORMATION_REC_BANK, `$${hx(a.ptr, 4)} bank ${a.bank}`);
const file = 0x10 + a.bank * 0x4000 + (a.ptr - 0x8000);
ok('the live pointer resolves to the recorded file offset', file === FORMATION_REC_2B,
   `0x${hx(file, 5)} vs 0x${hx(FORMATION_REC_2B, 5)}`);
ok('the staged ids are the record\'s first two bytes',
   a.ids[0] === rom[FORMATION_REC_2B + 1] && a.ids[1] === rom[FORMATION_REC_2B],
   `${hx(a.ids[0])},${hx(a.ids[1])} vs record ${hx(rom[FORMATION_REC_2B])} ${hx(rom[FORMATION_REC_2B + 1])}`);

// ⭐ the causal test: patch each id byte independently
const SENT = 0x11;
for (const off of FORMATION_ID_OFF) {
  const p = probe({ [FORMATION_REC_2B + off]: SENT });
  ok(`patching record+${off} moves that id to ${hx(SENT)}`, p && p.ids.includes(SENT),
     p ? p.ids.map(v => hx(v)).join(' ') : 'no battle');
}
// ⛔ the control: neighbouring bytes are NOT ids, so they must NOT move them
for (const off of [2, 3]) {
  const p = probe({ [FORMATION_REC_2B + off]: SENT });
  ok(`...and record+${off} does NOT (it is not an id byte)`, p && !p.ids.includes(SENT),
     p ? p.ids.map(v => hx(v)).join(' ') : 'no battle');
}
ok('the unpatched ids differ from the sentinel', !a.ids.includes(SENT));

// ── ⭐ the derivation: ptr = $8AA0 + v*4, patch-proven ──────────────────────
{
  const d = derive();
  ok('the index byte and pointer were read live, bank confirmed',
     d && d.bank === FORMATION_REC_BANK, d ? `($0A)=$${hx(d.srcPtr,4)} byte5=${hx(d.v5)}` : '');
  ok('ptr = $8AA0 + v*4 reproduces the measured pointer',
     d && (IDS_PTR_BASE + d.v5 * PTR_SCALE) === d.ptr,
     `$${hx(IDS_PTR_BASE + d.v5 * PTR_SCALE,4)} vs $${hx(d.ptr,4)}`);
  const file = 0x10 + d.bank * 0x4000 + (d.srcPtr - 0x8000) + IDX_REC_OFF;
  for (const delta of [1, 2]) {
    const p = derive({ [file]: (d.v5 + delta) & 0xFF });
    const want = (IDS_PTR_BASE + ((d.v5 + delta) & 0xFF) * PTR_SCALE) & 0xFFFF;
    ok(`patching the index byte +${delta} moves the pointer to the PREDICTED address`,
       p && p.ptr === want, `$${hx(p.ptr,4)} vs predicted $${hx(want,4)}`);
  }
  // ⛔ and it must reach the monsters, not just the pointer
  const far = derive({ [file]: (d.v5 + 2) & 0xFF });
  ok('...and a moved pointer yields DIFFERENT monsters',
     far && JSON.stringify(far.ids) !== JSON.stringify(d.ids),
     `${d.ids.map(v=>hx(v)).join(' ')} -> ${far.ids.map(v=>hx(v)).join(' ')}`);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
