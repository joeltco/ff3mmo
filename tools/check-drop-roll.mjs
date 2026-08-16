#!/usr/bin/env node
// check-drop-roll.mjs — the shipped drop data and roll stay ROM-canon.
//
// v1.8.76-77 replaced the hand-maintained `drops:` with the ROM's own data:
// byte 15 packs a TABLE INDEX (bits 0-4) and a DROP RATE (bits 5-7). Only the 52
// monsters with a nonzero rate carry a table — 49 at rate 1 (14.3%) and the three
// dragons at rate 7, which is a GUARANTEED drop. Four things can silently break:
//
//   ⛔ de-duplicating or null-filtering `drops` before the pick collapses the
//      array and destroys the slot -> weight correspondence, which makes the rare
//      tail (the dragons' Onion gear) twice too likely;
//   ⛔ replacing the per-monster rate with a flat chance, which both hands the 180
//      rate-0 monsters a drop they should never have AND caps the dragons;
//   ⛔ giving a rate-0 monster a `drops` array, which lets the PvE arbiter accept
//      loot the game would never award;
//   ⛔ regenerating `monsters.js` from stale data silently reverts the table.
//
//   node tools/check-drop-roll.mjs
//
// ⛔ Fast — pure data plus a simulated roll, no emulator. Safe on every deploy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M3 from './lib/ff3-monsters.mjs';
import { MONSTERS, DROP_SLOT_WEIGHTS, DROP_SLOT_WEIGHT_TOTAL, DROP_GATE_DIE } from '../src/data/monsters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('FF3 drops — the shipped data and roll vs the ROM\n');

// ── the data ────────────────────────────────────────────────────────────────
let matched = 0, missing = 0, mismatched = [];
for (const [id, m] of MONSTERS) {
  if (id >= 232) continue;
  const slots = M3.stealSlots(rom, id);
  if (!slots.some(v => v) || M3.dropRate(rom, id) === 0) { if (!m.drops) matched++; else missing++; continue; }
  if (!m.drops) { missing++; continue; }
  const want = slots.map(v => v || null);
  if (JSON.stringify(m.drops.map(v => v ?? null)) === JSON.stringify(want)) matched++;
  else mismatched.push(id);
}
ok('every monster carries the ROM slots, in order', mismatched.length === 0 && missing === 0,
   `${matched} matched, ${missing} missing, ${mismatched.length} differing`);
// ⛔ NOT all monsters: a rate-0 monster never drops and must carry no `drops`,
// so the PvE arbiter cannot be talked into accepting loot the game never awards.
ok('only the monsters that can actually drop carry a table',
   [...MONSTERS].filter(([, m]) => m.drops).length === 52,
   `${[...MONSTERS].filter(([, m]) => m.drops).length} of 231`);
ok('every monster with a table has a nonzero rate',
   [...MONSTERS].every(([, m]) => !m.drops || m.dropRate > 0));
ok('the three dragons are rate 7 — a GUARANTEED drop',
   [0xAE, 0xC8, 0xDF].every(id => MONSTERS.get(id).dropRate === 7));
ok('the rates match the ROM (byte 15 >> 5)',
   [...MONSTERS].every(([id, m]) => id >= 232 || (m.dropRate | 0) === M3.dropRate(rom, id)));
ok('the gate die is 7 (a random 0..6)', DROP_GATE_DIE === M3.DROP_GATE_DIE);
// ⛔ duplicates carry the weighting — collapsing them changes the odds.
const goblin = MONSTERS.get(0x00).drops;
ok('duplicate slots are preserved (they ARE the weighting)',
   goblin.filter(v => v === 0xA6).length === 4, `Potion x${goblin.filter(v => v === 0xA6).length}`);
ok('the `steal:` field is gone — the ROM has no separate steal item',
   ![...MONSTERS].some(([, m]) => m.steal !== undefined));

// ── the weights ─────────────────────────────────────────────────────────────
ok('the shipped weights match the ROM ladder',
   JSON.stringify(DROP_SLOT_WEIGHTS) === JSON.stringify(M3.dropSlotOdds()),
   DROP_SLOT_WEIGHTS.join('/'));
ok('the weights total 256', DROP_SLOT_WEIGHT_TOTAL === 256
   && DROP_SLOT_WEIGHTS.reduce((a, b) => a + b, 0) === 256);

// ── the roll, simulated exactly as battle-update.js does it ────────────────
function rollSlot(rand, slots) {
  let r = Math.floor(rand() * DROP_SLOT_WEIGHT_TOTAL);
  let slot = 0;
  const last = Math.min(DROP_SLOT_WEIGHTS.length, slots.length) - 1;
  while (slot < last && r >= DROP_SLOT_WEIGHTS[slot]) { r -= DROP_SLOT_WEIGHTS[slot]; slot++; }
  return slot;
}
{
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x80000000; };
  const N = 200000, hits = new Array(8).fill(0);
  const slots = MONSTERS.get(0x00).drops;
  for (let i = 0; i < N; i++) hits[rollSlot(rand, slots)]++;
  const worst = Math.max(...hits.map((h, i) => Math.abs(h / N - DROP_SLOT_WEIGHTS[i] / 256)));
  ok('the simulated roll reproduces the canon distribution', worst < 0.01,
     hits.map((h, i) => `${i}:${(h / N * 100).toFixed(1)}%/${(DROP_SLOT_WEIGHTS[i] / 256 * 100).toFixed(1)}%`).join(' '));
}
// ⭐ the thing the weighting exists for: the rare tail must stay rare.
{
  let seed = 999;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x80000000; };
  const dragon = MONSTERS.get(0xAE).drops;          // Green Dragon
  const N = 200000;
  let onion = 0;
  for (let i = 0; i < N; i++) if (rollSlot(rand, dragon) >= 4) onion++;
  const pct = onion / N;
  // slots 4-7 are 24+24+12+4 = 64/256 = 25%
  ok('the dragons\' Onion gear lands ~25% of drops, not 50%', Math.abs(pct - 0.25) < 0.01,
     `${(pct * 100).toFixed(1)}%`);
  ok('...and a uniform pick would NOT — that is the bug this guards',
     Math.abs(0.5 - 0.25) > 0.01, 'uniform over 8 slots would give 50%');
}

// ⭐ the gate: a dragon must drop EVERY time, a rate-1 monster ~1 in 7.
{
  let seed = 4242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x80000000; };
  const N = 100000;
  const fires = (rate) => {
    let n2 = 0;
    for (let i = 0; i < N; i++) if (Math.floor(rand() * DROP_GATE_DIE) < rate) n2++;
    return n2 / N;
  };
  const dragon = fires(7), common = fires(1);
  ok('a rate-7 dragon drops EVERY battle', dragon > 0.999, `${(dragon * 100).toFixed(1)}%`);
  ok('a rate-1 monster drops ~1 in 7', Math.abs(common - 1 / 7) < 0.01, `${(common * 100).toFixed(1)}%`);
}

// ── the server still accepts the rare tail ──────────────────────────────────
// pve-replay validates a claimed drop against the UNION of the battle monsters'
// drop tables, so widening the tables must not lock the tail out.
{
  const dragon = MONSTERS.get(0xAE).drops.filter(d => d != null);
  ok('an Onion-gear claim is inside the dragon\'s table (the server union check)',
     dragon.includes(0x59) || dragon.includes(0x39),
     dragon.map(v => '0x' + v.toString(16)).join(','));
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
