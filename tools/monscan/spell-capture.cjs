// Identify which ROM CHR block a spell's animation loads.
//
//   node spell-capture.cjs            # Fire, validated against shipped bytes
//   node spell-capture.cjs 3 1        # row 3 (level 5), column 1 of the menu
//
// Every verified animation tile in the codebase lives uncompressed in the ROM
// between $55600 and $56800, one animation per 16-tile row (see
// spell-chr-region.cjs). So a capture does NOT have to reproduce pixels — it
// only has to say which block the game copied into sprite slots $49-$60. That
// is an exact 16-byte lookup with no interpretation in it, and the art itself
// then comes from the ROM.
//
// Provenance by control round, the same shape that isolated weapons from the
// fist: cast the spell with the other three characters GUARDING, then run the
// identical round with all four guarding. Blocks that only the spell round
// loads are the spell's. Anything the goblin's own attack loads cancels out.

const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes, BTN } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const rom = readFileSync(BASE_ROM);

const LO = 0x49, HI = 0x60;
const REGION_START = 0x55400, REGION_END = 0x57000;
const FRAMES = parseInt(process.env.FRAMES || '1500', 10);

const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const JOB_OFF = 0x00, LEVEL_OFF = 0x01, MP_OFF = 0x30;
const SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;
const SAGE = 0x14, ALL_MASK = 0x7F;

// hex(16 bytes) -> ROM offset, for every tile position in the effect region.
const REGION = new Map();
for (let off = REGION_START; off < REGION_END; off += 16) {
  const hex = rom.slice(off, off + 16).toString('hex');
  if (!REGION.has(hex)) REGION.set(hex, off);
}

function grantMagic(n) {
  const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
  n.ram[a + JOB_OFF] = SAGE;
  n.ram[a + LEVEL_OFF] = 50;
  n.ram[b + JOB_LEVELS_OFF + SAGE * 2] = 99;
  for (let lvl = 0; lvl < 8; lvl++) {
    n.ram[a + MP_OFF + lvl * 2] = 0x09;
    n.ram[a + MP_OFF + lvl * 2 + 1] = 0x09;
    n.ram[b + SPELL_LIST_OFF + lvl] = ALL_MASK;
  }
}

function singleSpawnRom(id) {
  const gob = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((v) => v === 0x00)) gob.push(e);
  }
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === id) { list = m; break; }
  }
  const p = Buffer.from(rom), mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = id; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
  const path = join(mkdtempSync(join(tmpdir(), 'spellcap-')), 'p.nes');
  writeFileSync(path, p);
  return path;
}

const spriteCount = (n) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};

/**
 * One battle round.
 *
 * `spell` = {row, col} picks from the magic menu; null makes char 1 guard too,
 * which is the control. Returns every effect-region block seen in $49-$60,
 * sampled PER SCANLINE — MMC3 has the UI bank mapped by the time frame()
 * returns, so an end-of-frame read reports menu tiles and nothing else.
 */
function round(spell, label) {
  const n = new Nes(singleSpawnRom(0x00));
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  let inBattle = false;
  for (let blk = 0; blk < 20 && !inBattle; blk++) {
    for (let k = 0; k < 6 && !inBattle; k++) { grantMagic(n); n.press('a', 8, 25); inBattle = spriteCount(n) > 12; }
    if (!inBattle) { grantMagic(n); n.press('down', 8, 40); inBattle = spriteCount(n) > 12; }
  }
  if (!inBattle) throw new Error('never reached a battle');
  n.run(60);

  const hits = new Map();                       // romOffset -> {slots:Set, frames:[]}
  let frameNo = -1;
  const ppu = n.nes.ppu;
  const origEnd = ppu.endScanline.bind(ppu);
  ppu.endScanline = () => {
    origEnd();
    if (frameNo < 0 || ppu.scanline % 8) return;
    const base = ppu.f_spPatternTable ? 0x1000 : 0x0000;
    for (let t = LO; t <= HI; t++) {
      const hex = Buffer.from(n.vram.slice(base + t * 16, base + t * 16 + 16)).toString('hex');
      const off = REGION.get(hex);
      if (off === undefined) continue;
      if (!hits.has(off)) hits.set(off, { slots: new Set(), frames: [] });
      const rec = hits.get(off);
      rec.slots.add(t);
      if (rec.frames[rec.frames.length - 1] !== frameNo) rec.frames.push(frameNo);
    }
  };

  if (spell) {
    n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);   // → Magic → list
    for (let i = 0; i < spell.row; i++) n.press('down', 8, 24);
    for (let i = 0; i < spell.col; i++) n.press('right', 8, 24);
    n.press('a', 8, 30);                                                // pick spell
    n.press('a', 8, 30);                                                // confirm target
  } else {
    n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);   // → Guard
  }
  for (let c = 0; c < 3; c++) { n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30); }

  // Record continuously, tapping A along the way. Counting presses to land on
  // the cast never worked — the round starts inside the commit presses, so the
  // window moved every time the sequence changed by one.
  for (let f = 0; f < FRAMES; f++) {
    frameNo = f;
    if (f % 20 === 0 && f < 400) { n.nes.buttonDown(1, BTN.a); n.run(1); n.nes.buttonUp(1, BTN.a); }
    else n.run(1);
  }
  ppu.endScanline = origEnd;
  console.error(`${label}: ${hits.size} effect block(s) touched`);
  return hits;
}

const row = parseInt(process.argv[2] ?? '7', 10);
const col = parseInt(process.argv[3] ?? '0', 10);
const cast = round({ row, col }, `cast row${row} col${col}`);
const ctrl = round(null, 'control (all guard)');

const own = [...cast.entries()].filter(([off]) => !ctrl.has(off)).sort((a, b) => a[0] - b[0]);
console.log(`\nblocks loaded by the cast but never by the control: ${own.length}`);
for (const [off, rec] of own) {
  const slots = [...rec.slots].sort((a, b) => a - b).map((s) => '$' + s.toString(16));
  console.log(`  $${off.toString(16)}  row ${Math.floor((off - 0x55400) / 0x100)}  slots ${slots.join(',')}  frames ${rec.frames[0]}-${rec.frames[rec.frames.length - 1]}`);
}

// ── validate against the already-verified Fire bytes ───────────────
const src = readFileSync(REPO + '/src/spell-anim.js', 'utf8');
const shipped = [];
for (const m of src.matchAll(/const FIRE_T_([0-9A-F]{2}) = new Uint8Array\(\[([^\]]+)\]\)/g)) {
  const b = m[2].split(',').map((s) => parseInt(s.trim(), 16));
  shipped.push({ slot: parseInt(m[1], 16), off: rom.indexOf(Buffer.from(b), REGION_START) });
}
const wanted = new Set(shipped.map((s) => s.off));
const got = new Set(own.map(([off]) => off));
const matched = [...wanted].filter((o) => got.has(o));
console.log(`\nshipped Fire occupies ${wanted.size} blocks ($${Math.min(...wanted).toString(16)}-$${Math.max(...wanted).toString(16)})`);
console.log(`capture reproduced ${matched.length}/${wanted.size} of them`);
for (const s of shipped) {
  const rec = cast.get(s.off);
  console.log(`  $${s.off.toString(16)} (shipped slot $${s.slot.toString(16)}): ` +
    (rec ? `LOADED into ${[...rec.slots].map((x) => '$' + x.toString(16)).join(',')}` : 'not seen'));
}
writeFileSync(__dirname + '/spell-capture.json', JSON.stringify({
  row, col,
  cast: [...cast.entries()].map(([off, r]) => ({ off, slots: [...r.slots], frames: r.frames })),
  own: own.map(([off]) => off),
}));
