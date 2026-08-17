#!/usr/bin/env node
// ff3-special-sweep.mjs — force EVERY monster's special and read its name.
//
// WHY
// Record byte 14 (`spAtkIdx`) names which special a monster uses, but only EIGHT
// values were ever witnessed (0 Fire, 1 Blizzard, 2 Thunder, 3 Poison, 5 Glare+
// STONE, 8 Glare+Sleep, 32 Blind, 64 Flare). That is a sample, not a table, and
// `spAtkIdx` is absent from `src/data/monsters.js` entirely. This sweeps all 232.
//
//   node tools/ff3-special-sweep.mjs --from 0 --to 8       # pilot
//   node tools/ff3-special-sweep.mjs --from 0 --to 232 --json out.json
//
// HOW
//   * the monster is SPAWNED by repointing the freeroam formation (the same patch
//     `ff3-make-boss-state.mjs` uses), count forced to exactly one;
//   * ⛔ `spAtkRate` is raised to 0xFF first — byte 14 reads INERT otherwise, which
//     is what made it look like a dead field on the first pass;
//   * ⛔ the party is kept IMMORTAL — without it every probe saturates at 118 and
//     the party dies before the monster ever uses its special;
//   * the special's NAME is read off the battle strip, not inferred.
//
// ⭐⭐ IT IS OBSERVATIONAL, NOT A CHECKLIST. Splits and summons are only two of
// the things monsters do — they also flee, counter, drain, self-heal, multi-hit,
// petrify, transform, call for help and inflict a dozen statuses. So this does NOT
// test a list of behaviours I thought of in advance: it records EVERYTHING the
// battle says and does, subtracts a measured BASELINE (what every battle prints
// regardless), and leaves whatever is left as that monster's signature. The
// taxonomy comes out of the data instead of being decided before it.
// ⛔ An earlier version hardcoded a NOISE filter stripping Run|Flee|Died|Attack —
// those are BEHAVIOURS. Pre-filtering threw away the very thing being swept.
//
// ⭐ IT ALSO CATCHES SPLITS AND SUMMONS. Some monsters divide, and some call in
// reinforcements. Both show up the same measurable way: the number of LIVE enemy
// slots RISES above the one we spawned. The sweep records the peak count and every
// name seen, so a summoned species shows up by name even when it shares a slot.
//
// ⛔ WHAT THIS DOES NOT DO: capture animations. Monster attack ANIMATION frames
// need a PPU capture per monster, and many monsters render as garbage on the
// freeroam map because its sprite bundles don't include them. Names only.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as EN from './lib/ff3-encounters.mjs';
import * as M3 from './lib/ff3-monsters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const FROM = Number(flag('from', '0')), TO = Number(flag('to', '8'));
const JSONOUT = flag('json', null);
const ROUNDS = Number(flag('rounds', '10'));
// ⭐ --only-idx N: re-sweep just one byte-14 group. The 0x00 bucket is 131
// monsters that showed nothing but "Miss." in 6 rounds — which is either the
// genuine no-special default OR six rounds being too few. More rounds decides it.
const ONLY_IDX = (() => { const v = flag('only-idx', null); return v === null ? null : Number(v); })();

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SNAP = zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT, Controller.BUTTON_UP, Controller.BUTTON_DOWN];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const COUNT_INDEX = 7;
// ⛔ NO hand-written noise list — the baseline is MEASURED from a control run and
// subtracted, so nothing is discarded on a guess about what matters.
let BASELINE = new Set();

function probe(id) {
  const p = Uint8Array.from(rom);
  p[EN.SPECIES_TABLE + EN.SPECIES_ID_OFF] = id;
  for (let i = 1; i < EN.SPECIES_SLOTS; i++) p[EN.SPECIES_TABLE + EN.SPECIES_ID_OFF + i] = EN.SPECIES_EMPTY;
  p[EN.COUNT_TABLE + COUNT_INDEX * EN.COUNT_STRIDE] = 0x11;
  const P = M3.MONSTER_PROPS + id * M3.PROPS_STRIDE;
  p[P + M3.FIELDS.spAtkRate] = 0xFF;                  // ⛔ or byte 14 stays inert
  // ⛔ AND THE MONSTER MUST SURVIVE. On the first pilot ids 00/02/03 reported no
  // special at all — the party killed them before they ever acted, which reads
  // exactly like "this monster has no special". Give it enough HP to swing.
  p[P + M3.FIELDS.hp[0]] = 0xFF; p[P + M3.FIELDS.hp[1]] = 0xFF;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const c = nes.cpu;
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let col = 0; col < 32; col++) { const g = glyph(v[0x2000 + r * 32 + col]); s += (g === null ? ' ' : g); }
      out.push(s);
    }
    return out;
  };
  const immortal = () => {
    for (let i = 0; i < M3.PARTY_SLOTS; i++) {
      const a = M3.COMBATANT_BASE + i * M3.COMBATANT_STRIDE;
      c.mem[a] = 0xE7; c.mem[a + 1] = 0x03;            // 999 hp
    }
  };
  run(30);
  let started = false;
  for (let s = 0; s < 400 && !started; s++) {
    const b = D[Math.floor(s / 8) % 4];
    nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
    if ((c.mem[M3.enemyAddr(0)] | (c.mem[M3.enemyAddr(0) + 1] << 8)) > 0) started = true;
  }
  if (!started) return { id, ok: false };
  const liveEnemies = () => {
    let k = 0;
    for (let i = 0; i < 4; i++) {
      const a = M3.enemyAddr(i);
      if ((c.mem[a] | (c.mem[a + 1] << 8)) > 0) k++;
    }
    return k;
  };
  const words = new Set();
  const sample = () => {
    for (const l of lines()) for (const m of l.matchAll(/[A-Za-z][A-Za-z.']{2,}/g)) words.add(m[0]);
  };
  const partyHP = () => { let t = 0;
    for (let i = 0; i < M3.PARTY_SLOTS; i++) { const a = M3.slotAddr(i); t += c.mem[a] | (c.mem[a + 1] << 8); }
    return t; };
  const enemyHP = () => { const a = M3.enemyAddr(0); return c.mem[a] | (c.mem[a + 1] << 8); };
  const startCount = liveEnemies();
  // ⛔ A SELF-HEAL IS HP RISING BETWEEN CONSECUTIVE SAMPLES. An earlier version
  // flagged "max seen > current", which is just "it took damage" — it reported
  // HEALS for all 8 pilot monsters, including a Goblin.
  let peak = startCount, minParty = partyHP(), prevE = enemyHP(), healed = 0, ended = false;
  // ⛔ FF3 takes a command for ALL FOUR characters before the round resolves, so
  // one A-press per round resolves nothing — press through the whole party, and
  // SAMPLE THE STRIP DENSELY (it is overwritten within a few frames).
  for (let r = 0; r < ROUNDS; r++) {
    immortal();
    for (let k = 0; k < 6; k++) {
      nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A);
      for (let f = 0; f < 6; f++) {
        run(4); sample();
        peak = Math.max(peak, liveEnemies());
        const e = enemyHP();
        if (e > prevE) healed++;          // ⭐ rose since the last sample
        prevE = e;
        minParty = Math.min(minParty, partyHP());
        if (liveEnemies() === 0) ended = true;
      }
    }
  }
  return { id, ok: true, idx: rom[P + M3.FIELDS.spAtkIdx], rate: rom[P + M3.FIELDS.spAtkRate],
           startCount, peak, multiplied: peak > startCount,
           // ⭐ numeric behaviour alongside the text: self-heal shows as enemy HP
           // RISING, a flee/early end as ended-with-no-kill, damage as party drop.
           enemyHealed: healed > 0, healTicks: healed,
           partyDrop: minParty, ended,
           words: [...words] };
}

// ⭐ measure the baseline from a control monster FIRST, then subtract it.
const ctl = probe(FROM);
if (ctl.ok) BASELINE = new Set(ctl.words);
console.log(`baseline from id ${hx(FROM)}: ${BASELINE.size} common words subtracted\n`);

const out = [];
const t0 = Date.now();
console.log('id   byte14  rate  peak  behaviour   words BEYOND the baseline');
for (let id = FROM; id < TO; id++) {
  if (ONLY_IDX !== null && rom[M3.MONSTER_PROPS + id * M3.PROPS_STRIDE + M3.FIELDS.spAtkIdx] !== ONLY_IDX) continue;
  const r = probe(id);
  out.push(r);
  if (!r.ok) { console.log(`${hx(id)}   —       —    (no battle)`); continue; }
  const grew = r.multiplied ? `⭐${r.startCount}->${r.peak}` : `${r.peak}`;
  const uniq = r.words.filter(w => !BASELINE.has(w));
  const tags = [r.multiplied ? 'MULTIPLIES' : '', r.enemyHealed ? 'HEALS' : ''].filter(Boolean).join(' ');
  console.log(`${hx(id)}   ${hx(r.idx)}      ${hx(r.rate)}   ${grew.padEnd(5)} ${tags.padEnd(11)} ${uniq.slice(0, 8).join(' ') || '(baseline only)'}`);
}
const secs = (Date.now() - t0) / 1000;
console.log(`\n${out.filter(r => r.ok).length}/${out.length} fought in ${secs.toFixed(0)}s ` +
            `(${(secs / out.length).toFixed(1)}s each -> ~${((secs / out.length) * 232 / 60).toFixed(0)} min for all 232)`);
if (JSONOUT) { fs.writeFileSync(JSONOUT, JSON.stringify(out, null, 1)); console.log(`wrote ${JSONOUT}`); }
