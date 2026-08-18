#!/usr/bin/env node
// ff1-rate-curve.mjs — measure the chance-to-probability mapping for FF1 specials.
//
//   node tools/ff1-rate-curve.mjs --id 0x77 --rounds 24 --chance 0x60
//
// ⭐ THE GATE (disassembled, bank 12 confirmed by 16-byte signature):
//   $B2A8 LDA ($9C),Y  Y=7   ; byte 7 = pool id, $FF = none
//   $B2B3 JSR $AE09    X=$10 ; id * 16
//   $B2B7 ADC #$20 / ADC #$90; pointer = $9020 + id*16
//   $B2C2 LDA ($9E),Y  Y=0   ; byte 0 = the chance
//   $B2C4 JSR $B294          ; random(0..128), CMP chance -> C set if random >= chance
//   $B2C7 BCS $B2EF          ; skip. So it FIRES when random < chance.
//   $B2CB LDA ($9A),Y / AND #$07 / ADC #$02  ; counter mod 8 -> index into list at +2
//
// ⭐ BOTH SIGNALS ARE ADDRESS-KEYED, never PC-keyed. `LDA ($9E),Y` issues its two
// zero-page pointer reads at the SAME PC, so a PC-keyed counter over-counts ~3x and
// made a single roll look like three. Instead:
//     roll  = a read of POOL_ENTRY+0   (happens once per roll, pass or fail)
//     fire  = a read of POOL_ENTRY+2..+9 (the spell list — only reached on a pass)
// so fires/rolls is the branch outcome directly, with no proxy in between.
//
// ⛔ Rolls are RARE (a few per ten rounds), so a short run yields single-digit
// samples and can show any answer at all. Run enough rounds, and report n.

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
const ID = Number(flag('id', '0x77'));
const ROUNDS = Number(flag('rounds', '24'));
const CHANCE = flag('chance', null);
const ROUND_CAP = 1800;

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const raw = fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'));
const SNAP = (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const PARTY_HP = 0x610A, PARTY_STRIDE = 0x40;

const p = Uint8Array.from(rom);
p[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = ID;
p[MN.FORMATION_TABLE + MN.FORMATION_COUNT_OFF[0]] = 0x11;
const S = MN.STAT_TABLE + ID * MN.STAT_STRIDE;
p[S + MN.STAT_FIELDS.evade] = 0xFF;

const POOL_ID = rom[S + MN.STAT_FIELDS.special];
const POOL_CPU = 0x9020 + POOL_ID * 16;
const POOL_FILE = 0x30010 + (POOL_CPU - 0x8000);   // bank 12
if (CHANCE !== null) p[POOL_FILE] = Number(CHANCE) & 0xFF;
const CHANCE_VAL = p[POOL_FILE];

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
const menuUp = () => lines().some(l => /\bRUN\b/.test(l));
const onBattleScreen = () => lines().filter(l => /\bHP\b/.test(l)).length >= 3;
const immortal = () => {
  for (let i = 0; i < 4; i++) { c.mem[PARTY_HP + i * PARTY_STRIDE] = 0xE7; c.mem[PARTY_HP + i * PARTY_STRIDE + 1] = 0x03; }
  for (let i = 0; i < 9; i++) {
    const a = MN.ENEMY_RAM + i * MN.ENEMY_RAM_STRIDE;
    if ((c.mem[a + MN.ENEMY_MAXHP_OFF] | (c.mem[a + MN.ENEMY_MAXHP_OFF + 1] << 8)) === 0) continue;
    c.mem[a + MN.ENEMY_CURHP_OFF] = 0xE7; c.mem[a + MN.ENEMY_CURHP_OFF + 1] = 0x03;
  }
};

let recording = false, rolls = 0, fires = 0;
const picked = new Set();
const origLoad = c.load.bind(c);
c.load = function (addr) {
  if (recording) {
    if (addr === POOL_CPU) rolls++;
    else if (addr > POOL_CPU + 1 && addr <= POOL_CPU + 9) { fires++; picked.add(addr - POOL_CPU - 2); }
  }
  return origLoad(addr);
};

run(20);
c.mem[0x27] = 150; c.mem[0x28] = 170;
run(20);
const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
let started = false;
for (let s = 0; s < 300 && !started; s++) {
  const b = D[Math.floor(s / 6) % 2];
  nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(12);
  if (menuUp()) started = true;
}
if (!started) { console.log('never reached a battle'); process.exit(1); }

recording = true;
let acted = 0;
for (let r = 0; r < ROUNDS; r++) {
  if (!onBattleScreen()) break;
  immortal();
  for (let k = 0; k < 12 && menuUp() && onBattleScreen(); k++) {
    nes.buttonDown(1, Controller.BUTTON_A); run(4); nes.buttonUp(1, Controller.BUTTON_A); run(16);
  }
  acted++;
  let f = 0;
  // ⛔ Sample the screen every 30 frames, not every 10 — glyph-decoding 30x32 cells
  // is what makes a long run slow, and nothing here needs 10-frame resolution.
  while (f < ROUND_CAP && !menuUp() && onBattleScreen()) { run(30); f += 30; immortal(); }
}
recording = false;

const pct = rolls ? (100 * fires / rolls).toFixed(0) + '%' : 'n/a';
const expect = ((CHANCE_VAL / 128) * 100).toFixed(0);
console.log(`id $${hx(ID)} pool $${hx(POOL_ID)} @ $${hx(POOL_CPU, 4)}  chance=$${hx(CHANCE_VAL)} (${CHANCE_VAL})  ` +
            `rounds=${acted}  rolls=${rolls}  fires=${fires}  -> ${pct}   (chance/128 = ${expect}%)  ` +
            `list slots used: ${[...picked].sort((a, b) => a - b).join(',') || '—'}`);
