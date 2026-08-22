#!/usr/bin/env node
// ff3-level-party.mjs — level FF3's party up ON THE CARTRIDGE and save the
// state, so balance can be measured at more than the starting party.
//
//   node tools/ff3-level-party.mjs --level=8
//   node tools/ff3-level-party.mjs --level=8 --out=tools/states/ff3-lv8.state.gz
//
// WHY
// `ff3-fight-real.mjs` could only ever speak for the party the savestate held —
// four level-1 Onion Knights — and the level ladder in `docs/BALANCE.md` was
// therefore our simulator's guess. Reporting that as a limit was the wrong call:
// the ROM hands out the levels itself if you ask it properly.
//
// HOW — and the reason this is a MEASUREMENT and not a fabrication
// The Goblin's EXP payout is a ROM table (`MONSTER_EXP_ID` -> `MONSTER_EXP_VAL`,
// 2 bytes LE). Patch the Goblin's entry to 0xFFFF, win a battle, and the game
// awards the level itself — **FF3's own growth code writes the stats**. Nothing
// here invents an HP or a strength number; the only byte touched is a payout in
// a table this repo already decoded.
//
// ⛔ ONE LEVEL PER BATTLE. 65535 exp does NOT jump the party to 99 — the level-up
// is applied a level at a time, so reaching level N takes N-1 battles. Measured,
// not assumed: the loop below asserts the level byte moved and gives up if it
// stalls rather than spinning.
//
// ⛔ The saved state does NOT depend on the patch (same reasoning as
// `ff3-make-boss-state.mjs`): jsnes savestates carry RAM and mapper state, not
// the ROM. The script VERIFIES that by reloading the state against the clean ROM
// before writing it.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes')));
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const TARGET = Number(flag('level', '8'));
const IN = flag('in', path.join(HERE, 'states', 'ff3-freeroam.state.gz'));
const OUT = flag('out', path.join(HERE, 'states', `ff3-lv${TARGET}.state.gz`));

/** Party record block — measured (see docs/BALANCE.md). */
export const PARTY_REC = 0x6100, PARTY_STRIDE = 0x40;
/** ⭐ +0x01 is the LEVEL, stored zero-based: it reads 0 for a level-1 character. */
export const REC_LEVEL = 0x01;
export const REC_HP_CUR = 0x0C, REC_HP_MAX = 0x0E;
export const recAddr = (slot) => PARTY_REC + slot * PARTY_STRIDE;

const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

const p = Uint8Array.from(rom);
const expIdx = rom[M3.MONSTER_EXP_ID + 0];               // Goblin
const expOff = M3.MONSTER_EXP_VAL + expIdx * 2;
p[expOff] = 0xFF; p[expOff + 1] = 0xFF;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(p).toString('binary'));
nes.fromJSON(JSON.parse(zlib.gunzipSync(fs.readFileSync(IN)).toString('utf8')));
const cpu = nes.cpu;
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
const inBattle = () => lines().some((l) => /Guard|Item/i.test(l));
const w16 = (a) => cpu.mem[a] | (cpu.mem[a + 1] << 8);
const levels = () => [0, 1, 2, 3].map((i) => cpu.mem[recAddr(i) + REC_LEVEL] + 1);
const maxHp = () => [0, 1, 2, 3].map((i) => w16(recAddr(i) + REC_HP_MAX));

run(30);
console.log(`goblin exp payout patched at ROM 0x${expOff.toString(16)} -> 0xFFFF`);
console.log(`start: levels ${levels().join('/')}  maxHP ${maxHp().join('/')}`);

let battles = 0, stalled = 0;
while (Math.min(...levels()) < TARGET) {
  const before = levels()[0];
  let started = false;
  for (let s = 0; s < 400 && !started; s++) {
    const b = D[Math.floor(s / 8) % 4];
    nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
    started = inBattle();
  }
  if (!started) { console.error('no encounter fired — cannot continue'); process.exit(1); }
  // ⛔ mash PAST the victory banner: the exp and level-up dialogs need A too, and
  // the party record is not written until they are dismissed. Reading too early
  // shows "nothing changed" and looks like the patch did not work.
  let endedAt = -1;
  for (let k = 0; k < 900; k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(8);
    nes.buttonUp(1, Controller.BUTTON_A); run(18);
    if (endedAt < 0 && !inBattle()) endedAt = k;
    if (endedAt >= 0 && k > endedAt + 150) break;
  }
  run(120);
  battles++;
  const now = levels()[0];
  if (now === before) {
    if (++stalled >= 3) { console.error(`level stalled at ${now} after ${battles} battles`); process.exit(1); }
  } else stalled = 0;
  console.log(`  battle ${battles}: levels ${levels().join('/')}  maxHP ${maxHp().join('/')}`);
  if (battles > 200) { console.error('runaway'); process.exit(1); }
}

// ⛔ HEAL BEFORE SAVING. Levelling costs HP: max grows, CURRENT does not, so an
// unhealed level-8 state walks into its first fight on 25/20/16/26 and loses
// every battle — which reads exactly like "level 8 cannot beat this dungeon".
// It cost one wrong 0% before it was spotted. `+0x0C` is the measured current-HP
// field; this is the savestate equivalent of sleeping at an inn, not an invented
// stat.
for (const i of [0, 1, 2, 3]) {
  const a = recAddr(i);
  cpu.mem[a + REC_HP_CUR] = cpu.mem[a + REC_HP_MAX];
  cpu.mem[a + REC_HP_CUR + 1] = cpu.mem[a + REC_HP_MAX + 1];
}
const curHp = () => [0, 1, 2, 3].map((i) => w16(recAddr(i) + REC_HP_CUR));
console.log(`\nreached: levels ${levels().join('/')}  maxHP ${maxHp().join('/')} in ${battles} battles`);
console.log(`healed to full: curHP ${curHp().join('/')}`);
if (curHp().join('/') !== maxHp().join('/')) { console.error('heal did not take'); process.exit(1); }

// ⭐ VERIFY the state replays against the CLEAN rom — the patched payout must not
// be baked into what we ship.
const json = nes.toJSON();
const check = new NES({ onFrame: () => {}, onAudioSample: () => {} });
check.loadROM(Buffer.from(rom).toString('binary'));
check.fromJSON(JSON.parse(JSON.stringify(json)));
for (let i = 0; i < 60; i++) check.frame();
const cl = [0, 1, 2, 3].map((i) => check.cpu.mem[recAddr(i) + REC_LEVEL] + 1);
const cw = (a) => check.cpu.mem[a] | (check.cpu.mem[a + 1] << 8);
const ch = [0, 1, 2, 3].map((i) => cw(recAddr(i) + REC_HP_CUR));
if (cl.join('/') !== levels().join('/') || ch.join('/') !== maxHp().join('/')) {
  console.error(`state does not replay on the clean ROM: lv ${cl.join('/')} hp ${ch.join('/')}`);
  process.exit(1);
}
console.log(`verified against the UNPATCHED rom: levels ${cl.join('/')}  curHP ${ch.join('/')}`);
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify(json), 'utf8')));
console.log(`wrote ${OUT}`);
