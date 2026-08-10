// Capture summons, across the FULL sprite slot range.
//
//   node spell-summon.cjs            # all 8 summons
//   node spell-summon.cjs 6          # row 6 (level 2) only
//
// Separate from spell-sweep.cjs on purpose. That tool watches slots $49-$60 —
// the band weapon and spell-effect CHR decompresses into — and 43 spells were
// captured and gated through it. Summons do not live there at all: Shiva is 24
// sprites in $0F-$14, $25-$2A, $33-$38 and $43-$48, so the sweep was
// structurally blind to her and reported only the shared spark burst that
// follows. Rather than widen a validated tool and risk its results, this is its
// own.
//
// Three differences that matter:
//
//   FULL SLOTS   every sprite slot $00-$FF, not a band.
//   WHOLE ROM    a slot's bytes are resolved against a hash of EVERY 16-byte
//                aligned offset in the ROM, so no region has to be guessed.
//                Shiva's art is at $50010 and $53610 — nowhere near the
//                $55400-$57000 effect bank the other spells use.
//   THE FADE     nametable and palette are recorded too. The roster blanking is
//                ~110 changed cells and a 12-entry palette shift, and neither
//                is visible in OAM.
//
// Provenance is unchanged in spirit: a control round of plain attacks loads the
// party portraits and HUD art too, so anything present in both rounds is not
// the summon.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes, BTN } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = process.env.OUT || (__dirname + '/spell-summon.json');
const FRAMES = parseInt(process.env.FRAMES || '900', 10);

const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const MONSTER_PROPS = 0x060010, SPELL_DATA = 0x0618D0;
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MP_OFF = 0x30, SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;

// Summons are bit 6 of the per-level mask. The magic list renders whichever
// school the mask enables and black wins when several are set, so 0x40 alone is
// what turns the list into a single column of eight. Sage ($14) is the one job
// proven to reach magic level 8.
const JOB = parseInt(process.env.JOB || '20', 10);
const MASK = 0x40;
const rom = readFileSync(BASE_ROM);

// hash of every 16-byte aligned tile in the ROM -> first offset holding it.
const ROM_TILES = new Map();
for (let off = 0; off + 16 <= rom.length; off += 16) {
  const hex = rom.slice(off, off + 16).toString('hex');
  if (hex === '0'.repeat(32)) continue;
  if (!ROM_TILES.has(hex)) ROM_TILES.set(hex, off);
}

function patchedRom() {
  const gob = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((v) => v === 0x00)) gob.push(e);
  }
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === 0x00) { list = m; break; }
  }
  const p = Buffer.from(rom), mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  const props = MONSTER_PROPS;
  // KILLABLE=1 leaves the target's real HP in place. The default patch exists so
  // an effect renders at all — a dead target ends the animation early — but it
  // also makes any DEATH-linked visual impossible, which is exactly what Odin's
  // cut-in-half would be. Run both ways when a summon appears to have no effect.
  if (process.env.KILLABLE !== '1') { p[props + 1] = 0xFF; p[props + 2] = 0x7F; }
  p[props + 9] = p[props + 9] & 0xC0;                // harmless attack
  p[props + 13] = 0x00;                              // no status resistance
  for (let s = 0; s < 88; s++) p[SPELL_DATA + s * 8 + 1] = 100;   // never miss
  for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
  const path = join(mkdtempSync(join(tmpdir(), 'summon-')), 'p.nes');
  writeFileSync(path, p);
  return path;
}

const romPath = patchedRom();
const grant = (n) => {
  const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
  n.ram[a] = JOB; n.ram[a + 1] = 50;
  n.ram[b + JOB_LEVELS_OFF + JOB * 2] = 99;
  for (let l = 0; l < 8; l++) {
    n.ram[a + MP_OFF + l * 2] = 9; n.ram[a + MP_OFF + l * 2 + 1] = 9;
    n.ram[b + SPELL_LIST_OFF + l] = MASK;
  }
  for (let c = 2; c < 4; c++) {
    const blk = SRAM_BASE + CHARS_A_OFF + c * 0x40;
    n.ram[blk + 0x0C] = 0; n.ram[blk + 0x0D] = 0;
    n.ram[blk + 0x0E] = 0; n.ram[blk + 0x0F] = 0;
  }
};
const spriteCount = (n) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};

/** One round. `row` null = control (plain attack). */
function round(row) {
  const n = new Nes(romPath);
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  let ib = false;
  for (let blk = 0; blk < 20 && !ib; blk++) {
    for (let k = 0; k < 6 && !ib; k++) { grant(n); n.press('a', 8, 25); ib = spriteCount(n) > 12; }
    if (!ib) { grant(n); n.press('down', 8, 40); ib = spriteCount(n) > 12; }
  }
  if (!ib) throw new Error('never reached a battle');
  n.run(60);
  const baseNt = n.nametable().slice();
  const basePal = n.palette().slice();

  const slotArt = new Map();               // slot -> Map(romOffset -> {first,last})
  let frameNo = -1;
  const ppu = n.nes.ppu;
  const origEnd = ppu.endScanline.bind(ppu);
  ppu.endScanline = () => {
    origEnd();
    if (frameNo < 0 || ppu.scanline % 8) return;
    const base = ppu.f_spPatternTable ? 0x1000 : 0x0000;
    for (let t = 0; t < 256; t++) {
      const hex = Buffer.from(n.vram.slice(base + t * 16, base + t * 16 + 16)).toString('hex');
      const off = ROM_TILES.get(hex);
      if (off === undefined) continue;
      if (!slotArt.has(t)) slotArt.set(t, new Map());
      const m = slotArt.get(t);
      if (!m.has(off)) m.set(off, { first: frameNo, last: frameNo }); else m.get(off).last = frameNo;
    }
  };

  if (row === null) {
    n.press('a', 8, 30); n.press('a', 8, 30); n.press('a', 8, 30);
  } else {
    n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
    for (let i = 0; i < row; i++) n.press('down', 8, 24);
    n.press('a', 8, 30); n.press('a', 8, 30);
  }
  n.press('down', 8, 30); n.press('a', 8, 30);     // char 2 guards

  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    frameNo = f;
    const spr = [];
    for (let i = 0; i < 64; i++) {
      if (ppu.sprY[i] >= 0xEF) continue;
      spr.push({ tile: ppu.sprTile[i], x: ppu.sprX[i], y: ppu.sprY[i], pal: ppu.sprCol[i] >> 2,
        h: !!ppu.horiFlip[i], v: !!ppu.vertFlip[i] });
    }
    const nt = n.nametable();
    let ntd = 0;
    for (let i = 0; i < 960; i++) if (nt[i] !== baseNt[i]) ntd++;
    const pal = n.palette();
    let pd = 0;
    for (let i = 0; i < 32; i++) if (pal[i] !== basePal[i]) pd++;
    frames.push({ f, spr, ntd, pd, pal });
    if (f % 20 === 0 && f < 400) { n.nes.buttonDown(1, BTN.a); n.run(1); n.nes.buttonUp(1, BTN.a); }
    else n.run(1);
  }
  ppu.endScanline = origEnd;
  return { slotArt, frames };
}

const LEVEL_OF_ROW = (row) => 8 - row;
const rows = process.argv[2] !== undefined ? [parseInt(process.argv[2], 10)] : [0, 1, 2, 3, 4, 5, 6, 7];

console.log(`summon capture: job $${JOB.toString(16)}, mask $${MASK.toString(16)}, ${rows.length} row(s)`);
const control = round(null);
const ctrlArt = new Set();
for (const m of control.slotArt.values()) for (const off of m.keys()) ctrlArt.add(off);
console.log(`control round: ${ctrlArt.size} distinct ROM tiles loaded (party art, HUD, digits)`);

const results = [];
for (const row of rows) {
  const id = LEVEL_OF_ROW(row) === 1 ? 0x37 : (8 - LEVEL_OF_ROW(row)) * 7 + 6;
  const r = round(row);
  // Art this cast loads that a plain attack never does.
  const own = new Map();                   // romOffset -> {slots:Set, first, last}
  for (const [slot, m] of r.slotArt) {
    for (const [off, w] of m) {
      if (ctrlArt.has(off)) continue;
      if (!own.has(off)) own.set(off, { slots: new Set(), first: w.first, last: w.last });
      const e = own.get(off);
      e.slots.add(slot);
      e.first = Math.min(e.first, w.first); e.last = Math.max(e.last, w.last);
    }
  }
  const ownSlots = new Set([...own.values()].flatMap((e) => [...e.slots]));
  const drawn = r.frames.filter((fr) => fr.spr.some((s) => ownSlots.has(s.tile)));
  const fadeFrames = r.frames.filter((fr) => fr.ntd > 120 || fr.pd > 4);
  const offs = [...own.keys()].sort((a, b) => a - b);
  const regions = [];
  for (const o of offs) {
    const last = regions[regions.length - 1];
    if (last && o <= last[1] + 0x200) last[1] = o; else regions.push([o, o]);
  }
  const xs = drawn.flatMap((fr) => fr.spr.filter((s) => ownSlots.has(s.tile)).map((s) => s.x));
  const ys = drawn.flatMap((fr) => fr.spr.filter((s) => ownSlots.has(s.tile)).map((s) => s.y));
  const out = {
    id, row, level: LEVEL_OF_ROW(row),
    regions: regions.map(([a, b]) => ({ start: a, end: b, tiles: (b - a) / 16 + 1 })),
    slots: [...ownSlots].sort((a, b) => a - b),
    drawnFrames: drawn.length,
    fadeFrames: fadeFrames.length,
    maxNtDiff: Math.max(...r.frames.map((f) => f.ntd)),
    maxPalDiff: Math.max(...r.frames.map((f) => f.pd)),
    box: xs.length ? { x0: Math.min(...xs), x1: Math.max(...xs) + 8, y0: Math.min(...ys), y1: Math.max(...ys) + 8 } : null,
    frames: drawn.map((fr) => ({ f: fr.f, pal: fr.pal, ntd: fr.ntd, pd: fr.pd,
      spr: fr.spr.filter((s) => ownSlots.has(s.tile)) })),
    art: [...own.entries()].map(([off, e]) => ({ off, slots: [...e.slots], first: e.first, last: e.last })),
  };
  results.push(out);
  console.log(`  $${id.toString(16).padStart(2, '0')} L${out.level}  ` +
    `${out.regions.map((g) => '$' + g.start.toString(16) + '(' + g.tiles + 't)').join(' ') || '(none)'}  ` +
    `${out.slots.length} slots  ${out.drawnFrames} drawn  fade ${out.fadeFrames}f  ` +
    `box ${out.box ? `x${out.box.x0}-${out.box.x1} y${out.box.y0}-${out.box.y1}` : '-'}`);
}

writeFileSync(OUT, JSON.stringify({ job: JOB, results }));
console.log(`\n-> ${OUT}`);
rmSync(join(romPath, '..'), { recursive: true, force: true });
