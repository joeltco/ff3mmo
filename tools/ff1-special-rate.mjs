#!/usr/bin/env node
// ff1-special-rate.mjs — what decides HOW OFTEN an FF1 monster uses its special?
//
//   node tools/ff1-special-rate.mjs --id 0x77 --rounds 12
//
// ⭐ Byte 7 is the special ID (swept, 44 values, docs/FF1-MONSTER-SPECIALS.md).
// Nothing in the 20-byte stat record is a RATE, so the gate lives in code or in a
// per-special table. This finds the code by hooking the READ of the special id in
// RAM and capturing the PC *together with its bank*.
//
// ⛔ A PREVIOUS ATTEMPT AT THIS RETURNED "nothing ever reads the special id" and
// that null was an ARTIFACT: the harness was ending its rounds at the ~780-frame
// menu gap, so no monster ever took a turn and no special ever fired. With the
// fixed driver the specials demonstrably fire, so a null here means something.
//
// ⛔ AND THE BANK IS CAPTURED, NEVER INFERRED. `$B2A6` was recorded as the special
// gate without its bank; disassembling it in bank 12 gave a confident, coincidental,
// WRONG decode that cost four probes. Every PC below carries a 16-byte signature
// matched back to ROM file offsets.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ID = Number(flag('id', '0x77'));
const ROUNDS = Number(flag('rounds', '12'));
const ROUND_CAP = 1800;
// ⭐ --pokerate $ADDR=VAL — held every sample, exactly like the HP pin. A candidate
// only becomes THE rate if forcing it moves the firing frequency; being read every
// round just makes it a suspect.
const PR = flag('pokerate', null);
let prAddr = null, prVal = 0;
if (PR) { const [a, v] = PR.split('='); prAddr = Number(a.replace('$', '0x')); prVal = Number(v); }

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const PARTY_HP = 0x610A, PARTY_STRIDE = 0x40;

// ⭐ ROM stat byte 7 -> RAM byte 3 of the enemy record (patch-proven with two
// sentinels in an earlier session). Slot 0's record base is $6BDC.
const SPECIAL_ADDR = MN.ENEMY_RAM + 3;

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
// ⭐ $9020 + byte7*16 — measured, not derived: the spell pools for byte 7 $22/$24/$2A
// were caught at runtime at $9242/$9262/$92C2, which fixes both stride (16) and base.
const POOL_ENTRY = 0x9020 + rom[S + MN.STAT_FIELDS.special] * 16;

p[S + MN.STAT_FIELDS.evade] = 0xFF;

// ⭐ --rompatch FILEOFF=VAL — patch the ROM before load. Used to prove byte 0 of
// the $9020 + byte7*16 entry IS the chance: holding a plausible value is not
// evidence, moving the observed firing rate is.
const RP = flag('rompatch', null);
if (RP) { const [a, v] = RP.split('='); p[Number(a)] = Number(v) & 0xFF; }

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(SNAP));
const c = nes.cpu;
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

const lines = () => {
  const v = nes.ppu.vramMem, out = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let col = 0; col < 32; col++) { const g = F1.glyph(v[0x2000 + r * 32 + col]); s += (g === null || g === '\n') ? ' ' : g; }
    out.push(s);
  }
  return out;
};
const menuUp = () => lines().some(l => /\bRUN\b/.test(l));
const onBattleScreen = () => lines().filter(l => /\bHP\b/.test(l)).length >= 3;
const immortal = () => {
  for (let i = 0; i < 4; i++) { c.mem[PARTY_HP + i * PARTY_STRIDE] = 0xE7; c.mem[PARTY_HP + i * PARTY_STRIDE + 1] = 0x03; }
  for (let i = 0; i < 9; i++) {
    const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
    if ((c.mem[a + MN.ENEMY_MAXHP_OFF] | (c.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) === 0) continue;
    c.mem[a + MN.ENEMY_CURHP_OFF] = 0xE7; c.mem[a + MN.ENEMY_CURHP_OFF + 1] = 0x03;
  }
  if (prAddr !== null) c.mem[prAddr] = prVal;
};

// --- read hook -------------------------------------------------------------
// ⛔ Indexed addressing dummy-reads its target, which is what manufactured fake
// "readers" in earlier probes. Record the PC so those can be told apart by what
// the instruction at it actually is, rather than by assumption.
// ⭐ THE DISCRIMINATOR: the special ID is read only when the special FIRES (3 fires
// -> exactly 3 reads, measured). A RATE byte has to be read on EVERY round, because
// it is what the roll is compared against. So tally reads per record offset and
// split them by whether that round fired — the rate shows up as an offset read in
// every round, the id as one read only in the rounds that fired.
const LO = MN.ENEMY_RAM - 8, HI = MN.ENEMY_RAM + MN.ENEMY_RAM_STRIDE;
let recording = false;
const reads = [];
let roundReads = new Map();          // offset -> count, reset per round
const pcByOff = new Map();
const perRound = [];                 // { fired, offsets: Map }
const tableReads = [];               // { addr, param, special } at the spell-table lookup
let rolls = 0;                       // executions of the chance read at $B2C2
const origLoad = c.load.bind(c);
c.load = function (addr) {
  // ⭐ Capture the SPELL-TABLE pointer where it is actually computed, rather than
  // deriving $81E0 + id*8 and trusting the bank. jsnes REG_PC sits one byte past
  // the opcode, so the LDA ($98),Y at $B37B reports $B37C.
  // ⭐ COUNT THE ROLL ITSELF. $B2C2 reads byte 0 of the $9020+id*16 entry and hands
  // it to the roll at $B294; $B2C7 BCS skips on failure. Counting this read gives
  // the number of ROLLS, so fires/rolls is the true probability — far better than
  // inferring it from activations per round, which depends on the monster getting
  // a turn at all. (REG_PC is one past the opcode, so $B2C2 reports $B2C3.)
  // ⛔ DO NOT COUNT BY PC. `LDA ($9E),Y` issues its two zero-page pointer reads at
  // the SAME PC as the real fetch, so a PC-keyed counter over-counts ~3x and made a
  // 1-roll sample look like 3. Count the ADDRESS of the entry's byte 0 instead —
  // that is read exactly once per roll.
  if (recording && addr === POOL_ENTRY) rolls++;
  if (recording && (c.REG_PC === 0xB37C || c.REG_PC === 0xB37B)) {
    tableReads.push({ addr, param: c.mem[0x6C8C], special: c.mem[SPECIAL_ADDR] });
  }
  if (recording && addr >= LO && addr < HI) {
    if (addr === SPECIAL_ADDR) reads.push(c.REG_PC);
    const off = addr - MN.ENEMY_RAM;
    roundReads.set(off, (roundReads.get(off) || 0) + 1);
    const key = off + ':' + c.REG_PC;
    pcByOff.set(key, (pcByOff.get(key) || 0) + 1);
  }
  return origLoad(addr);
};

// --- reach the battle ------------------------------------------------------
run(20);
c.mem[0x27] = 150; c.mem[0x28] = 170;
run(20);
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
let started = false;
for (let s = 0; s < 300 && !started; s++) {
  const b = D[Math.floor(s / 6) % 2];
  nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
  if (menuUp()) started = true;
}
if (!started) { console.log('never reached a battle'); process.exit(1); }

console.log(`monster $${hx(ID)}, special id $${hx(rom[S + MN.STAT_FIELDS.special])}`);
console.log(`RAM special byte @ $${hx(SPECIAL_ADDR, 4)} = $${hx(c.mem[SPECIAL_ADDR])} ` +
            `(ROM byte 7 = $${hx(rom[S + MN.STAT_FIELDS.special])}) ` +
            `${c.mem[SPECIAL_ADDR] === rom[S + MN.STAT_FIELDS.special] ? '⭐ matches' : '⛔ DOES NOT MATCH — wrong address'}`);

// --- drive rounds, count how often the special fires ------------------------
// ⭐ The rate is measurable directly: run many rounds and count the ones in which
// the special's own word appears. That says whether the rate is a shared constant
// or per-monster BEFORE any disassembly.
const BASE = new Set(['AAAA', 'Missed\'', 'RUN', 'ITEM', 'DMG', 'HP', 'Critical', 'hit\'\'']);
const nameOf = (id) => MN.monsterName(rom, id, F1.glyph) || '';
const MYNAME = nameOf(ID);
let fired = 0, acted = 0;
recording = true;
for (let r = 0; r < ROUNDS; r++) {
  if (!onBattleScreen()) break;
  immortal();
  for (let k = 0; k < 12 && menuUp() && onBattleScreen(); k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16);
  }
  acted++;
  const seen = new Set();
  roundReads = new Map();            // ⭐ this round's reads only
  let f = 0;
  while (f < ROUND_CAP && !menuUp() && onBattleScreen()) {
    run(10); f += 10; immortal();
    for (const l of lines()) for (const m of l.matchAll(/[A-Za-z][A-Za-z.']{2,}/g)) seen.add(m[0]);
  }
  const novel = [...seen].filter(w => !BASE.has(w) && w !== MYNAME && !MYNAME.includes(w));
  if (novel.length) fired++;
  perRound.push({ fired: novel.length > 0, offsets: roundReads });
  console.log(`  round ${String(r + 1).padStart(2)}: ${novel.length ? '⭐ ' + novel.slice(0, 5).join(' ') : '—'}`);
}
recording = false;

// ⛔ The word heuristic OVERCOUNTS — status text from an ordinary hit (Paralyzed,
// Stun, Hits') reads as a fire. Reads of the special id are the clean counter: they
// happen once per real activation and never otherwise.
console.log(`\nword-heuristic fired in ${fired}/${acted} rounds`);
console.log(`⭐ ACTIVATIONS (reads of $${hx(SPECIAL_ADDR, 4)}): ${reads.length}/${acted} rounds ` +
            `= ${(100 * reads.length / Math.max(acted, 1)).toFixed(0)}%` +
            (prAddr !== null ? `   [held $${hx(prAddr, 4)} = ${prVal}]` : '   [control]'));

// --- is $6C8C the monster's byte 7, or a separate id? ----------------------
console.log(`\n⭐ ROLLS at $B2C2: ${rolls}   fires: ${reads.length}   ` +
            `=> ${rolls ? (100 * reads.length / rolls).toFixed(0) + '%' : 'n/a'} of rolls pass`);
console.log(`\n${tableReads.length} spell-table lookups at $B37B`);
const seenLk = new Map();
for (const t of tableReads) {
  const k = `${t.addr}|${t.param}|${t.special}`;
  seenLk.set(k, (seenLk.get(k) || 0) + 1);
}
if (seenLk.size) {
  console.log('  ptr+4     $6C8C  record+12  base = ptr-4 - param*8   same id?');
  for (const [k, n] of [...seenLk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const [addr, param, special] = k.split('|').map(Number);
    const base = addr - 4 - param * 8;
    console.log(`  $${hx(addr, 4)}    $${hx(param)}      $${hx(special)}        $${hx(base, 4)}` +
      `                ${param === special ? '⭐ YES' : '⛔ NO — different numbering'}  x${n}`);
  }
}

// --- which record offset is read EVERY round -------------------------------
const F = perRound.filter(r => r.fired), N = perRound.filter(r => !r.fired);
const offs = [...new Set(perRound.flatMap(r => [...r.offsets.keys()]))].sort((a, b) => a - b);
console.log('\noffset  addr    rounds read (fired)  rounds read (quiet)  verdict');
for (const o of offs) {
  const inF = F.filter(r => r.offsets.has(o)).length, inN = N.filter(r => r.offsets.has(o)).length;
  // Read in every round -> a candidate for the thing being rolled against.
  // Read only in rounds that fired -> downstream of the decision, not the gate.
  const verdict = (inF === F.length && inN === N.length && perRound.length > 1) ? '⭐ EVERY round — rate candidate'
    : (inN === 0 && inF > 0) ? 'only when it fires — downstream'
    : '';
  console.log(`  +${String(o).padStart(3)}  $${hx(MN.ENEMY_RAM + o, 4)}  ${String(inF).padStart(10)}/${F.length}      ${String(inN).padStart(10)}/${N.length}     ${verdict}`);
}

// --- who read it, and from which bank --------------------------------------
const byPc = new Map();
for (const pc of reads) byPc.set(pc, (byPc.get(pc) || 0) + 1);
if (byPc.size) {
  console.log('\nreader PC  count  mapped bytes        ROM bank (16-byte signature)');
  for (const [pc, n] of [...byPc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const sig = Array.from({ length: 16 }, (_, i) => c.mem[(pc + i) & 0xFFFF]);
    const hits = [];
    for (let o = 16; o + 16 <= rom.length; o++) {
      let ok = true;
      for (let i = 0; i < 16; i++) if (rom[o + i] !== sig[i]) { ok = false; break; }
      if (ok) { hits.push(o); if (hits.length > 4) break; }
    }
    const where = hits.length === 1 ? `⭐ bank ${Math.floor((hits[0] - 16) / 0x4000)} (file $${hx(hits[0], 5)})`
      : hits.length === 0 ? '⛔ no ROM match' : `⛔ AMBIGUOUS x${hits.length}`;
    console.log(`  $${hx(pc, 4)}  ${String(n).padStart(5)}  ${sig.slice(0, 6).map(v => hx(v)).join(' ')}  ${where}`);
  }
}
