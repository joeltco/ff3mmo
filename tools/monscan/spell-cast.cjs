// Drive a PLAYER spell cast headlessly, so spell art can be captured without
// a hand-run Mesen session.
//
//   node spell-cast.cjs            # boot, grant magic, reach a fight, screenshot
//
// Everything about the loadout is copied from the EMU tab's ALL SPELLS preset
// (src/debug/tabs/emu.js `_grantMagic`), which is what drove the Cure / Poisona
// / Fire captures already in spell-anim.js. Same job, same mask, same MP —
// reusing the known-good recipe rather than inventing an SRAM poke.
//
// Writes must land BEFORE the battle starts: FF3 caches character stats at
// battle entry, so a mid-battle poke does nothing (noted in CLAUDE.md).

const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = process.env.OUT || '/tmp/spellcast';

const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;

// ── FF3J SRAM, per src/debug/tabs/emu.js ──────────────────────────
const SRAM_BASE = 0x6000;
const CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const JOB_OFF = 0x00, LEVEL_OFF = 0x01, MP_OFF = 0x30;
const SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;
const SAGE = 0x14, ALL_MASK = 0x7F;

function grantMagic(n, charIdx = 0) {
  const a = SRAM_BASE + CHARS_A_OFF + charIdx * 0x40;
  const b = SRAM_BASE + CHARS_B_OFF + charIdx * 0x40;
  n.ram[a + JOB_OFF] = SAGE;
  n.ram[a + LEVEL_OFF] = 50;
  n.ram[b + JOB_LEVELS_OFF + SAGE * 2] = 99;
  for (let lvl = 0; lvl < 8; lvl++) {
    n.ram[a + MP_OFF + lvl * 2 + 0] = 0x09;
    n.ram[a + MP_OFF + lvl * 2 + 1] = 0x09;
    n.ram[b + SPELL_LIST_OFF + lvl] = ALL_MASK;
  }
}

// ── one weak monster per fight, so the battle is short and unambiguous ──
function goblinEncounters(rom) {
  const out = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((id) => id === 0x00)) out.push(e);
  }
  return out;
}
function singleSpawnRom(id) {
  const rom = readFileSync(BASE_ROM);
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === id) { list = m; break; }
  }
  const p = Buffer.from(rom);
  const mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = id; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (const g of goblinEncounters(rom)) {
    p[ENCOUNTER_SET + g * 2] = list;
    p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'spellcast-'));
  const path = join(dir, 'p.nes');
  writeFileSync(path, p);
  return path;
}

/** Visible sprite count — the cheapest "are we in a battle" signal. */
const spriteCount = (n) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};

const n = new Nes(singleSpawnRom(0x00));
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
grantMagic(n);
n.screenshot(`${OUT}-00-map.png`);
console.log(`after intro: ${spriteCount(n)} sprites`);
console.log('job byte $6100 =', '0x' + n.ram[SRAM_BASE + CHARS_A_OFF].toString(16),
  ' spell mask $6207 =', '0x' + n.ram[SRAM_BASE + CHARS_B_OFF + SPELL_LIST_OFF].toString(16));

// The a/down loop tilepal.cjs uses: 'a' clears the intro and name entry, 'down'
// walks. Nothing else reaches a fight from a cold boot.
let entered = -1;
for (let blk = 0; blk < 20 && entered < 0; blk++) {
  for (let k = 0; k < 6 && entered < 0; k++) {
    grantMagic(n);                                 // reapply: stats are cached at battle entry
    n.press('a', 8, 25);
    if (spriteCount(n) > 12) entered = blk * 7 + k;
  }
  if (entered < 0) { grantMagic(n); n.press('down', 8, 40); if (spriteCount(n) > 12) entered = blk * 7 + 6; }
}
console.log(entered < 0 ? 'NO BATTLE REACHED' : `battle entered at walk step ${entered}`);
n.run(60);
n.screenshot(`${OUT}-01-battle.png`);
console.log(`in battle: ${spriteCount(n)} sprites`);

// ── battle menu bring-up ───────────────────────────────────────────
// Step the command menu one press at a time, screenshotting each state, so the
// navigation to Magic is read off the screen instead of guessed.
if (process.env.MENU) {
  const seq = process.env.MENU.split(',').map((s) => s.trim()).filter(Boolean);
  seq.forEach((btn, i) => {
    n.press(btn, 8, 30);
    n.screenshot(`${OUT}-menu-${String(i).padStart(2, '0')}-${btn}.png`);
  });
  console.log(`menu steps: ${seq.length}`);
}

// ── cast capture ───────────────────────────────────────────────────
// After the menu sequence has committed the cast, walk frames one at a time,
// screenshotting so the animation window can be located before any tile bytes
// are read out of it.
if (process.env.CAPTURE) {
  const total = parseInt(process.env.CAPTURE, 10);
  const every = parseInt(process.env.EVERY || '4', 10);
  for (let f = 0; f < total; f++) {
    n.run(1);
    if (f % every === 0) n.screenshot(`${OUT}-cast-${String(f).padStart(3, '0')}.png`);
  }
  console.log(`captured ${Math.ceil(total / every)} frames`);
}
