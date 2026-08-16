#!/usr/bin/env node
// check-ff3-monsters.mjs — pin FF3's measured monster fields to a real battle.
//
// WHAT THIS HOLDS IN PLACE
//   ENEMY_CUR_HP   the live hp. ⛔ $7678 merely HOLDS hp at battle start and
//                  never moves; measuring damage there is what made an earlier
//                  pass conclude the party could not hurt a Goblin at all.
//   STAT_EVADE_OFF byte 0 of the `props +12` entry — drives damage to ZERO and
//                  makes the game print "Miss".
//   STAT_DEF_OFF   byte 2 of it — hits still LAND, damage floors above zero.
//
// The evade/defence pair is the part that needs a gate: nothing about the bytes
// themselves distinguishes them, only how the battle behaves. Swap the two
// offsets in the module and every one of these checks fails.
//
//   node tools/check-ff3-monsters.mjs
//
// ⛔ Slow — each assertion fights a real battle for 160 rounds. Budget ~10 min.
// ⛔ Nothing is hardcoded that the module also defines; the addresses and offsets
// under test are READ FROM the shipped module, so a revert really does fail.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');

const GOBLIN = 0;
const HP = 2000;          // enough that 160 rounds can never actually kill it
const ROUNDS = 160;
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

const defEntryAt = (id) =>
  M3.STAT_TABLE + rom[M3.MONSTER_PROPS + id * M3.PROPS_STRIDE + M3.VERIFIED_FIELDS.defEvdIdx]
  * M3.STAT_ENTRY;

/**
 * Fight a Goblin with the given ROM bytes patched, and report what happened:
 * damage dealt (at the LIVE hp address), whether the max copy moved at all, and
 * every hit/miss word the battle printed.
 */
function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  const props = M3.MONSTER_PROPS + GOBLIN * M3.PROPS_STRIDE;
  p[props + M3.VERIFIED_FIELDS.hp[0]] = HP & 0xFF;
  p[props + M3.VERIFIED_FIELDS.hp[1]] = HP >> 8;
  for (const [off, val] of Object.entries(patch)) p[Number(off)] = val;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
      if (s.trim()) out.push(s.replace(/\s+/g, ' ').trim());
    }
    return out;
  };
  const word16 = (a) => nes.cpu.mem[a] | (nes.cpu.mem[a + 1] << 8);

  run(30);
  let inBattle = false;
  for (let s = 0; s < 400; s++) {
    const b = D[Math.floor(s / 8) % 4];
    nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /Guard|Item/i.test(l))) { inBattle = true; break; }
  }
  if (!inBattle) return null;

  const cur0 = word16(M3.ENEMY_CUR_HP), load0 = word16(M3.ENEMY_RAM);
  let curLo = cur0, loadMoved = false, miss = 0, hit = 0;
  for (let k = 0; k < ROUNDS; k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(8);
    nes.buttonUp(1, Controller.BUTTON_A); run(18);
    const c = word16(M3.ENEMY_CUR_HP);
    if (c <= cur0 && c < curLo) curLo = c;
    if (word16(M3.ENEMY_RAM) !== load0) loadMoved = true;
    for (const l of lines()) {
      for (const _ of l.matchAll(/\bMiss\b/gi)) miss++;
      for (const _ of l.matchAll(/\b\d+xHit\b/gi)) hit++;
    }
  }
  return { dealt: cur0 - curLo, startHp: cur0, loadMoved, miss, hit };
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('FF3 monsters — measured fields, checked against a real battle\n');

const E = defEntryAt(GOBLIN);
console.log(`  Goblin defEvdIdx -> entry @0x${E.toString(16)} = [${M3.defEntry(rom, GOBLIN)}]\n`);

const base = fight();
if (!base) { console.error('the baseline battle never started'); process.exit(1); }

// ── the live hp address ────────────────────────────────────────────────────
ok('ENEMY_CUR_HP starts at the patched hp', base.startHp === HP, `${base.startHp}`);
ok('ENEMY_CUR_HP goes DOWN when the party attacks', base.dealt > 0, `dealt ${base.dealt}`);
ok('ENEMY_RAM is the load copy and never moves', !base.loadMoved);
ok('the party lands hits at baseline', base.hit > 0, `${base.hit} hits`);
ok('nothing MISSES at baseline', base.miss === 0, `${base.miss} misses`);

// ── evade: damage to zero, and the game says so ────────────────────────────
const ev = fight({ [E + M3.STAT_EVADE_OFF]: 0xFF });
ok('EVADE maxed drives damage to ZERO', ev && ev.dealt === 0, ev ? `dealt ${ev.dealt}` : 'no battle');
ok('EVADE maxed makes the game print "Miss"', ev && ev.miss > 0, ev ? `${ev.miss} misses` : '');

// ── defence: hits still land, damage merely floored ────────────────────────
const df = fight({ [E + M3.STAT_DEF_OFF]: 0xFF });
ok('DEFENCE maxed still lets the party HIT', df && df.hit > 0, df ? `${df.hit} hits` : 'no battle');
ok('DEFENCE maxed prints NO "Miss"', df && df.miss === 0, df ? `${df.miss} misses` : '');
ok('DEFENCE maxed floors damage ABOVE zero', df && df.dealt > 0, df ? `dealt ${df.dealt}` : '');
ok('DEFENCE maxed floors damage BELOW baseline', df && df.dealt < base.dealt,
   df ? `${df.dealt} vs ${base.dealt}` : '');

// ⭐ the discriminator. Defence and evade both cut damage, so "damage fell" pins
// neither. Only this separates them, and it is what fails if they are swapped.
ok('EVADE and DEFENCE are not the same byte', M3.STAT_EVADE_OFF !== M3.STAT_DEF_OFF);
ok('only EVADE causes misses', ev && df && ev.miss > 0 && df.miss === 0,
   ev && df ? `evade ${ev.miss} / defence ${df.miss}` : '');
ok('only DEFENCE leaves a nonzero floor', ev && df && ev.dealt === 0 && df.dealt > 0,
   ev && df ? `evade ${ev.dealt} / defence ${df.dealt}` : '');

// ── the duplicate-constant trap ────────────────────────────────────────────
// `gen-monsters-js.js` writes `src/data/monsters.js` off its OWN copies of these
// addresses. Two files holding the same address is how a correction lands in one
// and not the other, silently — so make them agree here.
const gen = fs.readFileSync(path.join(HERE, 'gen-monsters-js.js'), 'utf8');
for (const [name, want] of [['MONSTER_PROPS', M3.MONSTER_PROPS],
                            ['MONSTER_GIL', M3.MONSTER_GIL],
                            ['MONSTER_ATKSCR', M3.MONSTER_ATKSCR],
                            ['MONSTER_CP', M3.MONSTER_CP]]) {
  const m = gen.match(new RegExp(`^const ${name}\\s*=\\s*(0x[0-9a-fA-F]+)`, 'm'));
  ok(`gen-monsters-js.js agrees on ${name}`, m && Number(m[1]) === want,
     m ? `${m[1]} vs 0x${want.toString(16)}` : 'not found');
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
