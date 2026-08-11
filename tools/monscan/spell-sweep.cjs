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
const MONSTER_PROPS = 0x060010;
const SPELL_DATA = 0x0618D0;   // 8 bytes/spell, +1 = hit%
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MP_OFF = 0x30, SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;

// Black/White Mage both cap at maxMagicLv 7 (src/data/jobs.js), so level 8 is
// rejected outright for them — the pick is refused, the list stays open, and
// later presses drift the cursor onto a lower spell. Level 8 must be swept as
// Magus / Devout, which jobs.js gives maxMagicLv 8.
const SCHOOLS = {
  bm: { job: parseInt(process.env.JOB_BM || '4', 10), mask: 0x07, colBase: 0, cols: 3 },
  wm: { job: parseInt(process.env.JOB_WM || '3', 10), mask: 0x38, colBase: 3, cols: 3 },
  // Summons are bit 6, one per level, and the menu renders whichever school the
  // MASK enables — with 0x7F set, black wins and the summon column never shows.
  // Masking to 0x40 alone turns the list into a single column of eight:
  // Bahamur / Leviath / Catastro / Hyper / Ifrit / Ramuh / Shiva / Chocb.
  // Sage ($14) is used because it is the one job proven to reach magic level 8.
  call: { job: parseInt(process.env.JOB_CALL || '20', 10), mask: 0x40, colBase: 6, cols: 1 },
};
const ROWS = (process.env.ROWS || '0,1,2,3,4,5,6,7').split(',').map(Number);
// AFFLICT=1: a cure-status spell on a healthy target is simply ineffective and
// draws nothing, which is indistinguishable from having no art — that is why
// Poisona was the last spell the provenance gate could not reproduce. With this
// on, the goblin's statusOnAtk (+10, bit 0x02 = poison) is set and the cast is
// deferred to round 2, so by the time the spell goes off there is something to
// cure. Off by default: it changes the conditions of every other capture too.
const AFFLICT = process.env.AFFLICT === '1';

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
    // Make the goblin unkillable and harmless. If the spell kills it, the
    // enemy-side group during the impact is a DEATH WIPE overlapping the
    // effect, and tools/classify-spell-phases.js labels the impact as
    // deathWipe. If it kills the lone caster, the capture ends mid-animation.
    // HP is 16-bit LE at MONSTER_PROPS + id*16 + 1; byte +9's low 6 bits index
    // the attack stat set, and set 0 is the harmless one (tools/extract-monsters.js).
    const props = MONSTER_PROPS + 0x00 * 16;
    p[props + 1] = 0xFF; p[props + 2] = 0x7F;          // 32767 HP
    p[props + 9] = p[props + 9] & 0xC0;                // attack stat set 0, keep hit-count bits
    // A spell that MISSES draws no effect, which is indistinguishable from a
    // spell with no effect art. Sleep is hit 15, so most captures of it were
    // just misses. Zero the goblin's status resistance (+13) and force every
    // spell to 100% hit so a status actually lands.
    p[props + 13] = 0x00;
    if (AFFLICT) p[props + 10] = 0x02;                 // statusOnAtk = poison
    for (let sp = 0; sp < 88; sp++) p[SPELL_DATA + sp * 8 + 1] = 100;
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
    // Character 2 stays ALIVE. Killing the whole rest of the party removed the
    // menu choreography, but it also left ally-targeted spells with nobody to
    // target — Poisona is a cure-status spell and simply did nothing. One ally
    // is enough to give them a target and is still only one extra menu, which
    // is deterministic: character 2's command menu is already open when its
    // turn arrives, so 'down' then 'a' is Guard.
    if (AFFLICT) {
      // Poison ticks every round; 32 HP does not survive a deferred cast.
      for (let c = 0; c < 2; c++) {
        const blk = SRAM_BASE + CHARS_A_OFF + c * 0x40;
        n.ram[blk + 0x0C] = 0xE7; n.ram[blk + 0x0D] = 0x03;
        n.ram[blk + 0x0E] = 0xE7; n.ram[blk + 0x0F] = 0x03;
      }
    }
    for (let c = 2; c < 4; c++) {
      const blk = SRAM_BASE + CHARS_A_OFF + c * 0x40;
      n.ram[blk + 0x0C] = 0; n.ram[blk + 0x0D] = 0;
      n.ram[blk + 0x0E] = 0; n.ram[blk + 0x0F] = 0;
    }
  };
  const sc = (n) => { let c = 0; for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++; return c; };

  /** One round. `cell` null = control (char 1 guards too). */
  function round(job, mask, cell) {
    // SFX capture. `0x80 | sfxId` written to $7F49; our music.js constant is
    // `val - 0x3F` (verified against the shipped captures: Blizzard's $9C -> $5D
    // = SW_HIT 93, Fire's $C1 -> $82 = FIRE_BOOM 130). Recorded with the frame
    // number so the cast cue ($A1, written at pre-animation start) can be told
    // apart from the spell's own impact sound.
    const sfxWrites = [];
    let _sfxFrame = -1;
    const n = new Nes(romPath, {
      onBatteryRamWrite: (addr, val) => {
        if ((addr | 0) !== 0x7F49) return;
        sfxWrites.push({ f: _sfxFrame, val: val & 0xFF });
      },
    });
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

    if (AFFLICT) {
      // Round 1: plain attack + guard, then let it play out so the goblin lands
      // poison before the spell is chosen.
      n.press('a', 8, 30); n.press('a', 8, 30); n.press('a', 8, 30);
      n.press('down', 8, 30); n.press('a', 8, 30);
      for (let f = 0; f < 500; f++) {
        if (f % 20 === 0) { n.nes.buttonDown(1, BTN.a); n.run(1); n.nes.buttonUp(1, BTN.a); } else n.run(1);
      }
    }
    if (cell) {
      n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
      for (let i = 0; i < cell.row; i++) n.press('down', 8, 24);
      for (let i = 0; i < cell.col; i++) n.press('right', 8, 24);
      n.press('a', 8, 30);
      n.press('a', 8, 30);
      n.press('down', 8, 30); n.press('a', 8, 30);     // char 2 guards
    } else {
      // Control = a plain physical Attack. A caster's command menu is
      // Attack/Magic/Run/Item — there is no Guard on it — so the old control
      // walked into the spell list and committed nothing, which made every
      // block in the cast round look spell-owned, cast halo included.
      n.press('a', 8, 30); n.press('a', 8, 30); n.press('a', 8, 30);
      n.press('down', 8, 30); n.press('a', 8, 30);     // char 2 guards
    }

    for (let f = 0; f < FRAMES; f++) {
      frameNo = f; _sfxFrame = f;
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
    // Measured, not assumed: the goblin is patched to 32767 HP and stat-set-0
    // attack, so it should still be standing and the caster still alive at the
    // end. Recorded so the dump can assert it rather than the reader trusting
    // the patch landed.
    const survived = sc(n) > 12;
    return { blocks, oamFrames, survived, sfxWrites };
  }

  const { job, mask, colBase, cells } = workerData;
  const control = round(job, mask, null);
  const ctrlOffs = new Set(control.blocks.keys());
  parentPort.postMessage({ control: [...ctrlOffs] });

  for (const cell of cells) {
    const out = { ...cell, id: spellId(cell.row, cell.col, colBase) };
    try {
      const r = round(job, mask, cell);
      out.survived = r.survived;
      // Spell-owned SFX. The control round fires the same battle-frame sounds
      // (menu blips, the enemy's turn), so subtract it the way the CHR blocks
      // are subtracted rather than trusting the raw list.
      const ctrlSfx = new Set(control.sfxWrites.map((w) => w.val));
      out.sfxWrites = r.sfxWrites;
      out.sfxOwn = r.sfxWrites.filter((w) => !ctrlSfx.has(w.val));
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
  for (const row of ROWS) for (let col = 0; col < SCHOOLS[s].cols; col++) cells.push({ school: s, row, col });
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
