#!/usr/bin/env node
// ff1-formation-byte1.mjs — what does FF1 formation byte 1 select?
//
// WHY
// `ff1-formation-palette.mjs` found byte 1 repaints 23 of the 32 palette slots —
// far more than bytes 10/11, which own one BG palette each. A whole-screen repaint
// is the signature of a SCENE change, not a recolour, so this measures the things
// a recolour would leave alone: how many bodies are on the field, what tiles are
// drawn, and what the frame actually looks like.
//
//   node tools/ff1-formation-byte1.mjs --state tools/states/ff1-world.state.gz
//   node tools/ff1-formation-byte1.mjs --values 0,1,2,3,4,5,6,7
//
// HOW IT IS KEPT HONEST
//   ⭐ FOUR INDEPENDENT SIGNALS per value: body count (RAM), the nametable (which
//      TILES are drawn), the framebuffer (what it looks like), and the palette.
//      Colour-only vs layout is exactly the distinction a palette read cannot make
//      on its own, and the nametable is what separates them.
//   ⛔ Bodies are counted by MAX hp (RAM +9), never current hp — a fresh spawn
//      reads one short.
//   ⛔ jsnes `onFrame` MUST be passed at construction; assigning it afterwards
//      never fires, and the framebuffer silently stays blank.
//   ⛔ A value whose battle never started is reported, never folded in as "same".

import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { NES, Controller } from 'jsnes';
import * as F1 from './lib/ff1-text.mjs';
import * as MN from './lib/ff1-monsters.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', 'tools/states/ff1-world.state.gz');
const OFF = Number(flag('byte', '1'));
const FORMATION = Number(flag('formation', '0'));
const VALUES = flag('values', '0,1,2,3,4,5,6,7,8,0x0F,0x10,0x20,0x40,0x80,0xFF')
  .split(',').map(Number);
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

const rom = new Uint8Array(fs.readFileSync(ROMP));
const raw = fs.readFileSync(STATE);
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const REC = MN.FORMATION_TABLE + FORMATION * MN.FORMATION_STRIDE;
const sha = (b) => crypto.createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0, 8);

function fight(val) {
  const p = Uint8Array.from(rom);
  p[REC + OFF] = val & 0xFF;
  let fb = null;
  // ⛔ onFrame at CONSTRUCTION — assigning nes.opts.onFrame later never fires.
  const nes = new NES({ onFrame: (buf) => { fb = buf; }, onAudioSample: () => {} });
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
      let bodies = 0;
      for (let i = 0; i < 9; i++) {
        const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
        if ((nes.cpu.mem[a + MN.ENEMY_MAXHP_OFF] | (nes.cpu.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) > 0) bodies++;
      }
      const nt = [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
      const attr = [...nes.ppu.vramMem.slice(0x23C0, 0x2400)];
      // lit = pixels differing from the frame's most common colour
      let lit = 0;
      if (fb) {
        const counts = new Map();
        for (let i = 0; i < fb.length; i++) counts.set(fb[i], (counts.get(fb[i]) || 0) + 1);
        let bg = 0, best = -1;
        for (const [c, k] of counts) if (k > best) { best = k; bg = c; }
        for (let i = 0; i < fb.length; i++) if (fb[i] !== bg) lit++;
      }
      return {
        val, bodies,
        slots: [...nes.cpu.mem.slice(MN.MONSTER_SLOTS, MN.MONSTER_SLOTS + 4)],
        pal: [...nes.ppu.vramMem.slice(0x3F00, 0x3F20)],
        ntHash: sha(nt), attrHash: sha(attr), lit,
        frameHash: fb ? sha(new Uint8Array(new Int32Array(fb).buffer)) : 'none',
      };
    }
  }
  return null;
}

console.log(`FF1 formation ${FORMATION}, byte ${OFF} — colour only, or a whole scene?\n`);
console.log(`  record: ${MN.formationOf(rom, FORMATION).map(v => hx(v)).join(' ')}\n`);

const base = fight(rom[REC + OFF]);
if (!base) { console.error('⛔ the unpatched formation never reached a battle'); process.exit(1); }
console.log(`  baseline (0x${hx(rom[REC + OFF])}): ${base.bodies} bodies  nt ${base.ntHash}  attr ${base.attrHash}  ` +
            `lit ${base.lit}  frame ${base.frameHash}`);
console.log(`     pal ${base.pal.map(v => hx(v)).join(' ')}\n`);

const rows = [];
for (const val of VALUES) {
  const r = fight(val);
  if (!r) { console.log(`  0x${hx(val)}: NO BATTLE`); continue; }
  const palD = r.pal.filter((v, i) => v !== base.pal[i]).length;
  const tag = [];
  if (r.ntHash !== base.ntHash) tag.push('TILES');
  if (r.attrHash !== base.attrHash) tag.push('ATTR');
  if (r.bodies !== base.bodies) tag.push(`BODIES ${r.bodies}`);
  if (palD) tag.push(`pal ${palD}`);
  rows.push(r);
  console.log(`  0x${hx(val)}: ${String(r.bodies).padStart(2)} bodies  nt ${r.ntHash}  attr ${r.attrHash}  ` +
              `lit ${String(r.lit).padStart(5)}  ${tag.length ? '<- ' + tag.join(' ') : 'identical'}`);
}

// ── what does the value actually key on? ────────────────────────────────────
console.log('\n  grouping by observed result:');
const groups = new Map();
for (const r of rows) {
  const k = `${r.ntHash}|${r.pal.map(v => hx(v)).join('')}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r.val);
}
let i = 0;
for (const [, vals] of groups)
  console.log(`     group ${i++}: ${vals.map(v => '0x' + hx(v)).join(' ')}`);
console.log(`  => ${groups.size} distinct outcomes across ${rows.length} values`);

const changesTiles = rows.some(r => r.ntHash !== base.ntHash);
console.log(`\n  ${changesTiles
  ? '⭐ byte ' + OFF + ' changes WHICH TILES ARE DRAWN — it is not a palette field'
  : 'byte ' + OFF + ' moves colours only; the drawn tiles never change'}`);
