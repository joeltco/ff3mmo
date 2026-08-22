#!/usr/bin/env node
// ff3-fight-real.mjs — fight a zone's formations ON THE CARTRIDGE and report
// who actually won.
//
// WHY THIS EXISTS
// `tools/zone-balance.mjs` answers the balance question with `battle-sim.js` —
// OUR re-implementation of FF3's combat math. That is a model, not a
// measurement, and it has already been wrong once in this arc (it was handed a
// Knight, a job the player cannot hold). The cartridge is the only thing that
// knows what FF3 does. So: patch the ROM so the encounter it rolls is the
// formation under test, then let the game fight it and read the corpses.
//
//   node tools/ff3-fight-real.mjs --zone=seals_cave_f1
//   node tools/ff3-fight-real.mjs --zone=altar_cave_f1 --battles=20
//   node tools/ff3-fight-real.mjs --formation=0x07 --battles=10 --trace
//
// HOW THE FORMATION IS FORCED
// The encounter roll is `group -> $94F0 + group*8 -> one of EIGHT slots picked
// by a weighted random`. Overwriting ALL EIGHT slots of the live map's group
// with the same formation id makes the roll deterministic without touching the
// roll itself — the random still runs, it just cannot matter. Species AND
// counts stay the cartridge's own.
//
// ⛔ THE PARTY IS WHATEVER THE STATE HAS. The default is FF3's actual starting
// party — four level-1 Onion Knights, 32 HP. `--state=tools/states/ff3-lv8.state.gz`
// fights the same formations with a level-8 party that the CARTRIDGE levelled
// (see `ff3-level-party.mjs`); always report which one a number came from.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { glyph } from './lib/ff3-text.mjs';
import * as M3 from './lib/ff3-monsters.mjs';
import * as ME from './lib/ff3-map-encounters.mjs';
import * as EN from './lib/ff3-encounters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes')));
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
// ⭐ --state picks the party. `ff3-level-party.mjs` builds levelled ones by
// patching the Goblin's EXP payout and letting FF3'S OWN growth code write the
// stats, so a ladder here is still the cartridge's arithmetic end to end.
const STATE = flag('state', path.join(HERE, 'states', 'ff3-freeroam.state.gz'));
const SNAP = zlib.gunzipSync(fs.readFileSync(STATE)).toString('utf8');
const BATTLES = Number(flag('battles', '12'));
const MAX_ROUNDS = Number(flag('rounds', '120'));
const TRACE = args.includes('--trace');

/** The party record block — measured, not assumed: see the header of this file. */
const PARTY_REC = 0x6100, PARTY_STRIDE = 0x40, REC_HP_CUR = 0x0C, REC_HP_MAX = 0x0E;

const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
  }
  return s.trim();
}
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);
const mname = (id) => { try { return nesText(getMonsterName(id)) || `0x${id.toString(16)}`; } catch { return `0x${id.toString(16)}`; } };

/**
 * Fight ONE battle of `formation`, seeded by `seed` frames of idle so the
 * cartridge's own RNG lands somewhere different each time.
 *
 * @returns {{outcome:'win'|'loss'|'unresolved', rounds:number, partyHp:number[],
 *            enemies:string, screen:string[]}}
 */
function fightOnce(formation, seed, group) {
  const p = Uint8Array.from(rom);
  // ⭐ every slot of the live map's group -> the formation under test.
  for (let s = 0; s < ME.GROUP_STRIDE; s++) p[ME.GROUP_TABLE + group * ME.GROUP_STRIDE + s] = formation;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const cpu = nes.cpu;
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
  const w16 = (a) => cpu.mem[a] | (cpu.mem[a + 1] << 8);
  const inBattle = () => lines().some((l) => /Guard|Item/i.test(l));

  run(30 + seed);
  let started = false;
  for (let s = 0; s < 400 && !started; s++) {
    const b = D[Math.floor(s / 8) % 4];
    nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
    started = inBattle();
  }
  if (!started) return { outcome: 'unresolved', rounds: 0, why: 'no encounter' };

  const occupied = [0, 1, 2, 3].filter((i) => w16(M3.enemyAddr(i) + M3.HP_MAX_OFF) > 0);
  // ⛔ THE SPECIES ID IS NOT IN THE COMBATANT RECORD at any offset I can claim.
  // A first pass read `enemyAddr(i) + 0x20` and confidently printed "Carbuncle"
  // for a formation the ROM says is Goblins. Use the expander's own output
  // instead — `$7D6B` is where it leaves the four species ids, which
  // `lib/ff3-encounters.mjs` measured — and cross-check against the name the
  // battle screen actually DRAWS.
  const species = [0, 1, 2, 3].map((n) => cpu.mem[EN.RAM_SPECIES + n]);
  const partyAlive = () => [0, 1, 2, 3].filter((i) => w16(M3.partyAddr(i)) > 0).length;
  const enemyAlive = () => occupied.filter((i) => w16(M3.enemyAddr(i)) > 0).length;
  const startParty = [0, 1, 2, 3].map((i) => w16(M3.partyAddr(i)));
  // The name the battle screen prints, as an independent witness to $7D6B.
  const drawnName = (lines().find((l) => /\d+\/ ?\d+/.test(l)) || '').split(/\s+/)[0] || '';

  let outcome = 'unresolved', rounds = 0;
  for (let k = 0; k < MAX_ROUNDS; k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(8);
    nes.buttonUp(1, Controller.BUTTON_A); run(18);
    rounds = k + 1;
    if (partyAlive() === 0) { outcome = 'loss'; break; }
    // ⛔ "all enemies at 0 hp" is not the end of a battle — the victory banner
    // and the exp/gil roll still have to run, and the party can still die to a
    // simultaneous blow. Confirm by leaving the battle menu behind.
    if (enemyAlive() === 0) { run(120); if (!inBattle()) { outcome = 'win'; break; } }
  }
  const named = species.filter((s2) => s2 !== EN.SPECIES_EMPTY).map(mname);
  return { outcome, rounds,
           partyHp: [0, 1, 2, 3].map((i) => w16(M3.partyAddr(i))),
           startParty, bodies: occupied.length,
           species: [...new Set(named)].join(' + ') || '(none)',
           drawn: drawnName,
           screen: lines() };
}

// ── what to fight ───────────────────────────────────────────────────────────
let plan = [];   // [{ formation, weight }]
let label = '';
const zoneKey = flag('zone', null);
const forced = flag('formation', null);

// The state's live map decides which group the patch has to overwrite.
const liveMap = (() => {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(rom).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 30; i++) nes.frame();
  return nes.cpu.mem[ME.MAP_ID_ZP];
})();
const GROUP = ME.groupForMap(rom, liveMap);

// ⛔ ECHO THE PARTY THE RUN ACTUALLY USED, read out of the state — never a label
// assumed from the filename. A harness that names a subject it did not use is
// how the last three balance claims went wrong.
const partyDesc = (() => {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(rom).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 30; i++) nes.frame();
  const m = nes.cpu.mem;
  const lv = [0, 1, 2, 3].map((i) => m[0x6100 + i * 0x40 + 0x01] + 1);
  const hp = [0, 1, 2, 3].map((i) => m[0x6100 + i * 0x40 + 0x0E] | (m[0x6100 + i * 0x40 + 0x0F] << 8));
  // ⛔ CURRENT hp, not just max — a levelled state that was never healed walks in
  // on a quarter bar and loses everything, and the max column hides it entirely.
  const cur = [0, 1, 2, 3].map((i) => m[0x6100 + i * 0x40 + 0x0C] | (m[0x6100 + i * 0x40 + 0x0D] << 8));
  return `4x Onion Knight lv ${lv.join('/')}, HP ${cur.join('/')} of ${hp.join('/')}`;
})();

if (forced !== null) {
  plan = [{ formation: Number(forced), weight: 64 }];
  label = `formation 0x${Number(forced).toString(16)}`;
} else if (zoneKey) {
  const { ENCOUNTERS } = await import('../src/data/encounters.js');
  const z = ENCOUNTERS.get(zoneKey);
  if (!z) { console.error(`no such zone: ${zoneKey}`); process.exit(2); }
  if (!z.rom || z.rom.group === undefined) { console.error(`${zoneKey} has no ROM group`); process.exit(2); }
  const slots = ME.slotsForGroup(rom, z.rom.group);
  const odds = ME.slotOdds(rom);
  const by = new Map();
  slots.forEach((f, i) => by.set(f, (by.get(f) || 0) + odds[i]));
  plan = [...by].map(([formation, weight]) => ({ formation, weight })).sort((a, b) => b.weight - a.weight);
  label = `${zoneKey} (ROM group 0x${z.rom.group.toString(16)})`;
} else { console.error('usage: --zone=<key> | --formation=0xNN'); process.exit(2); }

console.log(`FF3 REAL battles — ${label}`);
console.log(`party: ${partyDesc}  [${path.basename(STATE)}]`);
console.log(`(live map ${liveMap}, group 0x${GROUP.toString(16)} overwritten per battle)\n`);

let wWin = 0, wTotal = 0;
for (const { formation, weight } of plan) {
  let win = 0, loss = 0, unres = 0, saw = '', drawn = '';
  for (let b = 0; b < BATTLES; b++) {
    const r = fightOnce(formation, b * 7, GROUP);
    if (r.species) saw = `${r.species} x${r.bodies}`;
    if (r.drawn) drawn = r.drawn;
    if (r.outcome === 'win') win++;
    else if (r.outcome === 'loss') loss++;
    else unres++;
    if (TRACE) console.log(`    battle ${b}: ${r.outcome} in ${r.rounds} rounds  party ${r.startParty?.join('/')} -> ${r.partyHp?.join('/')}  vs ${r.species || r.why} x${r.bodies} [screen: ${r.drawn}]`);
  }
  const decided = win + loss;
  const rate = decided ? win / decided : 0;
  wWin += rate * weight; wTotal += weight;
  console.log(`  ${String(weight).padStart(2)}/64  formation 0x${formation.toString(16).padStart(2, '0')}  ` +
              `${saw.padEnd(30)} won ${win}/${decided}${unres ? ` (${unres} unresolved)` : ''}  ${(rate * 100).toFixed(0)}%`);
}
if (plan.length > 1)
  console.log(`\n  weighted: ${(wWin / wTotal * 100).toFixed(0)}% of encounters won by ${partyDesc}`);
