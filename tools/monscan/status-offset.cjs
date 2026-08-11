// status-offset.cjs — MEASURE which SRAM byte holds a character's status.
//
// Not a guess and not a disassembly read: run the same battle twice, once with
// the goblin's `statusOnAtk` set and once with it cleared, and diff the party's
// SRAM char blocks. The byte that gains the status bit in the afflicted run and
// not in the control run IS the status byte. Same differential technique the
// sprite tooling uses, applied to RAM.
//
//   node tools/monscan/status-offset.cjs [statusMask]      # default 0x02 poison
//
// Why this is wanted: `spell-sweep.cjs`'s AFFLICT path tries to inflict a status
// by playing a whole combat round, which lands the capture loop mid-round and
// yields nothing (see the warning above AFFLICT). With this offset the party can
// be afflicted directly in SRAM, no round required, and the four cure-status
// spells become capturable.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';

const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const MONSTER_PROPS = 0x060010;
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MASK = parseInt(process.argv[2] || '2', 10);

const rom = readFileSync(BASE_ROM);

// Single-goblin encounter, same patch the sweep uses so the two runs differ in
// exactly ONE byte: the monster's statusOnAtk.
function makeRom(statusOnAtk) {
  const p = Buffer.from(rom);
  const gob = [];
  for (let e = 0; e < 256; e++) {
    const m = p[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
    const ids = [p[o + 2], p[o + 3], p[o + 4], p[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((v) => v === 0x00)) gob.push(e);
  }
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (p[o + 2 + s] === 0x00) { list = m; break; }
  }
  const mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  const props = MONSTER_PROPS + 0x00 * 16;
  p[props + 1] = 0xFF; p[props + 2] = 0x7F;      // unkillable goblin
  p[props + 10] = statusOnAtk & 0xFF;            // statusOnAtk — THE variable
  p[props + 13] = 0x00;                          // target status resistance off
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
  const dir = mkdtempSync(join(tmpdir(), 'statusoff-'));
  const path = join(dir, 'p.nes');
  writeFileSync(path, p);
  return { path, dir };
}

// Scan ALL CPU-visible RAM, not just the save block. First attempt limited this
// to $6100-$62FF on the assumption that a character's status lives with the
// rest of their saved stats — it found nothing, which is evidence in itself:
// in-battle status is held in battle work RAM and only written back to the save
// block later, if at all. Do not assume where a value lives; scan and let the
// differential say.
const WINDOW_LO = 0x0000;
const WINDOW_HI = 0x8000;

function run(statusOnAtk) {
  const { path, dir } = makeRom(statusOnAtk);
  const n = new Nes(path);
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  const sc = () => { let c = 0; for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++; return c; };
  let ib = false;
  for (let blk = 0; blk < 20 && !ib; blk++) {
    for (let k = 0; k < 6 && !ib; k++) { n.press('a', 8, 25); ib = sc() > 12; }
    if (!ib) { n.press('down', 8, 40); ib = sc() > 12; }
  }
  if (!ib) throw new Error('never reached a battle');
  n.run(60);
  const before = Buffer.from(n.ram.slice(WINDOW_LO, WINDOW_HI));
  // Let several rounds play out so the goblin lands attacks. Guard so the party
  // does not act meaningfully; A only clears messages.
  for (let f = 0; f < 2000; f++) {
    if (f % 40 === 0) { n.press('a', 6, 4); } else n.run(1);
  }
  const after = Buffer.from(n.ram.slice(WINDOW_LO, WINDOW_HI));
  rmSync(dir, { recursive: true, force: true });
  return { before, after };
}

const afflicted = run(MASK);
const control = run(0x00);

// Bytes that GAINED the mask bit in the afflicted run only.
const hits = [];
for (let i = 0; i < afflicted.after.length; i++) {
  const gainedA = (~afflicted.before[i] & afflicted.after[i] & MASK) === MASK;
  const gainedC = (~control.before[i] & control.after[i] & MASK) === MASK;
  if (gainedA && !gainedC) {
    const addr = WINDOW_LO + i;
    const blockBase = SRAM_BASE + CHARS_A_OFF;
    const rel = addr - blockBase;
    hits.push({ addr, inSave: addr >= blockBase && addr < blockBase + 0x100,
                char: Math.floor(rel / 0x40), off: rel % 0x40,
                before: afflicted.before[i], after: afflicted.after[i] });
  }
}

console.log(`status-offset — mask 0x${MASK.toString(16)}, window $${WINDOW_LO.toString(16)}-$${(WINDOW_HI - 1).toString(16)}`);
if (!hits.length) {
  console.log('  no byte gained the mask bit in the afflicted run only.');
  let changedA = 0, changedC = 0;
  for (let i = 0; i < afflicted.after.length; i++) {
    if (afflicted.before[i] !== afflicted.after[i]) changedA++;
    if (control.before[i] !== control.after[i]) changedC++;
  }
  console.log(`  sanity: ${changedA} bytes changed in the afflicted run, ${changedC} in the control.`);
  console.log('  (if both are ~0 the battle never progressed; if large, the status simply never landed)');
  process.exit(1);
}
console.log(`  ${hits.length} candidate byte(s):`);
for (const h of hits) {
  const where = h.inSave ? `char ${h.char} offset +0x${h.off.toString(16).padStart(2, '0')}` : '(outside the save char blocks)';
  console.log(`    $${h.addr.toString(16).padStart(4, '0')}  ${where.padEnd(28)} ` +
              `0x${h.before.toString(16).padStart(2, '0')} -> 0x${h.after.toString(16).padStart(2, '0')}`);
}
const inSave = hits.filter((h) => h.inSave);
if (inSave.length) {
  const offs = [...new Set(inSave.map((h) => h.off))];
  console.log(`  save-block offsets: ${offs.map((o) => '+0x' + o.toString(16)).join(', ')}`);
}
