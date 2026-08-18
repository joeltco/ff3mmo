#!/usr/bin/env node
// ff1-rng-stride.mjs — log the RNG table index at each special roll.
//
//   node tools/ff1-rng-stride.mjs --id 0x77 --list b --chance 0x20 --battles 8
//
// ⭐ WHY: the measured fire rate for list B runs ~1.35x nominal in the mid range
// ($20 -> 36% where chance/128 says 25%). The table itself is NOT the cause —
// over all 256 bytes, floor(v*129/256) < $20 holds for 65/256 = 25.4%, i.e. the
// table is uniform to within a rounding step. So if the rate is really high, the
// roll must not be sampling the table uniformly. This logs which INDEX each roll
// reads so that can be checked directly instead of guessed at.
//
// ⭐ THE RNG (disassembled, fixed bank $C000-$FFFF):
//   $FCE7  LDX $688A / INC $688A / LDA $FCF1,X / RTS
// so it is a 256-byte LOOKUP TABLE at $FCF1 walked by a counter at $688A. Every
// call advances the counter by exactly one; nothing reseeds it.
//
// ⭐ THE ROLL (bank 12):
//   $B294  STA $6BCF / LDA #$00 / LDX #$80 / JSR $AE5D / CMP $6BCF / RTS
//   $AE5D  span = X+1-A = 129;  JSR $F227 (rng) ; JSR $AE09 (A*span, hi byte)
//   $AE09  8-bit multiply, high byte in X -> TXA
// so  value = floor(rand * 129 / 256)  and it FIRES when value < chance.
//
// ⛔ The roll's table read is identified POSITIONALLY: it is the first read in
// $FCF1..$FDF0 after a read of the pool's chance byte. Do not try to key it off
// REG_PC — jsnes leaves PC one byte past the opcode mid-execution.

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
const ROUNDS = Number(flag('rounds', '24'));
const CHANCE = flag('chance', null);
const BATTLES = Number(flag('battles', '8'));
const LIST = flag('list', 'b');
const ROLL_OFF = LIST === 'b' ? 1 : 0;
const LIST_LO = LIST === 'b' ? 11 : 2;
const LIST_HI = LIST === 'b' ? 14 : 9;
const ROUND_CAP = 1800;

const RNG_TABLE = 0xFCF1;
const RNG_CTR = 0x688A;

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const PARTY_HP = 0x610A, PARTY_STRIDE = 0x40;

// The table as it sits in ROM ($C000-$FFFF is the fixed last 16K bank).
const PRG = rom[4] * 16384;
const FIXED = 16 + PRG - 16384;
const TABLE = [];
for (let i = 0; i < 256; i++) TABLE.push(rom[FIXED + (RNG_TABLE - 0xC000) + i]);
const rollValue = (v) => Math.floor(v * 129 / 256);

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
p[S + MN.STAT_FIELDS.evade] = 0xFF;

const POOL_ID = rom[S + MN.STAT_FIELDS.special];
const POOL_CPU = 0x9020 + POOL_ID * 16;
const POOL_FILE = 0x30010 + (POOL_CPU - 0x8000);   // bank 12
if (CHANCE !== null) p[POOL_FILE + ROLL_OFF] = Number(CHANCE) & 0xFF;
const CHANCE_VAL = p[POOL_FILE + ROLL_OFF];

// ⛔ THE SPIN GUARD. $B30A resets the list counter and jumps back to $B2F8 when
// the indexed entry is $FF. If EVERY slot of the list is $FF, that is an
// unbreakable loop — the ROM never leaves it. In the unmodified game it is
// unreachable (all 44 pools have chance == 0 exactly when the list is empty),
// but patching a chance byte non-zero over an empty list walks straight into it.
// ⭐ This is not hypothetical: measuring id $77 (LICH, pool $22, list B all $FF)
// hung the emulator after the first roll and logged 12,332,381 reads of +11.
// The v1.9.11 curve was taken from that hung run and was pure artifact.
const listSlots = [...Array(LIST_HI - LIST_LO + 1)].map((_, i) => p[POOL_FILE + LIST_LO + i]);
if (CHANCE_VAL !== 0 && listSlots.every(v => v === 0xFF)) {
  console.error(`⛔ pool $${hx(POOL_ID)} list ${LIST} is entirely $FF but chance=$${hx(CHANCE_VAL)}.`);
  console.error(`   $B30A/$B2DB would spin forever on the $FF retry. Pick a monster whose`);
  console.error(`   list ${LIST} is populated — the default --id is NOT a valid list-B isolator.`);
  process.exit(1);
}
// A partially-$FF list still takes the retry path, which costs an extra roll-free
// read and makes "one read == one fire" false. Warn rather than refuse.
if (CHANCE_VAL !== 0 && listSlots.some(v => v === 0xFF)) {
  console.error(`⚠ pool $${hx(POOL_ID)} list ${LIST} has $FF slots — the wrap path adds reads; fires may over-count.`);
}
if (LIST === 'b' && p[POOL_FILE] !== 0) {
  console.error(`⚠ byte 0 = $${hx(p[POOL_FILE])} != 0, so list A fires first and list B is NOT isolated.`);
}

function runBattle(offset) {
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
  };

  let recording = false, armed = false;
  let totalRng = 0;                 // every table read, roll or not
  const rolls = [];                 // { idx, byte, val, fired, rngBefore }
  let pending = null;
  const origLoad = c.load.bind(c);
  c.load = function (addr) {
    if (recording) {
      if (addr >= RNG_TABLE && addr <= RNG_TABLE + 255) {
        totalRng++;
        if (armed) {
          armed = false;
          const idx = addr - RNG_TABLE;
          const byte = TABLE[idx];
          // Cross-check the positional identification against the counter itself:
          // $688A has already been INC'd by the time the table read issues.
          const ctr = (c.mem[RNG_CTR] - 1) & 0xFF;
          pending = { idx, byte, val: rollValue(byte), fired: false, rngBefore: totalRng - 1, ctrOk: ctr === idx };
          rolls.push(pending);
        }
      } else if (addr === POOL_CPU + ROLL_OFF) {
        armed = true;
      } else if (addr >= POOL_CPU + LIST_LO && addr <= POOL_CPU + LIST_HI) {
        if (pending) { pending.fired = true; pending = null; }
      }
    }
    return origLoad(addr);
  };

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
  if (!started) return null;

  c.mem[RNG_CTR] = offset & 0xFF;   // independent stream per battle

  recording = true;
  let acted = 0;
  for (let r = 0; r < ROUNDS; r++) {
    if (!onBattleScreen()) break;
    immortal();
    for (let k = 0; k < 12 && menuUp() && onBattleScreen(); k++) {
      nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16);
    }
    acted++;
    let f = 0;
    while (f < ROUND_CAP && !menuUp() && onBattleScreen()) { run(30); f += 30; immortal(); }
  }
  return { rolls, rounds: acted, totalRng };
}

// ⛔ A battle is ~10 minutes of emulation. Write every battle's rolls to disk as
// it finishes, so a run that is killed or times out still leaves usable data
// instead of nothing — the first attempt at this measurement lost 25 minutes to
// a timeout that landed before the single end-of-run summary printed.
const OUT = flag('out', null);
if (OUT) fs.writeFileSync(OUT, '');

const all = [];
let RD = 0, ok = 0, totalRng = 0;
for (let b = 0; b < BATTLES; b++) {
  const res = runBattle(b * 21);
  if (!res) { console.log(`  battle ${b + 1}: never reached a battle`); continue; }
  ok++; RD += res.rounds; totalRng += res.totalRng;
  const fired = res.rolls.filter(r => r.fired).length;
  console.log(`  battle ${b + 1}: rounds=${res.rounds} rolls=${res.rolls.length} fires=${fired} rngCalls=${res.totalRng}`);
  all.push(res.rolls);
  if (OUT) fs.appendFileSync(OUT, JSON.stringify({ battle: b + 1, chance: CHANCE_VAL, id: ID, pool: POOL_ID, list: LIST, rounds: res.rounds, totalRng: res.totalRng, rolls: res.rolls.map(r => [r.idx, r.byte, r.fired ? 1 : 0]) }) + '\n');
}

const flat = all.flat();
const bad = flat.filter(r => !r.ctrOk).length;
const fires = flat.filter(r => r.fired).length;

console.log(`\n=== id $${hx(ID)} pool $${hx(POOL_ID)} list ${LIST} chance=$${hx(CHANCE_VAL)} (${CHANCE_VAL}) ===`);
console.log(`battles=${ok}/${BATTLES} rounds=${RD} rolls=${flat.length} fires=${fires} -> ` +
            `${flat.length ? (100 * fires / flat.length).toFixed(1) : 'n/a'}%   (chance/128 = ${(100 * CHANCE_VAL / 128).toFixed(1)}%)`);
console.log(`counter cross-check: ${flat.length - bad}/${flat.length} rolls had $688A-1 == table index` + (bad ? `  ⛔ ${bad} MISMATCH` : '  ✅'));
console.log(`total RNG calls ${totalRng}, of which ${flat.length} were this roll (1 per ${(totalRng / (flat.length || 1)).toFixed(1)})`);

// ⭐ THE ACTUAL TEST. If the roll samples the table uniformly, the indices it
// visits should look like a uniform draw and their value distribution should
// match the whole table's. A stride shows up as (a) indices clustering in a
// residue class and (b) a repeating gap between consecutive indices.
console.log(`\n=== index residues (a stride k pins every roll into one column) ===`);
for (const k of [2, 3, 4, 5, 6, 7, 8]) {
  const cnt = Array(k).fill(0);
  for (const r of flat) cnt[r.idx % k]++;
  console.log(`  mod ${k}: ${cnt.join(' ')}`);
}

const gaps = [];
for (const battle of all) for (let i = 1; i < battle.length; i++) gaps.push((battle[i].idx - battle[i - 1].idx + 256) % 256);
const gapCount = new Map();
for (const g of gaps) gapCount.set(g, (gapCount.get(g) || 0) + 1);
const topGaps = [...gapCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n=== gap between consecutive roll indices (n=${gaps.length}) ===`);
console.log(`  ${topGaps.map(([g, n]) => `${g}:${n}`).join('  ')}${gapCount.size > 8 ? `  (+${gapCount.size - 8} more)` : ''}`);
console.log(`  distinct gaps=${gapCount.size}  mean=${gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : 'n/a'}`);

// Predicted rate from the indices actually visited. This MUST match the observed
// fire rate; if it does, the sampled subset fully explains the deviation and no
// further mechanism is needed.
const predicted = flat.filter(r => r.val < CHANCE_VAL).length;
const wholeTable = TABLE.filter(v => rollValue(v) < CHANCE_VAL).length;
console.log(`\n=== does the visited subset explain the rate? ===`);
console.log(`  observed fires          ${fires}/${flat.length} = ${flat.length ? (100 * fires / flat.length).toFixed(1) : 'n/a'}%`);
console.log(`  predicted from indices  ${predicted}/${flat.length} = ${flat.length ? (100 * predicted / flat.length).toFixed(1) : 'n/a'}%`);
console.log(`  whole 256-byte table    ${wholeTable}/256 = ${(100 * wholeTable / 256).toFixed(1)}%`);
const distinct = new Set(flat.map(r => r.idx));
console.log(`  distinct indices visited: ${distinct.size}/256`);

if (args.includes('--dump')) {
  console.log(`\nidx byte val fired`);
  for (const r of flat) console.log(`  ${String(r.idx).padStart(3)} $${hx(r.byte)} ${String(r.val).padStart(3)} ${r.fired ? 'FIRE' : '.'}`);
}
