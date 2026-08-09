// Reproduce one monster's sweep run and show what the screen actually holds.
//
//   node diag.cjs 76          # dump palette grid + PNG for the failing capture
//
// Prints the attribute-table palette map (0/1 = monster, 2/3 = backdrop+UI) at
// each poll so a miss can be read directly instead of guessed at.

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

function donorsFor(rom, id) {
  const out = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const flags = rom[ENCOUNTER_SET + e * 2 + 1];
    const s = flags & 0x3F;
    const mo = ENCOUNTER_MON + m * 6;
    const ids = [rom[mo + 2], rom[mo + 3], rom[mo + 4], rom[mo + 5]];
    const spawns = [];
    const counts = [];
    for (let g = 0; g < 4; g++) {
      const b = rom[ENCOUNTER_STR + s * 4 + g];
      counts.push(b & 0xF);
      if ((b & 0xF) > 0 && ids[g] !== 0xFF) spawns.push(ids[g]);
    }
    if (!spawns.includes(id)) continue;
    out.push({ e, m, flags, s, ids, counts, solo: spawns.every((x) => x === id) });
  }
  return out;
}

function grid(nes) {
  const lines = [];
  for (let r = 0; r < 30; r++) {
    let s = String(r).padStart(2, ' ') + ' ';
    for (let c = 0; c < 32; c++) s += nes.paletteAt(c, r);
    lines.push(s);
  }
  return lines.join('\n');
}

const id = parseInt(process.argv[2] || '76', 16);
const which = parseInt(process.argv[3] || '0', 10);   // which donor to use
const rom = readFileSync(BASE_ROM);
const entry = catalogEntry(id);
const donors = donorsFor(rom, id);

console.log(`monster 0x${id.toString(16)}  catalog ${entry.cols}x${entry.rows} tiles`);
console.log(`donor encounters (${donors.length}):`);
for (const d of donors.slice(0, 12))
  console.log(`  e=${d.e} monList=${d.m} struct=${d.s} ids=[${d.ids.map((x) => x.toString(16)).join(',')}]` +
              ` counts=[${d.counts.join(',')}] ${d.solo ? 'SOLO' : ''}`);
if (!donors.length) { console.log('  none'); process.exit(1); }

const donor = donors.find((d) => d.solo) && which === 0
  ? donors.find((d) => d.solo)
  : donors[which] || donors[0];
console.log(`\nusing donor e=${donor.e} monList=${donor.m} struct=${donor.s}`);

const patched = Buffer.from(rom);
for (const g of goblinEncounters(rom)) {
  patched[ENCOUNTER_SET + g * 2] = donor.m;
  patched[ENCOUNTER_SET + g * 2 + 1] = donor.flags;
}
const dir = mkdtempSync(join(tmpdir(), 'monscan-diag-'));
const romPath = join(dir, 'p.nes');
writeFileSync(romPath, patched);

const n = new Nes(romPath);
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) n.press('a', 8, 25);
  n.press('down', 8, 40);
}
n.run(300);

let hit = null;
const TRACE = process.env.DIAG_TRACE === '1';
for (let tries = 0; tries < 60 && !hit; tries++) {
  if (TRACE) {
    let cells = 0;
    for (let r = 0; r < 30; r++) for (let c = 0; c < 32; c++) {
      const p = n.paletteAt(c, r); if (p === 0 || p === 1) cells++;
    }
    const free = captureByPalette(n);
    console.log(`  poll ${tries} frame ${n.frames}: pal0/1 cells=${cells}` +
                (free ? ` box=${free.cols}x${free.rows}@${free.col},${free.row}` : ''));
    if (tries % 10 === 0) n.screenshot(join(__dirname, `diag-${id.toString(16)}-t${tries}.png`));
  }
  hit = captureByPalette(n, { cols: entry.cols, rows: entry.rows });
  if (!hit) n.run(30);
}
if (hit) {
  console.log(`\nCAPTURED at col ${hit.col} row ${hit.row}`);
  console.log('tilePal:', JSON.stringify(hit.tilePal));
} else {
  // Show the unconstrained bounding box so the size mismatch is visible.
  const free = captureByPalette(n);
  console.log('\nMISS. unconstrained palette-0/1 region:',
              free ? `${free.cols}x${free.rows} at col ${free.col} row ${free.row}` : 'none at all');
  console.log(`catalog wants ${entry.cols}x${entry.rows}`);
  console.log('\npalette map (attribute table):');
  console.log(grid(n));
  const png = join(__dirname, `diag-${id.toString(16)}.png`);
  n.screenshot(png);
  console.log('\nscreenshot ->', png);
}
rmSync(dir, { recursive: true, force: true });
