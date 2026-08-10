// Sweep every castable spell and record, per spell, the ROM CHR block its
// animation loads plus the palette and OAM layout while that block is live.
//
//   node spell-sweep.cjs            # both schools, 48 spells
//   node spell-sweep.cjs bm         # black only
//
// Rests on two measured facts, not assumptions:
//
//   1. Battle-effect CHR is uncompressed in the ROM around $55400-$57000, one
//      animation per 16-tile row (spell-chr-region.cjs).
//   2. Casting copies 24 consecutive tiles from that region into sprite slots
//      $49-$60, and spell-capture.cjs reproduced all 10 shipped Fire blocks
//      landing in exactly the slots their constants are named for.
//
// So identifying a spell's art is an exact 16-byte lookup, and the bytes come
// from the ROM afterwards. Nothing here interprets pixels.
//
// The magic menu is 3 columns x 8 rows, levels 8 down to 1, and shows ONE
// school at a time — a Sage still lists only black. Black Mage (job $04) and
// White Mage (job $03) are swept separately, which is also what makes the
// school half of the ID mapping testable rather than assumed.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = process.env.OUT || (__dirname + '/spell-sweep.json');

const LO = 0x49, HI = 0x60;
const REGION_START = 0x55400, REGION_END = 0x57000;
const FRAMES = parseInt(process.env.FRAMES || '1500', 10);

const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MP_OFF = 0x30, SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;

// Black/White Mage both cap at maxMagicLv 7 (src/data/jobs.js), so level 8 is
// rejected outright for them — the pick is refused, the list stays open, and
// later presses drift the cursor onto a lower spell. Level 8 must be swept as
// Magus / Devout, which jobs.js gives maxMagicLv 8.
const SCHOOLS = {
  bm: { job: parseInt(process.env.JOB_BM || '4', 10), mask: 0x07, colBase: 0 },
  wm: { job: parseInt(process.env.JOB_WM || '3', 10), mask: 0x38, colBase: 3 },
};
const ROWS = (process.env.ROWS || '0,1,2,3,4,5,6,7').split(',').map(Number);

/**
 * Spell ID for a menu cell.
 *
 * Read off the game's own menu, not deduced: the rows list Flare/Death/Meteor,
 * Quake/Breakga/Drain, Firaga/Bio/Warp, Thundara/Raze/Erase, ... , Fire/
 * Blizzard/Sleep — matching spells.js $00-$02, $07-$09, $0E-$10, $15-$17,
 * $31-$33. Levels 8 down to 2 are seven blocks of seven (3 black, 3 white, 1
 * summon); level 1 is the short block $31-$36 with no summon.
 */
function spellId(row, col, colBase) {
  const level = 8 - row;
  return level === 1 ? 0x31 + colBase + col : (8 - level) * 7 + colBase + col;
}

// ── worker ─────────────────────────────────────────────────────────
if (!isMainThread) {
  const { Nes, BTN } = require('./nes.cjs');
  const rom = readFileSync(BASE_ROM);

  const REGION = new Map();
  for (let off = REGION_START; off < REGION_END; off += 16) {
    const hex = rom.slice(off, off + 16).toString('hex');
    if (!REGION.has(hex)) REGION.set(hex, off);
  }

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
  const dir = mkdtempSync(join(tmpdir(), 'spellsweep-'));
  const romPath = join(dir, 'p.nes');
  {
    const p = Buffer.from(rom), mo = ENCOUNTER_MON + list * 6;
    p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
    p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
    for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
    writeFileSync(romPath, p);
  }

  // Char 1 is the caster; characters 2-4 are killed outright (HP 0/0 at +$0C /
  // +$0E of each 64-byte block, measured off the live SRAM).
  //
  // This replaces choreographing their command menus, which was the single
  // biggest source of wrong answers here. Whether their menu needs 'a,down,a'
  // or 'down,a' depends on whether it is already open, one spare press picks
  // ATTACK instead of Guard, and three fighters then kill a 32 HP goblin before
  // the caster's turn — so the spell never fires and the run looks exactly like
  // "this spell has no animation". With them dead there is one menu in the
  // whole round and nothing to get wrong.
  const grant = (n, job, mask) => {
    const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
    n.ram[a] = job; n.ram[a + 1] = 50;
    n.ram[b + JOB_LEVELS_OFF + job * 2] = 99;
    for (let l = 0; l < 8; l++) {
      n.ram[a + MP_OFF + l * 2] = 9; n.ram[a + MP_OFF + l * 2 + 1] = 9;
      n.ram[b + SPELL_LIST_OFF + l] = mask;
    }
    for (let c = 1; c < 4; c++) {
      const blk = SRAM_BASE + CHARS_A_OFF + c * 0x40;
      n.ram[blk + 0x0C] = 0; n.ram[blk + 0x0D] = 0;
      n.ram[blk + 0x0E] = 0; n.ram[blk + 0x0F] = 0;
    }
  };
  const sc = (n) => { let c = 0; for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++; return c; };

  /** One round. `cell` null = control (char 1 guards too). */
  function round(job, mask, cell) {
    const n = new Nes(romPath);
    n.run(300);
    for (let i = 0; i < 25; i++) n.press('start', 6, 45);
    let ib = false;
    for (let blk = 0; blk < 20 && !ib; blk++) {
      for (let k = 0; k < 6 && !ib; k++) { grant(n, job, mask); n.press('a', 8, 25); ib = sc(n) > 12; }
      if (!ib) { grant(n, job, mask); n.press('down', 8, 40); ib = sc(n) > 12; }
    }
    if (!ib) throw new Error('never reached a battle');
    n.run(60);

    const blocks = new Map();                  // romOffset -> {slots:Set, first, last}
    const oamFrames = [];
    let frameNo = -1;
    const ppu = n.nes.ppu;
    const origEnd = ppu.endScanline.bind(ppu);
    // Per scanline: MMC3 has the UI bank mapped once the frame ends, so an
    // end-of-frame read of $49-$60 sees menu tiles and never the effect.
    ppu.endScanline = () => {
      origEnd();
      if (frameNo < 0 || ppu.scanline % 8) return;
      const base = ppu.f_spPatternTable ? 0x1000 : 0x0000;
      for (let t = LO; t <= HI; t++) {
        const hex = Buffer.from(n.vram.slice(base + t * 16, base + t * 16 + 16)).toString('hex');
        const off = REGION.get(hex);
        if (off === undefined) continue;
        if (!blocks.has(off)) blocks.set(off, { slots: new Set(), first: frameNo, last: frameNo });
        const r = blocks.get(off);
        r.slots.add(t); r.last = frameNo;
      }
    };

    if (cell) {
      n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
      for (let i = 0; i < cell.row; i++) n.press('down', 8, 24);
      for (let i = 0; i < cell.col; i++) n.press('right', 8, 24);
      n.press('a', 8, 30);
      n.press('a', 8, 30);
    } else {
      // Control = a plain physical Attack. A caster's command menu is
      // Attack/Magic/Run/Item — there is no Guard on it — so the old control
      // walked into the spell list and committed nothing, which made every
      // block in the cast round look spell-owned, cast halo included.
      n.press('a', 8, 30); n.press('a', 8, 30); n.press('a', 8, 30);
    }

    for (let f = 0; f < FRAMES; f++) {
      frameNo = f;
      // Snapshot OAM + sprite palettes only while effect slots are actually on
      // screen; that window IS the animation and everything else is idle battle.
      const drawn = [];
      for (let i = 0; i < 64; i++) {
        if (ppu.sprY[i] >= 0xEF) continue;
        const tile = ppu.sprTile[i];
        if (tile < LO || tile > HI) continue;
        drawn.push({ tile, x: ppu.sprX[i], y: ppu.sprY[i], pal: ppu.sprCol[i] >> 2, h: !!ppu.horiFlip[i], v: !!ppu.vertFlip[i] });
      }
      if (drawn.length) oamFrames.push({ f, spr: drawn, pal: n.palette().slice(16) });
      if (f % 20 === 0 && f < 400) { n.nes.buttonDown(1, BTN.a); n.run(1); n.nes.buttonUp(1, BTN.a); }
      else n.run(1);
    }
    ppu.endScanline = origEnd;
    return { blocks, oamFrames };
  }

  const { job, mask, colBase, cells } = workerData;
  const control = round(job, mask, null);
  const ctrlOffs = new Set(control.blocks.keys());
  parentPort.postMessage({ control: [...ctrlOffs] });

  for (const cell of cells) {
    const out = { ...cell, id: spellId(cell.row, cell.col, colBase) };
    try {
      const r = round(job, mask, cell);
      const own = [...r.blocks.entries()].filter(([off]) => !ctrlOffs.has(off)).sort((a, b) => a[0] - b[0]);
      out.blocks = own.map(([off, rec]) => ({
        off, slots: [...rec.slots].sort((a, b) => a - b), first: rec.first, last: rec.last,
      }));
      out.base = own.length ? own[0][0] : null;
      out.runLength = own.length;
      // Keep only the frames where a slot fed by a spell-owned block is drawn.
      const ownSlots = new Set(own.flatMap(([, rec]) => [...rec.slots]));
      out.frames = r.oamFrames
        .filter((fr) => fr.spr.some((s) => ownSlots.has(s.tile)))
        .map((fr) => ({ f: fr.f, spr: fr.spr, pal: fr.pal }));
    } catch (e) {
      out.error = (e && e.message) || String(e);
    }
    parentPort.postMessage({ result: out });
  }
  rmSync(dir, { recursive: true, force: true });
  parentPort.postMessage({ done: true });
  return;
}

// ── main ───────────────────────────────────────────────────────────
const which = (process.argv[2] || 'both').toLowerCase();
const schools = which === 'both' ? ['bm', 'wm'] : [which];
const jobs = [];
for (const s of schools) {
  const cells = [];
  for (const row of ROWS) for (let col = 0; col < 3; col++) cells.push({ school: s, row, col });
  jobs.push({ school: s, ...SCHOOLS[s], cells });
}

const PAR = Math.max(1, Math.min(parseInt(process.env.SWEEP_WORKERS || '0', 10) || Math.max(1, os.cpus().length - 2), 12));
const results = [];
let pending = 0;

function launch(school, job, mask, colBase, cells) {
  pending++;
  const w = new Worker(__filename, { workerData: { school, job, mask, colBase, cells } });
  w.on('message', (m) => {
    if (m.result) {
      results.push(m.result);
      const r = m.result;
      const nm = `${r.school} L${8 - r.row} c${r.col} -> $${r.id.toString(16).padStart(2, '0')}`;
      console.log(r.error ? `  ${nm}  ERROR ${r.error}`
        : `  ${nm}  base ${r.base === null ? '(none)' : '$' + r.base.toString(16)}  ${r.runLength} block(s)  ${r.frames.length} drawn frame(s)`);
    }
    if (m.done) { pending--; if (!pending) finish(); }
  });
  w.on('error', (e) => { console.error('worker error', e); pending--; if (!pending) finish(); });
}

function finish() {
  results.sort((a, b) => a.id - b.id);
  writeFileSync(OUT, JSON.stringify({ region: [REGION_START, REGION_END], results }));
  const ok = results.filter((r) => r.base != null);
  console.log(`\n${ok.length}/${results.length} spells produced a CHR block`);
  const byBase = new Map();
  for (const r of ok) {
    if (!byBase.has(r.base)) byBase.set(r.base, []);
    byBase.get(r.base).push('$' + r.id.toString(16));
  }
  console.log(`${byBase.size} distinct base offsets across them`);
  console.log('-> ' + OUT);
}

console.log(`sweeping ${jobs.reduce((a, j) => a + j.cells.length, 0)} spells across ${PAR} workers`);
for (const j of jobs) {
  const chunks = Array.from({ length: Math.max(1, Math.floor(PAR / jobs.length)) }, () => []);
  j.cells.forEach((c, i) => chunks[i % chunks.length].push(c));
  for (const ch of chunks) if (ch.length) launch(j.school, j.job, j.mask, j.colBase, ch);
}
