#!/usr/bin/env node
// check-ff1-formation-gfx.mjs — FF1 formation byte 1 stays decoded.
//
// Byte 1 is the monster SIZE / LAYOUT class and only its low TWO bits are live:
// bit 1 swaps the monster ART (same species, same name, same palette — imps draw
// as wolves), bit 0 swaps the SLOT LAYOUT (9-slot two-column grid -> 3 in one
// column). Three things can silently break the decode:
//
//   ⛔ treating byte 1 as a palette field — it repaints 23 of 32 palette slots,
//      which is exactly what a palette field would do, and it is not one: the
//      TILES change. Only the nametable separates those two readings;
//   ⛔ widening the mask past 0x03 — bits 2-7 are measured inert, so code that
//      reads byte 1 as a 0-255 value invents distinctions the game does not make;
//   ⛔ folding byte 1 back into FORMATION_UNKNOWN_OFF.
//
//   node tools/check-ff1-formation-gfx.mjs
//   node tools/check-ff1-formation-gfx.mjs --prove-revert
//
// ⛔ SLOW-ish: 8 real battles, ~30s. Every assertion has to FIGHT — none of this
// is visible in the ROM bytes alone.

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const STATE = 'tools/states/ff1-world.state.gz';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync(STATE);
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const REC = MN.FORMATION_TABLE;
const sha = (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 8);

function fight(patch = {}) {
  const p = Uint8Array.from(rom);
  for (const [o, v] of Object.entries(patch)) p[REC + Number(o)] = v & 0xFF;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const lines = () => {
    const v = nes.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = F1.glyph(v[0x2000 + r * 32 + c]); s += (g === null || g === '\n') ? ' ' : g; }
      out.push(s);
    }
    return out;
  };
  run(20);
  nes.cpu.mem[0x27] = 150; nes.cpu.mem[0x28] = 170;
  run(20);
  for (let s = 0; s < 300; s++) {
    const b = D[Math.floor(s / 6) % 2];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
    if (lines().some(l => /\bRUN\b/.test(l))) {
      run(30);
      const m = nes.cpu.mem;
      const place = [...m.slice(MN.ENEMY_PLACE_SLOTS, MN.ENEMY_PLACE_SLOTS + MN.ENEMY_PLACE_LEN)];
      const attr = [...m.slice(MN.ENEMY_PLACE_ATTR, MN.ENEMY_PLACE_ATTR + MN.ENEMY_PLACE_LEN)];
      let bodies = 0;
      for (let i = 0; i < 9; i++) {
        const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
        if ((m[a + MN.ENEMY_MAXHP_OFF] | (m[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0) bodies++;
      }
      return {
        bodies, place, attr,
        placed: place.filter(v => v !== MN.ENEMY_PLACE_EMPTY).length,
        ntHash: sha([...nes.ppu.vramMem.slice(0x2000, 0x23C0)]),
        pal: [...nes.ppu.vramMem.slice(0x3F00, 0x3F20)],
      };
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

console.log('FF1 formation byte 1 — the size/layout class\n');
const OFF = MN.FORMATION_GFX_OFF;
const base = fight();
if (!base) { console.error('⛔ the unpatched formation never reached a battle'); process.exit(1); }
console.log(`  baseline: ${base.bodies} bodies, ${base.placed} slots placed, nt ${base.ntHash}\n`);

// ── bits 2-7 are inert ──────────────────────────────────────────────────────
const deadBits = [0x04, 0x20, 0x80];
let inert = true;
for (const v of deadBits) {
  const r = fight({ [OFF]: v });
  if (!r || r.ntHash !== base.ntHash || r.bodies !== base.bodies) inert = false;
}
ok(`bits outside the mask 0x${MN.FORMATION_GFX_MASK.toString(16)} are inert`, inert,
   `tested 0x${deadBits.map(v => v.toString(16)).join(' 0x')}`);

// ── bit 1: alternate ART, same everything else ──────────────────────────────
const art = fight({ [OFF]: MN.FORMATION_GFX_ALT_ART });
ok('bit 1 reaches a battle', !!art);
if (art) {
  ok('bit 1 flips the per-slot art attribute to 0x80',
     art.attr.some(v => v === MN.ALT_ART_ATTR) && !base.attr.some(v => v === MN.ALT_ART_ATTR),
     `[${art.attr.map(v => v.toString(16)).join(' ')}]`);
  ok('bit 1 changes WHICH TILES are drawn', art.ntHash !== base.ntHash);
  // ⭐ the discriminator against "byte 1 is a palette field"
  ok('...while leaving the PALETTE untouched — so it is not a palette field',
     art.pal.every((v, i) => v === base.pal[i]));
  ok('...and the same bodies are still on the field', art.bodies === base.bodies,
     `${art.bodies} vs ${base.bodies}`);
  ok('...and the placement slots are unchanged',
     JSON.stringify(art.place) === JSON.stringify(base.place));
}

// ── bit 0: alternate LAYOUT ─────────────────────────────────────────────────
const lay = fight({ [OFF]: MN.FORMATION_GFX_ALT_LAYOUT });
ok('bit 0 with the formation\'s own counts places NOTHING', lay && lay.placed === 0,
   lay ? `[${lay.place.map(v => v.toString(16)).join(' ')}]` : 'no battle');
// ⛔ and that is a COUNT/placement effect, not "no art for this species" — a
// 128-species sweep put a body on the field zero times.
const lay2 = fight({ [OFF]: MN.FORMATION_GFX_ALT_LAYOUT, 6: 0x11, 7: 0x11, 8: 0x11, 9: 0x11 });
ok('bit 0 with counts of 1 DOES place monsters', lay2 && lay2.placed > 0,
   lay2 ? `${lay2.placed} slots` : 'no battle');
ok('...but FEWER slots than the default layout', lay2 && lay2.placed < base.placed,
   lay2 ? `${lay2.placed} vs ${base.placed}` : '');

// ── the field wiring ────────────────────────────────────────────────────────
ok('byte 1 is off the unknown list', !MN.FORMATION_UNKNOWN_OFF.includes(OFF),
   `unknown = ${MN.FORMATION_UNKNOWN_OFF.join(',')}`);
ok('it does not collide with the species, count or palette fields',
   !MN.FORMATION_SPECIES_OFF.includes(OFF) && !MN.FORMATION_COUNT_OFF.includes(OFF)
   && !MN.FORMATION_PAL_OFF.includes(OFF));

// ── ⭐ revert proof ─────────────────────────────────────────────────────────
if (args.includes('--prove-revert')) {
  console.log('\n  revert proof — the same patch on a NEIGHBOURING byte:');
  let survived = 0;
  for (const off of [0, 12]) {
    const r = fight({ [off]: MN.FORMATION_GFX_ALT_ART });
    const looksSame = r && r.ntHash !== base.ntHash && r.attr.some(v => v === MN.ALT_ART_ATTR);
    console.log(`     byte ${off}: ${looksSame ? '⛔ ALSO produces the signature' : 'does not — good'}`);
    if (looksSame) survived++;
  }
  ok('only byte 1 produces the art-swap signature', survived === 0);
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
