#!/usr/bin/env node
// check-ff3-encounters.mjs — FF3's formation tables stay decoded.
//
// Pins the two claims that took real work: a formation RECORD is 6 bytes with the
// four species ids at +2, and the COUNT record is 4 nibble-packed min/max bytes
// that the game rolls per battle. Both are checked against a running encounter —
// the count by patching the live record and counting bodies on the field.
//
//   node tools/check-ff3-encounters.mjs
//
// ⛔ The species record and the count record use DIFFERENT indices (0 and 7 for
// the freeroam encounter). Patching `COUNT_TABLE + 0*4` changes nothing and looks
// like the table is inert — the live index has to be used.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];
const LIVE_COUNT_INDEX = 7;          // measured off $7D68 & 0x3F

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Walk into an encounter with `patch` applied; report the field. */
function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  p[M3.MONSTER_PROPS + 1] = 0xFF; p[M3.MONSTER_PROPS + 2] = 0x0F;
  for (const [o, v] of Object.entries(patch)) p[Number(o)] = v;
  // ⛔ the frame callback has to be given at CONSTRUCTION — assigning
  // `nes.opts.onFrame` afterwards never fires, and the hash comes back all-zero.
  let fb = null;
  const nes = new NES({ onFrame: (b2) => { fb = b2; }, onAudioSample: () => {} });
  try { nes.loadROM(Buffer.from(p).toString('binary')); nes.fromJSON(JSON.parse(SNAP)); } catch { return null; }
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
      if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
    }
    return out;
  };
  try {
    run(30);
    for (let s = 0; s < 300; s++) {
      const b = D[Math.floor(s / 8) % 4];
      nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
      if (lines().some(l => /Guard|Item/i.test(l))) {
        let bodies = 0;
        for (let i = 0; i < 4; i++) {
          const a = M3.enemyAddr(i);
          if ((nes.cpu.mem[a] | (nes.cpu.mem[a + 1] << 8)) > 0) bodies++;
        }
        run(90);
        let fh = 0, lit = 0;
        if (fb) for (let y = 16; y < 120; y++) for (let x = 8; x < 128; x++) {
          const px = (fb[y * 256 + x] | 0) & 0xFFFFFF;
          fh = ((fh * 31) + px) >>> 0; if (px) lit++;
        }
        return { bodies,
                 species: [...nes.cpu.mem.slice(EN.RAM_SPECIES, EN.RAM_SPECIES + 4)],
                 counts: [...nes.cpu.mem.slice(EN.RAM_COUNTS, EN.RAM_COUNTS + 4)],
                 pal: [...nes.ppu.vramMem.slice(0x3F00, 0x3F20)],
                 flagDest: nes.cpu.mem[EN.FLAG_DEST],
                 frame: fh, lit, screen: lines() };
      }
    }
  } catch { /* fall through */ }
  return null;
}

console.log('FF3 encounter formations — the tables vs a real encounter\n');

const base = fight();
if (!base) { console.error('no encounter'); process.exit(1); }

// ── the species record ──────────────────────────────────────────────────────
ok('the expander leaves the ROM species ids in RAM',
   JSON.stringify(base.species) === JSON.stringify(EN.speciesOf(rom, 0)),
   `${base.species.join(',')} vs ${EN.speciesOf(rom, 0).join(',')}`);
ok('unused species slots are 0xFF', base.species.slice(1).every(v => v === EN.SPECIES_EMPTY));
// ⭐ patching the species id changes WHO shows up — the name on screen follows.
const tiger = fight({ [EN.SPECIES_TABLE + EN.SPECIES_ID_OFF]: 0x29 });   // Flyer
ok('patching the species id changes the monster drawn',
   tiger && tiger.screen.some(l => /Flye/i.test(l)) && base.screen.some(l => /Gobl/i.test(l)),
   tiger ? tiger.screen.filter(l => /[A-Za-z]{3,}/.test(l))[0] : 'no battle');

// ── the count record ────────────────────────────────────────────────────────
const CB = EN.COUNT_TABLE + LIVE_COUNT_INDEX * EN.COUNT_STRIDE;
const [minN, maxN] = EN.countRange(rom[CB]);
ok('the natural count byte is a min/max range', minN >= 1 && maxN >= minN,
   `0x${rom[CB].toString(16)} -> ${minN}..${maxN}`);
ok('the rolled count sits inside that range',
   base.counts[0] >= minN && base.counts[0] <= maxN, `${base.counts[0]} in ${minN}..${maxN}`);
ok('bodies on the field match the rolled count', base.bodies === base.counts[0],
   `${base.bodies} bodies, count ${base.counts[0]}`);
// ⭐ the discriminator: a FIXED range must produce exactly that many, every time.
for (const [raw, want] of [[0x11, 1], [0x33, 3], [0x44, 4]]) {
  const r = fight({ [CB]: raw });
  ok(`count byte 0x${raw.toString(16)} puts ${want} on the field`, r && r.bodies === want,
     r ? `${r.bodies}` : 'no battle');
}
// ⛔ and the wrong index must NOT work — that is what made this look inert.
const wrongIdx = fight({ [EN.COUNT_TABLE + 0 * EN.COUNT_STRIDE]: 0x44 });
ok('patching index 0 does NOT change the field — the indices differ',
   wrongIdx && wrongIdx.bodies === base.bodies, wrongIdx ? `${wrongIdx.bodies}` : 'no battle');

// ── ENCOUNTER_SET: the pair of indices ──────────────────────────────────────
// ⭐ This is what explains the two different offsets: the zone entry picks the
// species record and the count pattern SEPARATELY.
console.log('\nENCOUNTER_SET — zone -> (species record, count pattern)');
const [s0, c0] = EN.setEntry(rom, 0);
ok('entry 0 holds the indices the expander used', s0 === 0 && (c0 & EN.COUNT_INDEX_MASK) === LIVE_COUNT_INDEX,
   `species ${s0}, count ${c0}`);
// ⛔ Zone 0 cannot test the STRIDE — zone*stride is 0 whatever the stride is, so
// a wrong stride sails through. Check a NONZERO zone against a file offset taken
// from the disassembly (`ASL $7E / ROL $7F` = *2), not from the constant.
ok('the entry stride is 2 — checked on a NONZERO zone',
   JSON.stringify(EN.setEntry(rom, 1)) === JSON.stringify([rom[0x05C012], rom[0x05C013]]),
   `zone 1 = ${EN.setEntry(rom, 1).join(',')} vs ROM ${rom[0x05C012]},${rom[0x05C013]}`);
ok('...and zone 3 too', JSON.stringify(EN.setEntry(rom, 3)) === JSON.stringify([rom[0x05C016], rom[0x05C017]]),
   `zone 3 = ${EN.setEntry(rom, 3).join(',')}`);
for (const [v, want] of [[6, 9], [7, 10]]) {
  const r = fight({ [EN.ENCOUNTER_SET]: v });
  ok(`byte 0 = ${v} spawns species record ${v} (id ${want})`,
     r && r.species[0] === want, r ? `species ${r.species[0]}` : 'no battle');
}
for (const [v, want] of [[0, 1], [2, 3], [3, 4]]) {
  const r = fight({ [EN.ENCOUNTER_SET + 1]: v });
  ok(`byte 1 = ${v} puts ${want} on the field`, r && r.bodies === want,
     r ? `${r.bodies}` : 'no battle');
}
// ⭐ the count table is a SHARED library of patterns, not per-formation data.
ok('COUNT_TABLE is a library of ranges (0=1..1, 3=4..4, 9=4..8)',
   EN.countRange(EN.countsOf(rom, 0)[0]).join() === '1,1'
   && EN.countRange(EN.countsOf(rom, 3)[0]).join() === '4,4'
   && EN.countRange(EN.countsOf(rom, 9)[0]).join() === '4,8');

// ── the header bytes are palette indices ────────────────────────────────────
// ⭐ Checked against the PPU's own palette RAM, which is as close to "what the
// player sees" as this gets.
console.log('\nthe species record header — two PALETTE indices');
{
  let allColours = true;
  for (let i = 0; i < EN.PALETTE_ENTRIES; i++)
    if (EN.paletteOf(rom, i).some(v => v > EN.PALETTE_MAX_COLOUR)) allColours = false;
  ok('every byte of the palette table is a valid NES colour', allColours,
     `${EN.PALETTE_ENTRIES} entries x ${EN.PALETTE_STRIDE}`);
}
for (const [byteIdx, slot] of EN.HEADER_PPU_SLOTS.entries()) {
  for (const idx of [0x00, 0x0F]) {
    const r = fight({ [EN.SPECIES_TABLE + byteIdx]: idx });
    const want = EN.paletteOf(rom, idx);
    const got = r ? r.pal.slice(slot - 0x3F00, slot - 0x3F00 + 3) : [];
    ok(`header byte ${byteIdx} = 0x${idx.toString(16)} loads palette ${idx} at $${slot.toString(16).toUpperCase()}`,
       r && JSON.stringify(got) === JSON.stringify(want),
       `${got.join(',')} vs ${want.join(',')}`);
  }
}
// ⛔ the discriminator: a palette must change the COLOURS without changing the
// SHAPE. A nametable hash showed nothing at all here — even for the species
// control — so the frame is what gets measured.
{
  const a2 = fight({ [EN.SPECIES_TABLE]: 0x00 });
  const b2 = fight({ [EN.SPECIES_TABLE]: 0x0F });
  ok('two palettes draw a DIFFERENT image...', a2 && b2 && a2.frame !== b2.frame);
  ok('...with exactly the same lit-pixel count — colour, not shape',
     a2 && b2 && a2.lit === b2.lit, a2 && b2 ? `${a2.lit} vs ${b2.lit}` : '');
}

// ── the count byte's top two bits, followed to $7ED8 ───────────────────────
console.log('\nthe count byte flags -> $7ED8');
ok('the merge instructions are where the lib says',
   JSON.stringify([...rom.slice(EN.FLAG_MERGE_FILE, EN.FLAG_MERGE_FILE + EN.FLAG_MERGE_BYTES.length)])
   === JSON.stringify(EN.FLAG_MERGE_BYTES),
   `LDA $7D68 / LSR x6 / AND #$03 / ORA $7ED8 / STA $7ED8`);
// ⭐ and the measured mapping — bit 6 becomes $7ED8 bit 7, bit 7 becomes bit 0.
for (const [flags, want] of Object.entries(EN.FLAG_DEST_VALUES)) {
  const r = fight({ [EN.ENCOUNTER_SET + 1]: Number(flags) | LIVE_COUNT_INDEX });
  ok(`count byte flags 0x${Number(flags).toString(16)} -> $7ED8 = 0x${want.toString(16)}`,
     r && r.flagDest === want, r ? `0x${r.flagDest.toString(16)}` : 'no battle');
}
// ⛔ and the count index must still work with the flags set — they are separate.
{
  const r = fight({ [EN.ENCOUNTER_SET + 1]: 0xC0 | 3 });
  ok('the flags do not disturb the count index (0xC0|3 still puts 4 on the field)',
     r && r.bodies === 4, r ? `${r.bodies}` : 'no battle');
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
