#!/usr/bin/env node
// check-ff3-monster-fields.mjs — the rest of FF3's 16-byte monster record.
//
// `check-ff3-monsters.mjs` holds HP, attack, defence and evade. This holds the
// fields that needed better instruments to reach at all:
//
//   AN IMMORTAL PARTY — topped back up to 999 hp every round, so damage taken is
//   a gradient. Without it every probe saturates at 118 (the party's total hp)
//   and every field reads as inert. That is not hypothetical: it is exactly what
//   a first pass concluded.
//
//   ELEMENTAL WEAPONS — an item id poked into the party's weapon slots makes
//   their ordinary attacks elemental, so weakness and resistance can be measured
//   without giving anybody magic.
//
// Most claims here are read off the battle screen BY NAME, which is far harder to
// fake than a number: "STONE" appears when bit 0x40 is set and does not when it
// is not.
//
//   node tools/check-ff3-monster-fields.mjs
//
// ⛔ Slow — every assertion fights a real battle. Budget ~25 min.
// ⛔ Offsets and bit values come FROM the shipped module, so a revert really does
// fail rather than quietly testing a hardcoded copy of itself.

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

const P = M3.MONSTER_PROPS;          // Goblin, bestiary id 0
const TOP = 999;                     // what the party is held at
const ROUNDS = 100;
const ICE_SWORD = 0x3B, FLAME_SWORD = 0x3A, STATUS_ROD = 0x0D;
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
           Controller.BUTTON_UP, Controller.BUTTON_DOWN];

/**
 * Fight the Goblin. `patch` goes into the ROM, `weapon` into both of the party's
 * measured weapon slots, and the party is kept alive so damage stays a gradient.
 */
function fight({ patch = {}, weapon = null, immortal = false, rounds = ROUNDS } = {}) {
  const p = Uint8Array.from(rom);
  p[P + M3.FIELDS.hp[0]] = 0xFF; p[P + M3.FIELDS.hp[1]] = 0x0F;   // unkillable
  for (const [off, val] of Object.entries(patch)) p[Number(off)] = val;

  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  try {
    nes.loadROM(Buffer.from(p).toString('binary'));
    nes.fromJSON(JSON.parse(SNAP));
  } catch { return null; }
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
  const w = (a) => nes.cpu.mem[a] | (nes.cpu.mem[a + 1] << 8);
  const setw = (a, v) => { nes.cpu.mem[a] = v & 0xFF; nes.cpu.mem[a + 1] = v >> 8; };
  const arm = () => {
    if (weapon === null) return;
    for (let i = 0; i < 4; i++) {
      for (const s of M3.WEAPON_SLOTS) nes.cpu.mem[M3.PARTY_B_BLOCK + i * M3.PARTY_B_STRIDE + s] = weapon;
    }
  };

  try {
    run(30); arm();
    let inBattle = false;
    for (let s = 0; s < 400; s++) {
      arm();                                   // ...before the battle caches it
      const b = D[Math.floor(s / 8) % 4];
      nes.buttonDown(1, b); run(10); nes.buttonUp(1, b); run(12);
      if (lines().some(l => /Guard|Item/i.test(l))) { inBattle = true; break; }
    }
    if (!inBattle) return null;

    const top = () => { for (let i = 0; i < 4; i++) { setw(M3.partyAddr(i), TOP); setw(M3.partyAddr(i) + M3.HP_MAX_OFF, TOP); } };
    if (immortal) top();
    const e0 = w(M3.ENEMY_CUR_HP);
    let eLo = e0, taken = 0;
    const words = new Set();
    for (let k = 0; k < rounds; k++) {
      nes.buttonDown(1, Controller.BUTTON_A); run(8);
      nes.buttonUp(1, Controller.BUTTON_A); run(18);
      if (immortal) {
        for (let i = 0; i < 4; i++) { const h = w(M3.partyAddr(i)); if (h < TOP) taken += TOP - h; }
        top();
      }
      const e = w(M3.ENEMY_CUR_HP); if (e <= e0 && e < eLo) eLo = e;
      for (const l of lines()) for (const m of l.matchAll(/[A-Za-z][A-Za-z.']{2,}/g)) words.add(m[0]);
    }
    return { dealt: e0 - eLo, taken, words: [...words] };
  } catch { return null; }
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};
const said = (r, word) => !!r && r.words.includes(word);

console.log('FF3 monster record — the fields that needed a better instrument\n');

// ── the special: rate gates it, index names it ─────────────────────────────
console.log('the special attack');
const quiet = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0 } });
const loud = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF } });
ok('rate 0 — the special never appears', quiet && !said(quiet, 'Fire'));
ok('rate 255 — it casts Fire every turn', said(loud, 'Fire'));
// ⛔ spAtkIdx is INERT unless the rate is raised first. Testing it alone reads as
// "no effect" for every id, which is how it stayed unlabelled.
for (const [idx, want] of [[1, 'Blizzard'], [2, 'Thunder']]) {
  const r = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF, [P + M3.FIELDS.spAtkIdx]: idx } });
  ok(`spAtkIdx ${idx} makes it cast ${want}`, said(r, want));
  ok(`...and NOT ${M3.SPECIAL_NAMES[0]}`, r && !said(r, 'Fire'));
}

// ── status on attack: each bit names itself ────────────────────────────────
console.log('\nstatus-on-attack — each bit names itself on screen');
for (const bit of [0x08, 0x40]) {
  const want = M3.STATUS_BITS[bit];
  const on = fight({ patch: { [P + M3.FIELDS.statusOnAtk]: bit }, immortal: true });
  const off = fight({ patch: { [P + M3.FIELDS.statusOnAtk]: 0 }, immortal: true });
  ok(`bit 0x${bit.toString(16)} makes the screen say "${want}"`, said(on, want));
  ok(`...and it does NOT say it with the bit clear`, off && !said(off, want));
}

// ── weakness and resistance: same bit, same element, opposite direction ─────
console.log('\nweakness doubles, resistance halves, and the bits agree');
const iceBase = fight({ weapon: ICE_SWORD });
const flameBase = fight({ weapon: FLAME_SWORD });
ok('an ice weapon and a flame weapon hit for the same baseline',
   iceBase && flameBase && Math.abs(iceBase.dealt - flameBase.dealt) < iceBase.dealt * 0.35,
   iceBase && flameBase ? `${iceBase.dealt} vs ${flameBase.dealt}` : 'no battle');

const ICE = M3.ELEM_BITS.ice, FIRE = M3.ELEM_BITS.fire;
const wIce = fight({ weapon: ICE_SWORD, patch: { [P + M3.FIELDS.weakness]: ICE } });
const wIceF = fight({ weapon: FLAME_SWORD, patch: { [P + M3.FIELDS.weakness]: ICE } });
ok('weakness ICE roughly DOUBLES an ice weapon', wIce && wIce.dealt > iceBase.dealt * 1.6,
   wIce ? `${iceBase.dealt} -> ${wIce.dealt}` : '');
// ⭐ the discriminator: a weakness bit must be inert against the OTHER element,
// or "the number went up" would pin no bit in particular.
ok('...and leaves a FLAME weapon alone', wIceF && wIceF.dealt < flameBase.dealt * 1.4,
   wIceF ? `${flameBase.dealt} -> ${wIceF.dealt}` : '');

const rIce = fight({ weapon: ICE_SWORD, patch: { [P + M3.FIELDS.elemResist]: ICE } });
const rIceF = fight({ weapon: FLAME_SWORD, patch: { [P + M3.FIELDS.elemResist]: ICE } });
ok('resist ICE roughly HALVES an ice weapon', rIce && rIce.dealt < iceBase.dealt * 0.7,
   rIce ? `${iceBase.dealt} -> ${rIce.dealt}` : '');
ok('...and leaves a FLAME weapon alone', rIceF && rIceF.dealt > flameBase.dealt * 0.75,
   rIceF ? `${flameBase.dealt} -> ${rIceF.dealt}` : '');
const wFire = fight({ weapon: FLAME_SWORD, patch: { [P + M3.FIELDS.weakness]: FIRE } });
ok('the FIRE bit does for flame what the ICE bit did for ice',
   wFire && wFire.dealt > flameBase.dealt * 1.6, wFire ? `${flameBase.dealt} -> ${wFire.dealt}` : '');
// the non-elemental bit cuts a weapon carrying NO element at all
const plain = fight({});
const rPhys = fight({ patch: { [P + M3.FIELDS.elemResist]: M3.ELEM_BITS.physical } });
ok('the 0x02 bit cuts the plain STARTING weapons — it is not an element',
   plain && rPhys && rPhys.dealt < plain.dealt * 0.7, plain && rPhys ? `${plain.dealt} -> ${rPhys.dealt}` : '');

// ── status resistance ──────────────────────────────────────────────────────
console.log('\nstatus resistance');
const petrify = fight({ weapon: STATUS_ROD });
const blocked = fight({ weapon: STATUS_ROD, patch: { [P + M3.FIELDS.statusResist]: 0x01 } });
ok('a status rod petrifies the Goblin outright', said(petrify, 'STONE'));
ok('statusResist 0x01 blocks it', blocked && !said(blocked, 'STONE'));
ok('...and the blocked fight deals far less damage',
   petrify && blocked && blocked.dealt < petrify.dealt * 0.5,
   petrify && blocked ? `${petrify.dealt} -> ${blocked.dealt}` : '');

// ── the nibble-packed fields ───────────────────────────────────────────────
// ⭐ This is the part a coarse sweep cannot see. Each of these bytes ignores one
// of its nibbles completely, so 0x0F and 0xF0 must NOT behave the same.
console.log('\nnibble-packed fields — one nibble drives, the other is inert');
const flat = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF }, immortal: true });
for (const off of M3.LOW_NIBBLE_FIELDS) {
  const lo = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF, [P + off]: 0x0F }, immortal: true });
  const hi = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF, [P + off]: 0xF0 }, immortal: true });
  ok(`byte ${off}: the LOW nibble raises the damage`, lo && lo.taken > flat.taken * 1.5,
     lo ? `${flat.taken} -> ${lo.taken}` : '');
  ok(`byte ${off}: the HIGH nibble does nothing`, hi && Math.abs(hi.taken - flat.taken) < flat.taken * 0.15,
     hi ? `${flat.taken} -> ${hi.taken}` : '');
}
for (const off of M3.HIGH_NIBBLE_FIELDS) {
  const lo = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF, [P + off]: 0x0F }, immortal: true });
  const hi = fight({ patch: { [P + M3.FIELDS.spAtkRate]: 0xFF, [P + off]: 0x30 }, immortal: true });
  ok(`byte ${off}: the LOW nibble does nothing`, lo && Math.abs(lo.taken - flat.taken) < flat.taken * 0.15,
     lo ? `${flat.taken} -> ${lo.taken}` : '');
  ok(`byte ${off}: the HIGH nibble raises the damage`, hi && hi.taken > flat.taken * 1.2,
     hi ? `${flat.taken} -> ${hi.taken}` : '');
}

// ⛔ these are NOT claims about what the bytes do — they record that nothing
// moved them, so a later pass does not re-run the same dead ends.
console.log('\nstill not isolated (recorded, not claimed)');
ok('byte 6, 8 and 15 are listed as NOT isolated',
   JSON.stringify(Object.values(M3.NOT_ISOLATED)) === JSON.stringify([6, 8, 15]),
   JSON.stringify(Object.values(M3.NOT_ISOLATED)));

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
