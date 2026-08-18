#!/usr/bin/env node
// ff1-special-sweep.mjs — force every FF1 monster's special and read what it does.
//
// The FF3 sweep's sibling. FF1 keeps the special in STAT byte 7 (`$B2A6 CMP #$FF`,
// 0xFF = none; 46 of 128 monsters have one). This spawns each monster alone, keeps
// it alive long enough to act, and records EVERYTHING the battle says and does.
//
//   node tools/ff1-special-sweep.mjs --from 0 --to 8        # pilot
//   node tools/ff1-special-sweep.mjs --to 128 --json out.json
//
// ⭐ OBSERVATIONAL, NOT A CHECKLIST — the same design the FF3 sweep ended up with.
// Three filters, all MEASURED rather than hand-written: a baseline from a control
// run, glyph runs detected structurally, and monster names from the ROM. Every
// time a filter was hand-authored over there it hid real signal.
// ⭐ Splits / summons / calls-for-help all show up as the LIVE BODY COUNT rising.
//
// ⛔ Count bodies by MAX hp (`ENEMY_MAXHP_OFF`) — current hp is zero on a fresh
// spawn for slots the formation hasn't filled.
// ⛔ The monster MUST survive to act: in the FF3 pilot three monsters reported
// "no special" purely because the party killed them first, which is identical to
// really having none. HP is pinned every sample here for the same reason.
//
// ⭐ THREE HARNESS BUGS FIXED 2026-08-17, all measured, none of them game behaviour:
//  1. Current HP was poked at `ENEMY_RAM+13`, which is the NEXT monster's slot. The
//     real field is `ENEMY_CURHP_OFF` (-7); proven by poking it to 1 and watching
//     CHAOS die. Every "immortal" poke before this wrote into an unused record.
//  2. `RUN` on screen is NOT a liveness signal. The command menu is hidden for
//     ~780 frames while a round executes, then comes back. The old gate called that
//     BATTLE OVER — which is where "the fight ends by round 3" came from. The party
//     HP panel is what persists for the whole fight.
//  3. A round costs 12 A presses (4 characters x open-menu / pick-target / confirm,
//     measured in tools/ff1-menu-cursor.mjs), not the 5 this sent. Rounds are now
//     driven to completion and words are collected DURING execution, which is the
//     only window a special can appear in.

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
const FROM = Number(flag('from', '0')), TO = Number(flag('to', '8'));
const ROUNDS = Number(flag('rounds', '4'));
// A round executes in ~1040 frames once the party actually commits, so the old
// 8-round default is now ~10k frames per monster. Cap the wait rather than hang.
const ROUND_CAP = Number(flag('roundcap', '1800'));
const JSONOUT = flag('json', null);

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const PARTY_HP = 0x610A, PARTY_STRIDE = 0x40;

function probe(id) {
  const p = Uint8Array.from(rom);
  p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = id;          // spawn this one
  p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;       // exactly one
  const S = MN.STAT_TABLE + id * MN.STAT_STRIDE;
  // ⛔ HP ALONE IS NOT ENOUGH — FF1 stores monster HP in ONE byte, so the most
  // that can be given is 255 and the party still kills it in ~2 rounds. Raise
  // EVADE instead: it drives party damage to ZERO (measured, v1.8.56), so the
  // monster survives every round and actually gets to use its special.
  p[S + MN.STAT_FIELDS.hp[0]] = 0xFF; p[S + MN.STAT_FIELDS.hp[1]] = 0xFF;
  p[S + MN.STAT_FIELDS.evade] = 0xFF;
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
  const bodies = () => {
    let k = 0;
    for (let i = 0; i < 9; i++) {
      const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
      if ((c.mem[a + MN.ENEMY_MAXHP_OFF] | (c.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0) k++;
    }
    return k;
  };
  // ⭐ Pin EVERY occupied slot, not just slot 0 — a monster that splits or calls for
  // help puts new bodies in later slots, and those have to survive too.
  const immortal = () => {
    for (let i = 0; i < 4; i++) { c.mem[PARTY_HP + i * PARTY_STRIDE] = 0xE7; c.mem[PARTY_HP + i * PARTY_STRIDE + 1] = 0x03; }
    for (let i = 0; i < 9; i++) {
      const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
      if ((c.mem[a + MN.ENEMY_MAXHP_OFF] | (c.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) === 0) continue;
      c.mem[a + MN.ENEMY_CURHP_OFF] = 0xE7; c.mem[a + MN.ENEMY_CURHP_OFF + 1] = 0x03;
    }
  };
  // ⭐ TWO DIFFERENT SIGNALS, and confusing them cost eight probes.
  // `menuUp` = a character is taking a command. `onBattleScreen` = the fight exists
  // at all. The menu goes away for ~780 frames every round while it executes; the
  // battle screen does not.
  const menuUp = () => lines().some(l => /\bRUN\b/.test(l));
  const onBattleScreen = () => lines().filter(l => /\bHP\b/.test(l)).length >= 3;
  run(20);
  c.mem[0x27] = 150; c.mem[0x28] = 170;
  run(20);
  let started = false;
  for (let s = 0; s < 300 && !started; s++) {
    const b = D[Math.floor(s / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) started = true;
  }
  if (!started) return { id, ok: false };
  const words = new Set();
  const start = bodies();
  let peak = start;
  let acted = 0, frames = 0;
  const sample = () => {
    for (const l of lines()) for (const m of l.matchAll(/[A-Za-z][A-Za-z.']{2,}/g)) words.add(m[0]);
    peak = Math.max(peak, bodies());
    immortal();
  };
  for (let r = 0; r < ROUNDS; r++) {
    if (!onBattleScreen()) break;        // ⛔ the fight is genuinely gone
    immortal();
    // 4 characters x 3 presses. Gate each on the menu still being up so a press is
    // never fired into a screen that is not asking for one.
    for (let k = 0; k < 12 && menuUp() && onBattleScreen(); k++) {
      nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16);
    }
    // ⭐ The round now EXECUTES — this is the only window a special can appear in,
    // so sample throughout it rather than after it.
    acted++;
    let f = 0;
    while (f < ROUND_CAP && !menuUp() && onBattleScreen()) { run(10); f += 10; sample(); }
    frames += f;
  }
  return { id, ok: true, special: rom[S + MN.STAT_FIELDS.special], status: rom[S + MN.STAT_FIELDS.status],
           start, peak, multiplied: peak > start, rounds: acted, frames, words: [...words] };
}

const out = [];
const t0 = Date.now();
console.log('id   byte7  status  rounds  frames  peak  words seen');
// ⭐ --specials-only: 82 of 128 monsters have byte 7 = 0xFF and nothing to show, so
// a deep pass over just the 46 that DO carry a special costs a third of the time.
// ⛔ Four monsters (FrWOLF, VAMPIRE, PERILISK, IronGOL) reported NOTHING at 4 rounds
// and named specials at 20 — FROST, DAZZLE, SQUINT, TOXIC. Four rounds under-samples
// the roll, so any table built at that depth has soft nulls in it.
const SPECIALS_ONLY = args.includes('--specials-only');
for (let id = FROM; id < TO; id++) {
  if (SPECIALS_ONLY && rom[MN.STAT_TABLE + id * MN.STAT_STRIDE + MN.STAT_FIELDS.special] === MN.NO_SPECIAL) continue;
  const r = probe(id);
  out.push(r);
  if (!r.ok) { console.log(`${hx(id)}   —      —       (no battle)`); continue; }
  const sp = r.special === MN.NO_SPECIAL ? ' none' : hx(r.special);
  console.log(`${hx(id)}   ${sp}   ${hx(r.status)}   r${String(r.rounds).padStart(2)}  ${String(r.frames).padStart(6)}  ${r.multiplied ? `⭐${r.start}->${r.peak}` : r.peak}   ${r.words.slice(0, 10).join(' ')}`);
}
const secs = (Date.now() - t0) / 1000;
console.log(`\n${out.filter(r => r.ok).length}/${out.length} fought in ${secs.toFixed(0)}s ` +
            `(${(secs / out.length).toFixed(1)}s each -> ~${((secs / out.length) * 128 / 60).toFixed(0)} min for all 128)`);
if (JSONOUT) { fs.writeFileSync(JSONOUT, JSON.stringify(out, null, 1)); console.log(`wrote ${JSONOUT}`); }
