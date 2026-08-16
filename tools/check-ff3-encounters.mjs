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

const P_HP0 = M3.MONSTER_PROPS + M3.FIELDS.hp[0];
const P_HP1 = M3.MONSTER_PROPS + M3.FIELDS.hp[1];

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
  // ⛔ `p[NaN] = v` is a silent no-op, so a mistyped call (an options object
  // instead of the patch map) would patch NOTHING and read as a real result.
  for (const [o, v] of Object.entries(patch)) {
    const off = Number(o);
    if (!Number.isInteger(off)) throw new Error(`fight(): bad patch key ${JSON.stringify(o)} — pass a {offset: byte} map`);
    p[off] = v;
  }
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
  const words = new Set();
  try {
    run(30);
    for (let s = 0; s < 300; s++) {
      const b = D[Math.floor(s / 8) % 4];
      nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
      for (const l of lines()) for (const m of (l.match(/[A-Za-z][A-Za-z.!'-]{2,}/g) || [])) words.add(m);
      if (lines().some(l => /Guard|Item/i.test(l))) {
        let bodies = 0;
        for (let i = 0; i < 4; i++) {
          const a = M3.enemyAddr(i);
          if ((nes.cpu.mem[a] | (nes.cpu.mem[a + 1] << 8)) > 0) bodies++;
        }
        // ⛔ a transient battle-start message ("Ambushed.") is gone by the time a
        // single final frame is sampled — collect as we go.
        for (let k = 0; k < 9; k++) {
          run(10);
          for (const l of lines()) for (const m of (l.match(/[A-Za-z][A-Za-z.!'-]{2,}/g) || [])) words.add(m);
        }
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
                 ambush: nes.cpu.mem[EN.AMBUSH_FLAG],
                 preempt: nes.cpu.mem[EN.PREEMPT_FLAG],
                 partyHP: [0, 1, 2, 3].reduce((t, i) =>
                   t + (nes.cpu.mem[M3.partyAddr(i)] | (nes.cpu.mem[M3.partyAddr(i) + 1] << 8)), 0),
                 screenWords: [...words],
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

// ── the ambush contest, and what bit 6 actually means ──────────────────────
// ⭐ Force the contest's outcome by replacing `LDA $2B` with an immediate, so the
// verdict is deterministic instead of a coin flip.
console.log('\nthe ambush contest — and bit 6 = "no surprise"');
const forceAmbush = { [EN.AMBUSH_CMP_FILE]: 0xA9, [EN.AMBUSH_CMP_FILE + 1]: 0xFF };
const forcePre = { [EN.AMBUSH_CMP_FILE]: 0xA9, [EN.AMBUSH_CMP_FILE + 1]: 0x00 };
const amb = fight(forceAmbush);
ok('forcing $2B > $2A ambushes the party', amb && amb.screenWords.includes('Ambushed.'),
   amb ? amb.screenWords.filter(w => /Amb|Crit/.test(w)).join(' ') : 'no battle');
ok('...and the party loses HP to the free round', amb && amb.partyHP < base.partyHP,
   amb ? `${base.partyHP} -> ${amb.partyHP}` : '');
ok('...and the ambush flag is set', amb && amb.ambush === EN.AMBUSH_FLAG_SET,
   amb ? `0x${amb.ambush.toString(16)}` : '');
const pre = fight(forcePre);
ok('forcing $2B < $2A sets the pre-emptive flag instead', pre && pre.preempt > 0,
   pre ? `$78BA=${pre.preempt}` : '');
ok('...with no ambush and no HP lost', pre && pre.ambush === 0 && pre.partyHP === base.partyHP,
   pre ? `HP ${pre.partyHP}` : '');
// ⭐⭐ the discriminator: bit 6 must suppress even a FORCED ambush.
// ⛔ Use the CONSTANT, not a literal — otherwise mislabelling which bit is the
// no-surprise flag sails straight through, which is exactly what happened first.
const NS = EN.COUNT_FLAG_NO_SURPRISE;
const OTHER = 0xC0 & ~NS;
const amb6 = fight({ ...forceAmbush, [EN.ENCOUNTER_SET + 1]: NS | LIVE_COUNT_INDEX });
ok(`the no-surprise bit (0x${NS.toString(16)}) suppresses even a forced ambush`,
   amb6 && amb6.ambush === 0 && !amb6.screenWords.includes('Ambushed.')
   && amb6.partyHP === base.partyHP,
   amb6 ? `flag=0x${amb6.ambush.toString(16)} HP=${amb6.partyHP}` : '');
// ⛔ and the OTHER flag bit must NOT suppress it, or the check would pass for any bit.
const amb7 = fight({ ...forceAmbush, [EN.ENCOUNTER_SET + 1]: OTHER | LIVE_COUNT_INDEX });
ok(`the other bit (0x${OTHER.toString(16)}) does NOT suppress it`,
   amb7 && amb7.ambush === EN.AMBUSH_FLAG_SET, amb7 ? `0x${amb7.ambush.toString(16)}` : '');

// ⛔ bit 7's destination bit is READ at exactly three places — pinned statically
// so the record cannot drift, since none of them runs in an ordinary battle.
ok('the three $7ED8 bit-0 test sites are where the lib says',
   EN.BIT0_TEST_SITES.every(f =>
     JSON.stringify([...rom.slice(f, f + 5)]) === JSON.stringify([0xAD, 0xD8, 0x7E, 0x29, 0x01])),
   EN.BIT0_TEST_SITES.map(f => '0x' + f.toString(16)).join(' '));
ok('the rotate that moves the flags is where the lib says',
   JSON.stringify([...rom.slice(EN.FLAG_ROTATE_FILE, EN.FLAG_ROTATE_FILE + 6)])
   === JSON.stringify([0xAD, 0xD8, 0x7E, 0x4A, 0x6E, 0xD8]),
   'LDA $7ED8 / LSR A / ROR $7ED8');

// ── bit 7: the Bard cannot sing ─────────────────────────────────────────────
// ⭐ Driven from the ENCOUNTER data — a Bard party, the song row, nothing poked.
console.log('\nbit 7 — the Bard cannot sing in this encounter');
function bardFight(setByte) {
  const p = Uint8Array.from(rom);
  p[P_HP0] = 0xFF; p[P_HP1] = 0x0F;
  p[EN.ENCOUNTER_SET + 1] = setByte;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  try { nes.loadROM(Buffer.from(p).toString('binary')); nes.fromJSON(JSON.parse(SNAP)); } catch { return null; }
  const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
  const scr = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let t = '';
      for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); t += (g === null ? ' ' : g); }
      if (t.trim()) out.push(t.replace(/\s+/g, ' ').trim());
    }
    return out;
  };
  const setjob = () => { for (let i = 0; i < 4; i++) {
    const a2 = M3.PARTY_A_BLOCK + i * M3.PARTY_B_STRIDE;
    nes.cpu.mem[a2] = EN.BARD_JOB; nes.cpu.mem[a2 + 1] = 20; } };
  const tap = (b2, h = 10, g = 26) => { nes.buttonDown(1, b2); run(h); nes.buttonUp(1, b2); run(g); };
  const words = new Set();
  try {
    run(30); setjob();
    let inB = false;
    for (let s2 = 0; s2 < 300; s2++) {
      setjob(); const b2 = D[Math.floor(s2 / 8) % 4];
      nes.buttonDown(1, b2); run(10); nes.buttonUp(1, b2); run(12);
      if (scr().some(l => /Sing|Scare|Cheer/i.test(l))) { inB = true; break; }
    }
    if (!inB) return null;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        for (let d = 0; d < EN.BARD_SONG_ROW; d++) tap(Controller.BUTTON_DOWN);
        tap(Controller.BUTTON_A, 10, 45); tap(Controller.BUTTON_A, 10, 45); tap(Controller.BUTTON_A, 10, 45);
      }
      run(260);
      for (const l of scr()) for (const m of (l.match(/[A-Za-z][A-Za-z.!'-]{2,}/g) || [])) words.add(m);
    }
    return { words: [...words], bit0: nes.cpu.mem[EN.FLAG_DEST] & 1 };
  } catch { return null; }
}
const NS2 = EN.COUNT_FLAG_NO_SONG;
const songOk = bardFight(LIVE_COUNT_INDEX);
const songNo = bardFight(NS2 | LIVE_COUNT_INDEX);
ok('with the bit clear the Bard\'s Scare works', songOk && songOk.words.includes(EN.BARD_OK_WORD),
   songOk ? `bit0=${songOk.bit0}` : 'no battle');
ok(`with the no-song bit (0x${NS2.toString(16)}) it is refused`,
   songNo && songNo.words.some(w => w.includes(EN.BARD_BLOCKED_WORD))
   && !songNo.words.includes(EN.BARD_OK_WORD),
   songNo ? `bit0=${songNo.bit0}` : '');
ok('...and the bit really reached $7ED8 bit 0', songNo && songNo.bit0 === 1 && songOk.bit0 === 0);

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
