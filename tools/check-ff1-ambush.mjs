#!/usr/bin/env node
// check-ff1-ambush.mjs — FF1 formation byte 12 bit 7 stays decoded as the ambush.
//
// With the bit set the battle opens "Monsters strike first", the party eats a free
// round, and only then does the menu appear. Three ways this decode can rot:
//
//   ⛔ calling byte 12 a palette field — it does move $3F08/$3F18-1B, but only
//      because an extra round happens first. The message is the real signal;
//   ⛔ calling it a surprise RATE and reading it as 0-255. Bits 0-6 are measured
//      inert; a rate reading invents 127 distinctions the game does not make;
//   ⛔ "confirming" it with trials that vary no RNG. The first pass here did
//      exactly that and got 6 identical runs that proved nothing.
//
//   node tools/check-ff1-ambush.mjs
//   node tools/check-ff1-ambush.mjs --prove-revert
//
// ⛔ ~12 real battles, ~45s. The message and the free round are invisible in ROM.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync('tools/states/ff1-world.state.gz');
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const REC = MN.FORMATION_TABLE;
const FULL = [35, 30, 33, 30];               // this party at full HP, read off the boxes

/**
 * Fight once. `variant` genuinely perturbs the walk (hold length, direction
 * period, pre-roll) so the encounter fires at a different step — without that,
 * repeated runs are the SAME run and prove nothing.
 */
function fight(byte12, variant = 0) {
  const p = Uint8Array.from(rom);
  p[REC + MN.FORMATION_AMBUSH_OFF] = byte12 & 0xFF;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const txt = () => {
    const q = nes.ppu.vramMem; let s = '';
    for (let r = 0; r < 30; r++) {
      for (let c = 0; c < 32; c++) { const g = F1.glyph(q[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      s += ' ';
    }
    return s.replace(/\s+/g, ' ');
  };
  const hold = 6 + (variant % 5), per = 4 + (variant % 7), pre = 20 + variant * 7;
  run(pre);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  let msg = null;
  for (let s = 0; s < 300; s++) {
    const b = D[Math.floor(s / per) % 2];
    nes.buttonDown(1, b); run(hold); nes.buttonUp(1, b); run(12);
    const t = txt();
    if (!msg && t.includes(MN.AMBUSH_MSG)) msg = MN.AMBUSH_MSG;
    if (!msg && t.includes(MN.PREEMPT_MSG)) msg = MN.PREEMPT_MSG;
    if (/\bRUN\b/.test(t)) {
      const m = nes.cpu.mem;
      const hp = [0, 1, 2, 3].map(i => m[MN.PARTY_HP + i * MN.PARTY_HP_STRIDE]
                                     | (m[MN.PARTY_HP + i * MN.PARTY_HP_STRIDE + 1] << 8));
      return { hp, msg, steps: s, hurt: hp.some((h, i) => h < FULL[i]) };
    }
  }
  return null;
}

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return cond;
};

console.log('FF1 formation byte 12 — the ambush flag\n');
const AMB = MN.FORMATION_AMBUSH_BIT;

// ── the message, which is the finding ───────────────────────────────────────
const off = fight(0x00), on = fight(AMB);
ok('both reach a battle', !!off && !!on);
ok(`bit 7 set opens "${MN.AMBUSH_MSG}"`, on && on.msg === MN.AMBUSH_MSG, on ? `${on.msg}` : '');
ok(`bit 7 clear does NOT`, off && off.msg !== MN.AMBUSH_MSG, off ? `${off.msg}` : '');
ok('bit 7 set costs the party HP before the first menu', on && on.hurt, on ? on.hp.join('/') : '');
ok('bit 7 clear leaves the party at full', off && !off.hurt, off ? off.hp.join('/') : '');

// ── ⭐ forced, not a rate — and the RNG must actually vary ──────────────────
const N = 4;
const trial = (v) => {
  let amb = 0, tot = 0; const steps = new Set();
  for (let k = 0; k < N; k++) {
    const r = fight(v, k);
    if (!r) continue;
    tot++; steps.add(r.steps);
    if (r.hurt) amb++;
  }
  return { amb, tot, distinct: steps.size };
};
const t0 = trial(0x00), t40 = trial(0x40), t80 = trial(AMB);
// ⛔ the control on the CONTROL: if the walk never varied, the counts below are
// one sample repeated and cannot support "always" or "never".
ok('the trials genuinely vary the RNG', t0.distinct > 1 && t80.distinct > 1,
   `${t0.distinct}/${t0.tot} and ${t80.distinct}/${t80.tot} distinct step-counts`);
ok('bit 7 set ambushes EVERY time', t80.amb === t80.tot && t80.tot === N, `${t80.amb}/${t80.tot}`);
ok('bit 7 clear ambushes NEVER', t0.amb === 0 && t0.tot === N, `${t0.amb}/${t0.tot}`);
ok('0x40 also never — so bits 0-6 are not a rate', t40.amb === 0 && t40.tot === N, `${t40.amb}/${t40.tot}`);

// ── the field wiring ────────────────────────────────────────────────────────
ok('byte 12 is off the unknown list', !MN.FORMATION_UNKNOWN_OFF.includes(MN.FORMATION_AMBUSH_OFF),
   `unknown = ${MN.FORMATION_UNKNOWN_OFF.join(',')}`);
ok('it does not collide with the species, count, palette or gfx fields',
   ![...MN.FORMATION_SPECIES_OFF, ...MN.FORMATION_COUNT_OFF, ...MN.FORMATION_PAL_OFF,
     MN.FORMATION_GFX_OFF].includes(MN.FORMATION_AMBUSH_OFF));

// ── ⭐ revert proof ─────────────────────────────────────────────────────────
if (args.includes('--prove-revert')) {
  console.log('\n  revert proof — the same bit on a NEIGHBOURING byte:');
  let survived = 0;
  for (const o of [11, 13]) {
    const p = Uint8Array.from(rom);
    // patch the neighbour instead, via the same path
    const saveOff = MN.FORMATION_AMBUSH_OFF;
    const r = (() => {
      const q = Uint8Array.from(rom); q[REC + o] = AMB;
      const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
      nes.loadROM(Buffer.from(q).toString('binary'));
      nes.fromJSON(JSON.parse(SNAP));
      const run = (k) => { for (let i = 0; i < k; i++) nes.frame(); };
      const txt = () => {
        const v = nes.ppu.vramMem; let s = '';
        for (let rr = 0; rr < 30; rr++) { for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + rr * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; } s += ' '; }
        return s.replace(/\s+/g, ' ');
      };
      run(20); nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170; run(20);
      let saw = false;
      for (let s = 0; s < 300; s++) {
        const b = D[Math.floor(s / 6) % 2];
        nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
        const t = txt();
        if (t.includes(MN.AMBUSH_MSG)) saw = true;
        if (/\bRUN\b/.test(t)) break;
      }
      return saw;
    })();
    console.log(`     byte ${o}: ${r ? '⛔ ALSO ambushes' : 'does not — good'}`);
    if (r) survived++;
    void p; void saveOff;
  }
  ok('only byte 12 carries the ambush bit', survived === 0);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
