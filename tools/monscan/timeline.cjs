// Walk one monster's scripted run frame by frame and report when a battle is
// actually on screen, instead of only looking after the drive has finished.
//
//   node timeline.cjs 76
//
// Prints every window where palette-0/1 cells exist (a monster is drawn) plus
// screenshots at the transitions.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes } = require('./nes.cjs');
const { catalogEntry, captureByPalette } = require('./capture.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;

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

function donorEncounterFor(rom, id) {
  let fallback = null;
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const flags = rom[ENCOUNTER_SET + e * 2 + 1];
    const s = flags & 0x3F;
    const mo = ENCOUNTER_MON + m * 6;
    const ids = [rom[mo + 2], rom[mo + 3], rom[mo + 4], rom[mo + 5]];
    const spawns = [];
    for (let g = 0; g < 4; g++) {
      const b = rom[ENCOUNTER_STR + s * 4 + g];
      if ((b & 0xF) > 0 && ids[g] !== 0xFF) spawns.push(ids[g]);
    }
    if (!spawns.includes(id)) continue;
    if (spawns.every((x) => x === id)) return { e, m, flags };
    fallback = fallback || { e, m, flags };
  }
  return fallback;
}

const id = parseInt(process.argv[2] || '76', 16);
const rom = readFileSync(BASE_ROM);
const entry = catalogEntry(id);
const donor = donorEncounterFor(rom, id);
const patched = Buffer.from(rom);
for (const g of goblinEncounters(rom)) {
  patched[ENCOUNTER_SET + g * 2] = donor.m;
  patched[ENCOUNTER_SET + g * 2 + 1] = donor.flags;
}
const dir = mkdtempSync(join(tmpdir(), 'monscan-tl-'));
const romPath = join(dir, 'p.nes');
writeFileSync(romPath, patched);

const n = new Nes(romPath);
const want = { cols: entry.cols, rows: entry.rows };
console.log(`0x${id.toString(16)} wants ${entry.cols}x${entry.rows}, donor e=${donor.e}`);

let wasBattle = false;
let firstFit = null;
function probe(tag) {
  let cells = 0;
  for (let r = 0; r < 30; r++) for (let c = 0; c < 32; c++) {
    const p = n.paletteAt(c, r); if (p === 0 || p === 1) cells++;
  }
  const inBattle = cells > 0;
  if (inBattle !== wasBattle) {
    const free = captureByPalette(n);
    console.log(`frame ${String(n.frames).padStart(5)} [${tag}] ${inBattle ? 'BATTLE ON' : 'battle off'}` +
                (free ? `  box=${free.cols}x${free.rows}@${free.col},${free.row}` : ''));
    n.screenshot(join(__dirname, `tl-${id.toString(16)}-f${n.frames}.png`));
    wasBattle = inBattle;
  }
  if (inBattle && !firstFit) {
    const fit = captureByPalette(n, want);
    if (fit) { firstFit = n.frames; console.log(`  FIT at frame ${n.frames}: col ${fit.col} row ${fit.row}`); }
  }
}

// Same drive as sweep.cjs, but probing between every press.
n.run(300); probe('boot');
for (let i = 0; i < 25; i++) { n.press('start', 6, 45); probe('start' + i); }
for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) { n.press('a', 8, 25); probe(`a${b}.${k}`); }
  n.press('down', 8, 40); probe('down' + b);
}
for (let i = 0; i < 60; i++) { n.run(30); probe('poll' + i); }
rmSync(dir, { recursive: true, force: true });
console.log(firstFit ? `\nfit found at frame ${firstFit}` : '\nnever fit the catalog size');
