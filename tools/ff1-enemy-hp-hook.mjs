#!/usr/bin/env node
// ff1-enemy-hp-hook.mjs — find the address FF1 actually decrements when the party
// damages a monster.
//
//   node tools/ff1-enemy-hp-hook.mjs               # monster $7F (CHAOS)
//   node tools/ff1-enemy-hp-hook.mjs --id 0x00 --rounds 2
//
// ⭐ WHY: the sweep keeps its monster alive by poking `ENEMY_RAM+13` (current HP),
// but that field was MEASURED unpopulated on a fresh spawn — so the poke almost
// certainly writes to something the battle code never reads. Everything downstream
// (does the monster survive long enough to use its special?) depends on knowing the
// real field. This finds it by watching the CPU instead of guessing offsets.
//
// ⛔ NO EVADE PATCH HERE. The sweep sets evade 0xFF to zero out party damage; this
// probe needs damage to LAND, so only HP is raised. FF1 stores monster HP in one
// byte, so the ceiling is 255 — enough to survive the rounds this drives.
//
// ⛔ INPUT COSTS 3 PRESSES PER CHARACTER (measured by tools/ff1-menu-cursor.mjs:
// open menu -> pick target -> confirm), so a full party round is 12 A presses, not
// the 5 the sweep sends. Rounds here are driven to completion, not counted by hope.
//
// ⭐ BANK IS CAPTURED WITH THE PC, never inferred. Four separate findings in this
// project were wrong because an address was recorded without the bank mapped at the
// time. Each reported PC carries a 16-byte signature matched back to ROM file
// offsets, so the bank is measured.

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
const ID = Number(flag('id', '0x7F'));
const ROUNDS = Number(flag('rounds', '2'));
// ⭐ SENTINEL, not a guess. Ranking raw decrements by frequency surfaced only the
// RNG scratch ($68AF-$68B6, written from the $AE09/$AE5D math routines) and the
// formation RAM copy at $6D84+ — 5238 decrements, none of them HP. Instead give the
// monster a distinctive HP value and watch which addresses HOLD it, then which of
// those MOVE. Holding it is not being it; only the ones that move are candidates.
const SENTINEL = Number(flag('hp', '227'));   // 0xE3 — rare byte, still < 256 (FF1 HP is one byte)

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
// countRange packs [min, max] into one byte's nibbles — 0x11 = exactly one.
const COUNT = Number(flag('count', '1'));
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = (COUNT << 4) | COUNT;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
p[S + MN.STAT_FIELDS.hp[0]] = SENTINEL & 0xFF; p[S + MN.STAT_FIELDS.hp[1]] = 0x00;

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
const inBattle = () => lines().some(l => /\bRUN\b/.test(l));
const cursorPresent = () => {
  const m = nes.ppu.spriteMem;
  for (let i = 0; i < 64; i++) if (m[i * 4] < 0xEF && m[i * 4 + 1] >= 0xF0 && m[i * 4 + 1] <= 0xF3) return true;
  return false;
};

// --- the hook --------------------------------------------------------------
// ⛔ cpu.write, NOT mmap.write — and reading the old value back through
// mmap.load is off by one byte (recorded trap), so cpu.mem is read directly.
let recording = false;
let watch = null;                 // Set of addresses holding the sentinel; null = watch all
const writes = [];
const origWrite = c.write.bind(c);
c.write = function (addr, val) {
  if (recording && addr >= 0x6000 && addr < 0x8000 && (!watch || watch.has(addr))) {
    const old = c.mem[addr];
    if (old !== val) writes.push({ addr, old, val, pc: c.REG_PC });
  }
  return origWrite(addr, val);
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
  if (inBattle()) started = true;
}
if (!started) { console.log('never reached a battle'); process.exit(1); }

const E = MN.ENEMY_RAM;
const rec = () => Array.from({ length: MN.ENEMY_RAM_STRIDE }, (_, i) => c.mem[E + i]);
const H = (a) => a.map(v => hx(v)).join(' ');
console.log(`monster $${hx(ID)}, HP sentinel ${SENTINEL} ($${hx(SENTINEL)})`);
console.log(`enemy record @ $${hx(E, 4)}: ${H(rec())}`);
// ⭐ WHICH SLOT is live is not a constant — the damaged address moved a full stride
// between a 1-monster and a 3-monster formation. The placement array is what says
// so; $FF means the slot is empty.
console.log(`placement @ $${hx(MN.ENEMY_PLACE_SLOTS, 4)}: ` +
  Array.from({ length: MN.ENEMY_PLACE_LEN }, (_, i) => hx(c.mem[MN.ENEMY_PLACE_SLOTS + i])).join(' '));

// ⭐ Every RAM byte currently holding the sentinel. One of these is live HP; the
// rest are the stat-record copy and whatever else got the value handed to it.
watch = new Set();
for (let a = 0x6000; a < 0x8000; a++) if (c.mem[a] === (SENTINEL & 0xFF)) watch.add(a);
console.log(`\n${watch.size} addresses hold $${hx(SENTINEL)} at battle start: ` +
  [...watch].map(a => `$${hx(a, 4)}${a >= E && a < E + 180 ? ` (record slot ${Math.floor((a - E) / 20)} +${(a - E) % 20})` : ''}`).join('  '));

const pressA = () => { nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16); };

// ⭐ --trace: is "no RUN on screen" actually "battle over"? The command menu is
// HIDDEN while a round executes (attack anims, damage messages), so a RUN-text
// check reports BATTLE OVER for a fight that is running fine. Sample across a long
// window and see whether RUN comes BACK — if it does, the liveness signal is wrong,
// and so is every conclusion built on it.
if (args.includes('--trace')) {
  for (let k = 0; k < 12 && inBattle(); k++) pressA();
  // ⛔ "nothing changed" is ambiguous between a hung CPU and a game waiting on
  // input. $68B3 is the RNG scratch the math routines stir constantly — if it
  // moves, emulation is live and the game wants a button. So: prove it's running,
  // and press A periodically to see whether the state is merely blocked.
  console.log('\nframe  RUN  cursor  rec+9  rng    press  first text line');
  let last = '';
  for (let f = 0; f < 1200; f += 10) {
    run(10);
    const pressed = (f % 60 === 0);
    if (pressed) pressA();
    const L = lines();
    const txt = L.filter(l => l.trim()).map(l => l.trim()).join(' | ').slice(0, 44);
    const sig = `${inBattle()}|${cursorPresent()}|${txt}`;
    if (sig !== last || pressed) {
      console.log(`${String(f).padStart(5)}  ${inBattle() ? 'yes' : ' NO'}  ${cursorPresent() ? 'yes   ' : 'none  '}  $${hx(c.mem[E + 9])}    $${hx(c.mem[0x68B3])}   ${pressed ? ' A ' : '   '}    ${txt}`);
      last = sig;
    }
  }
  process.exit(0);
}

// ⭐ --poke $ADDR=VAL — the control that decides which candidate IS the HP.
// The hook found TWO addresses carrying the identical trail 227->225->224 ($687C
// and $6BD5), so one is a working copy of the other. Holding the value proves
// nothing; the authoritative one is whichever CHANGES THE OUTCOME. Poking 1 should
// kill the monster on the next hit, and only the real field will do it.
const POKE = flag('poke', null);
let pokeAddr = null, pokeVal = 0;
if (POKE) {
  const [a, v] = POKE.split('=');
  pokeAddr = Number(a.replace('$', '0x')); pokeVal = Number(v);
}

// ⛔ THE RUN-TEXT CHECK IS NOT A LIVENESS SIGNAL. Measured with --trace: after the
// party commits, the command menu is hidden for ~780 frames while the round plays
// out, then RUN comes back and the fight continues. Every "battle over by round 3"
// result in this thread was that gap, not a dead monster. The battle SCREEN (the
// party HP panel) is what actually persists for the whole fight.
const battleScreen = () => lines().filter(l => /\bHP\b/.test(l)).length >= 3;
const waitForMenu = (cap = 1800) => {
  let f = 0;
  while (f < cap && !inBattle() && battleScreen()) { run(10); f += 10; }
  return f;
};

// Watch everything this time — the sentinel addresses took zero writes, so the
// live HP is not simply a copy of the stat byte.
watch = null;
const snap = () => c.mem.slice(0x6000, 0x8000);

for (let r = 0; r < ROUNDS; r++) {
  if (!battleScreen()) { console.log(`\n⛔ left the battle screen before round ${r + 1}`); break; }
  if (pokeAddr !== null) { c.mem[pokeAddr] = pokeVal; console.log(`\n[poke $${hx(pokeAddr, 4)} = ${pokeVal}]`); }
  for (let k = 0; k < 12 && inBattle(); k++) pressA();   // 4 chars x 3 presses
  const before = snap(), beforeRec = rec();
  recording = true;
  const frames = waitForMenu();                          // the round actually executing
  recording = false;
  const after = snap(), afterRec = rec();
  const changedRec = beforeRec.map((b, i) => [i, b, afterRec[i]]).filter(([, b, a]) => b !== a);
  let changedAll = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changedAll++;
  console.log(`\n=== round ${r + 1} — executed in ${frames} frames, ${inBattle() ? 'menu is back (fight continues)' : '⛔ battle screen gone'} ===`);
  console.log(`  record: ${H(afterRec)}`);
  console.log(`  changed record offsets: ${changedRec.length ? changedRec.map(([i, b, a]) => `+${i}: $${hx(b)}->$${hx(a)}`).join('  ') : 'none'}`);
  console.log(`  bytes changed in $6000-$7FFF: ${changedAll}   writes recorded: ${writes.length}`);
  console.log(`  $687C=${c.mem[0x687C]}  $6BD5=${c.mem[0x6BD5]} $6BD6=${c.mem[0x6BD6]}   ` +
              `monster on screen: ${lines().some(l => /CHAOS|Terminated/.test(l)) ? lines().filter(l => /CHAOS|Terminated/.test(l))[0].trim().slice(0, 40) : 'gone'}`);
}

// --- what looks like HP ----------------------------------------------------
// ⛔ Two regions are known noise and are excluded by MEASUREMENT, not by taste:
// $68AF-$68B6 is the scratch the $AE09/$AE5D math+random routines stir (652 writes
// in one round), and $6D84+ is the formation RAM copy refreshed every frame from
// $BF9E with a constant delta. Neither is per-monster state.
const noisy = (a) => (a >= 0x68A0 && a <= 0x68C0) || (a >= 0x6D84 && a < 0x6E00);
const byAddr = new Map();
for (const w of writes) {
  if (noisy(w.addr)) continue;
  if (!byAddr.has(w.addr)) byAddr.set(w.addr, []);
  byAddr.get(w.addr).push(w);
}
// ⭐ A damage target: the value goes DOWN, starts at or below the sentinel, and is
// written a handful of times per round — once per attacker, not once per frame.
const cands = [...byAddr.entries()]
  .map(([addr, ws]) => ({ addr, ws, drops: ws.filter(w => w.val < w.old).length, first: ws[0].old }))
  .filter(r => r.drops > 0 && r.first <= SENTINEL && r.first > 0 && r.ws.length <= 40)
  .sort((a, b) => (b.first === SENTINEL) - (a.first === SENTINEL) || b.drops - a.drops);

console.log(`\n${writes.length} writes to $6000-$7FFF (noise regions excluded), ` +
            `${cands.length} addresses look like a damage target\n`);
console.log('addr     writes  drops  value trail                          where             writer PCs');
for (const r of cands.slice(0, 20)) {
  const off = r.addr - E;
  const where = (off >= 0 && off < MN.ENEMY_RAM_STRIDE * 9)
    ? `slot ${Math.floor(off / MN.ENEMY_RAM_STRIDE)} +${off % MN.ENEMY_RAM_STRIDE}` : '—';
  const trail = [r.ws[0].old, ...r.ws.map(w => w.val)].slice(0, 10).join('->');
  const pcs = [...new Set(r.ws.map(w => w.pc))].map(v => '$' + hx(v, 4)).slice(0, 4).join(' ');
  const star = r.first === SENTINEL ? '⭐' : '  ';
  console.log(`${star}$${hx(r.addr, 4)}  ${String(r.ws.length).padStart(5)}  ${String(r.drops).padStart(5)}  ${trail.padEnd(35)}  ${where.padEnd(16)}  ${pcs}`);
}
const dec = cands.flatMap(r => r.ws).filter(w => w.val < w.old);

// --- bank for each writer PC, measured not inferred -------------------------
// ⭐ Read the 16 mapped bytes at the PC and find where they live in the ROM file.
// A unique hit gives the bank; multiple hits mean the signature is ambiguous and
// the answer is NOT established — say so rather than picking one.
const pcs = [...new Set(dec.map(w => w.pc))].slice(0, 12);
if (pcs.length) {
  console.log('\nwriter PC -> ROM bank (16-byte signature match)');
  for (const pc of pcs) {
    const sig = Array.from({ length: 16 }, (_, i) => c.mem[(pc + i) & 0xFFFF]);
    const hits = [];
    for (let o = 16; o + 16 <= rom.length; o++) {
      let ok = true;
      for (let i = 0; i < 16; i++) if (rom[o + i] !== sig[i]) { ok = false; break; }
      if (ok) { hits.push(o); if (hits.length > 4) break; }
    }
    const banks = hits.map(o => `bank ${Math.floor((o - 16) / 0x4000)} (file $${hx(o, 5)})`);
    console.log(`  $${hx(pc, 4)}  ${sig.slice(0, 6).map(hx).join(' ')}...  ${
      hits.length === 1 ? '⭐ ' + banks[0] : hits.length === 0 ? '⛔ no ROM match (RAM-resident code?)' : '⛔ AMBIGUOUS: ' + banks.join(', ')}`);
  }
}
