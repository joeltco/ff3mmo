// spell-target-probe.cjs — does a spell hit ONE enemy or ALL of them? Measured
// on the cartridge by counting which enemy slots lose HP.
//
//   node spell-target-probe.cjs --spell=0x31            # Fire
//   node spell-target-probe.cjs --spell=0x31 --patch5=0x48
//   node spell-target-probe.cjs --sweep=bm
//
// WHY THIS EXISTS
// `src/data/spells.js` says, in a comment: "The ROM does NOT encode
// single-vs-all for player spells — checked, not assumed". That check looked at
// the spell record's byte +4 only. Byte +5 was never examined — and
// `tools/gen-spells-js.js` reads it into a variable literally named `targeting`
// and then never uses it. 2 of the record's 8 bytes are unconsumed (+5 and +7).
//
// So this does NOT try to read the meaning off the table. It CHANGES ONE BYTE
// and watches the screen, which is the only thing that settles it:
//   control  Fire  (+5 = 0x08)            -> expect 1 enemy damaged
//   positive Quake (+5 = 0x4e)            -> expect 4 enemies damaged
//   causal   Fire with +5 patched to 0x48 -> if 4, bit 6 IS "hits all"
// The causal arm changes bit 6 and nothing else, so the art index, element,
// power and target byte are all held constant.
//
// FOUR BODIES: species record = one goblin slot, and EVERY count record's slot
// 0 is forced to 0x44 (high nibble = min, low = max — tools/lib/ff3-encounters.mjs).
// ⛔ All 64 records, not record 0: the species index and the COUNT index are
// different numbers ($7D68 & 0x3F), so patching record 0 alone is the documented
// way to conclude the table is inert when it is not.

const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';

const ENCOUNTER_SET = 0x05C010;
const SPECIES_TABLE = 0x05C410, SPECIES_STRIDE = 6, SPECIES_ID_OFF = 2;
const COUNT_TABLE   = 0x05CA10, COUNT_STRIDE = 4, COUNT_RECORDS = 64;
const SPELL_DATA    = 0x0618D0, SPELL_STRIDE = 8;

// FF3J SRAM, per src/debug/tabs/emu.js (same recipe spell-cast.cjs uses).
const SRAM_BASE = 0x6000;
const CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const JOB_OFF = 0x00, LEVEL_OFF = 0x01, MP_OFF = 0x30;
const SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;
const REC_HP_CUR = 0x0C;
const SAGE = 0x14;

// Battle work RAM — the combatant block. tools/lib/ff3-monsters.mjs, gated by
// tools/check-real-battles.mjs.
const COMBATANT_BASE = 0x7578, COMBATANT_STRIDE = 0x40, ENEMY_SLOT0 = 4;
const enemyAddr = (n) => COMBATANT_BASE + (ENEMY_SLOT0 + n) * COMBATANT_STRIDE;

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit === undefined ? d : hit.split('=')[1];
};
const num = (k, d) => { const v = arg(k, null); return v === null ? d : Number(v); };

/**
 * Spell ID for a menu cell — lifted verbatim from spell-sweep.cjs, which read
 * it off the game's own menu.
 */
function spellIdForCell(row, col, colBase) {
  const level = 8 - row;
  return level === 1 ? 0x31 + colBase + col : (8 - level) * 7 + colBase + col;
}
// ⛔ SAGE ($14) FOR ALL THREE SCHOOLS. Black Mage and White Mage cap at magic
// level 7, so a level-8 pick is REFUSED — the list stays open and the cursor
// drifts, which reads as a spell that asked for a target. Sage is the job
// spell-sweep.cjs proved reaches level 8. The MASK still selects which school
// the list renders, so the columns are unchanged.
const SAGE_JOB = 20;
const SCHOOLS = {
  bm:   { job: SAGE_JOB, mask: 0x07, colBase: 0, cols: 3 },
  wm:   { job: SAGE_JOB, mask: 0x38, colBase: 3, cols: 3 },
  call: { job: SAGE_JOB, mask: 0x40, colBase: 6, cols: 1 },
};
/** Invert the cell map: spell id -> {school,row,col}. */
function cellForSpell(id) {
  for (const [school, s] of Object.entries(SCHOOLS)) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < s.cols; col++) {
        if (spellIdForCell(row, col, s.colBase) === id) return { school, row, col, ...s };
      }
    }
  }
  return null;
}

/** A rom where every goblin encounter spawns FOUR goblins. */
function fourGoblinRom(patches) {
  const rom = readFileSync(BASE_ROM);
  const p = Buffer.from(rom);

  // Pick the species record that already holds a goblin, and make it goblin-only.
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = SPECIES_TABLE + m * SPECIES_STRIDE + SPECIES_ID_OFF;
    for (let s = 0; s < 4; s++) if (rom[o + s] === 0x00) { list = m; break; }
  }
  const so = SPECIES_TABLE + list * SPECIES_STRIDE + SPECIES_ID_OFF;
  p[so] = 0x00; p[so + 1] = 0xFF; p[so + 2] = 0xFF; p[so + 3] = 0xFF;

  // ⛔ EVERY count record — the count index is not the species index.
  for (let i = 0; i < COUNT_RECORDS; i++) {
    const c = COUNT_TABLE + i * COUNT_STRIDE;
    p[c] = 0x44;                       // min 4, max 4 -> always four bodies
    p[c + 1] = 0x00; p[c + 2] = 0x00; p[c + 3] = 0x00;
  }

  // Route every all-goblin encounter at that record.
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const o = SPECIES_TABLE + m * SPECIES_STRIDE + SPECIES_ID_OFF;
    const ids = [0, 1, 2, 3].map((s) => rom[o + s]).filter((v) => v !== 0xFF);
    if (ids.length && ids.every((id) => id === 0x00)) {
      p[ENCOUNTER_SET + e * 2] = list;
      p[ENCOUNTER_SET + e * 2 + 1] &= 0xC0;
    }
  }

  for (const { off, val } of (patches || [])) p[off] = val & 0xFF;

  const dir = mkdtempSync(join(tmpdir(), 'spelltarget-'));
  const path = join(dir, 'p.nes');
  writeFileSync(path, p);
  return path;
}

function grantMagic(n, job, mask, charIdx = 0) {
  const a = SRAM_BASE + CHARS_A_OFF + charIdx * 0x40;
  const b = SRAM_BASE + CHARS_B_OFF + charIdx * 0x40;
  n.ram[a + JOB_OFF] = job;
  n.ram[a + LEVEL_OFF] = 50;
  n.ram[b + JOB_LEVELS_OFF + job * 2] = 99;
  for (let lvl = 0; lvl < 8; lvl++) {
    n.ram[a + MP_OFF + lvl * 2 + 0] = 0x09;
    n.ram[a + MP_OFF + lvl * 2 + 1] = 0x09;
    n.ram[b + SPELL_LIST_OFF + lvl] = mask;
  }
}
/** ⛔ Only character 1 may act — otherwise a teammate's swing lands on a goblin
 *  inside the measurement window and reads as the spell having hit it. */
function killOthers(n) {
  for (let i = 1; i < 4; i++) {
    const a = SRAM_BASE + CHARS_A_OFF + i * 0x40;
    n.ram[a + REC_HP_CUR] = 0; n.ram[a + REC_HP_CUR + 1] = 0;
  }
}
const spriteCount = (n) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};
const enemyHP = (n) => [0, 1, 2, 3].map((i) => n.ram[enemyAddr(i)] | (n.ram[enemyAddr(i) + 1] << 8));
const enemyMax = (n) => [0, 1, 2, 3].map((i) => n.ram[enemyAddr(i) + 2] | (n.ram[enemyAddr(i) + 3] << 8));

/**
 * Cast one spell and report whether FF3 ASKED FOR A TARGET.
 *
 * ⛔ THE GAME'S OWN ANSWER, not a damage count. Measured on screen: picking
 * Fire opens a target cursor on ONE goblin and LEAVES THE SPELL LIST UP;
 * picking Quake skips target select entirely and commits, replacing the list
 * with the name + HP panels. So "did the spell list survive the A press" IS
 * the single-vs-all bit, read off the nametable the game drew.
 *
 * A damage count was the first design and it cannot work here: FF3 takes
 * commands from all four characters before the round runs, so the round never
 * resolves inside the window unless the other three menus are driven too — and
 * driving them puts their attacks on the goblins, which is indistinguishable
 * from the spell having hit them.
 */
function probe(spellId, patch5) {
  const cell = cellForSpell(spellId);
  if (!cell) return { error: `no menu cell for spell 0x${spellId.toString(16)}` };
  const patches = [];
  if (patch5 != null) patches.push({ off: SPELL_DATA + spellId * SPELL_STRIDE + 5, val: patch5 });

  const n = new Nes(fourGoblinRom(patches));
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);

  let inBattle = false;
  for (let blk = 0; blk < 20 && !inBattle; blk++) {
    for (let k = 0; k < 6 && !inBattle; k++) {
      grantMagic(n, cell.job, cell.mask); killOthers(n);
      n.press('a', 8, 25); inBattle = spriteCount(n) > 12;
    }
    if (!inBattle) {
      grantMagic(n, cell.job, cell.mask); killOthers(n);
      n.press('down', 8, 40); inBattle = spriteCount(n) > 12;
    }
  }
  if (!inBattle) return { error: 'never reached a battle' };
  n.run(60);
  const bodies = [0, 1, 2, 3].filter((i) => (n.ram[enemyAddr(i) + 2] | (n.ram[enemyAddr(i) + 3] << 8)) > 0).length;

  const SHOT = process.env.SHOT ? (process.env.SHOT + '-') : null;
  let shotN = 0;
  const shot = (tag) => { if (SHOT) n.screenshot(`${SHOT}${String(shotN++).padStart(2, '0')}-${tag}.png`); };

  // Command menu -> Magic -> the spell's cell.
  n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
  for (let i = 0; i < cell.row; i++) n.press('down', 8, 24);
  for (let i = 0; i < cell.col; i++) n.press('right', 8, 24);
  n.run(20);
  shot('list');
  const picked = cursorSpellName(n);
  const listBefore = panelTiles(n);
  const refused = listBefore.filter((t) => t !== BLANK).length === 0;

  n.press('a', 8, 30);
  n.run(20);
  shot('after-pick');
  const listAfter = panelTiles(n);

  let same = 0;
  for (let i = 0; i < listBefore.length; i++) if (listBefore[i] === listAfter[i]) same++;
  const kept = same / listBefore.length;

  // ⛔ THREE SIGNATURES, NOT TWO. The first version of this had two and called
  // Cure an all-target spell. Every band below was confirmed by looking at the
  // screen it produces:
  //
  //   ~100%  the spell list is STILL UP and the cursor has moved onto a
  //          monster                                    -> single, enemy
  //   ~63%   the list is replaced by the enemy name box + party HP panel and
  //          there is no cursor: the game never asked    -> ALL ENEMIES
  //   ~42%   the list is replaced by the PARTY HP panel with the cursor on a
  //          party member                                -> single, ally
  //
  // A two-band rule reads 42% as "not ~100%, therefore all", which is how the
  // entire Cure family came back as auto-all on the first pass.
  const scope = kept > 0.80 ? 'single-enemy'
              : kept > 0.52 ? 'ALL-ENEMIES'
              : 'single-ally';
  return { bodies, kept, picked, scope, askedForTarget: scope !== 'ALL-ENEMIES', refused };
}

/**
 * The spell name the cursor is ACTUALLY sitting on, decoded off the nametable.
 *
 * ⛔ THE ANTI-SWAP GUARD. The menu SCROLLS — only four of the eight rows are on
 * screen — and a job that cannot reach a magic level REFUSES the pick and
 * leaves the cursor somewhere else entirely. Both failures produce a confident
 * reading of the wrong spell. Every row of the sweep echoes the name the run
 * used, and disagreeing with the expected name is a hard error, not a warning.
 */
function cursorSpellName(n) {
  const ppu = n.nes.ppu;
  // The menu cursor is the leftmost visible sprite in the bottom panel.
  let best = null;
  for (let i = 0; i < 64; i++) {
    const y = ppu.sprY[i], x = ppu.sprX[i];
    if (y >= 0xEF || y < 150) continue;
    if (!best || x < best.x) best = { x, y };
  }
  if (!best) return null;
  const row = Math.floor((best.y + 1) / 8);
  const col = Math.floor(best.x / 8);
  const nt = n.nametable();
  // Skip the MP-cost digit and the bullet glyph between the cursor and the
  // name — take the first run of LETTERS to the cursor's right.
  let out = '';
  for (let c = col; c < 32; c++) {
    const g = GLYPH[nt[row * 32 + c]];
    const isAlpha = g !== undefined && /[A-Za-z]/.test(g);
    if (isAlpha) out += g;
    else if (out) break;
  }
  return out.trim() || null;
}
// FF3's BG font tiles use the same codes as its text encoding.
const GLYPH = {};
for (let c = 0x8A; c <= 0xA3; c++) GLYPH[c] = String.fromCharCode(c - 0x8A + 65);
for (let c = 0xCA; c <= 0xE3; c++) GLYPH[c] = String.fromCharCode(c - 0xCA + 97);
for (let c = 0x80; c <= 0x89; c++) GLYPH[c] = String.fromCharCode(c - 0x80 + 48);

/** Is a character's command menu (Attack/Guard/Run/Item) still waiting? */
function commandMenuOpen(n) {
  const nt = n.nametable();
  let text = '';
  for (let row = 20; row < 30; row++) {
    for (let col = 0; col < 32; col++) {
      const g = GLYPH[nt[row * 32 + col]];
      text += (g === undefined ? ' ' : g);
    }
  }
  return text.includes('Guard') && text.includes('Item');
}

/** The bottom panel's nametable tiles — rows 20-29, where the spell list draws. */
const BLANK = 0xFF;
function panelTiles(n) {
  const nt = n.nametable();
  const out = [];
  for (let row = 20; row < 30; row++) for (let col = 0; col < 32; col++) out.push(nt[row * 32 + col]);
  return out;
}

/**
 * WHEN does each enemy's HP drop on an all-target cast? Same frame, or one at
 * a time?
 *
 * This is the second half of the question: ff3mmo has TWO multi-target impact
 * paths — a SERIAL walk that gives every target its own 1400 ms window (4
 * enemies = 5.6 s) and a PARALLEL apply where the whole set resolves at once.
 * Which one the cartridge uses is measurable, so it should not be an opinion.
 *
 * ⛔ CHARACTERS 2-4 GUARD. Setting their HP to 0 does NOT stop FF3 offering
 * them a menu (measured — the round simply never runs and every "no damage"
 * reading is the round never having happened). Driving them to Guard costs
 * nothing and puts no physical damage on the goblins, so every HP drop in the
 * window belongs to the spell.
 */
function damageTiming(spellId, patch5) {
  const cell = cellForSpell(spellId);
  if (!cell) return { error: `no menu cell for spell 0x${spellId.toString(16)}` };
  const patches = [];
  if (patch5 != null) patches.push({ off: SPELL_DATA + spellId * SPELL_STRIDE + 5, val: patch5 });

  const n = new Nes(fourGoblinRom(patches));
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  let inBattle = false;
  for (let blk = 0; blk < 20 && !inBattle; blk++) {
    for (let k = 0; k < 6 && !inBattle; k++) {
      grantMagic(n, cell.job, cell.mask);
      n.press('a', 8, 25); inBattle = spriteCount(n) > 12;
    }
    if (!inBattle) { grantMagic(n, cell.job, cell.mask); n.press('down', 8, 40); inBattle = spriteCount(n) > 12; }
  }
  if (!inBattle) return { error: 'never reached a battle' };
  n.run(60);

  const SHOT = process.env.SHOT ? (process.env.SHOT + '-dmg-') : null;
  let shotN = 0;

  n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
  for (let i = 0; i < cell.row; i++) n.press('down', 8, 24);
  for (let i = 0; i < cell.col; i++) n.press('right', 8, 24);
  const picked = cursorSpellName(n);
  n.press('a', 8, 30);
  const asked = panelTiles(n);
  n.press('a', 8, 30);                 // confirms a target if one was asked for
  // Characters 2-4: down = Guard, then confirm.
  // ⛔ DRIVEN BY THE SCREEN, NOT BY A PRESS COUNT. Three fixed down/a pairs
  // left character 3 on Attack and character 4 still holding an open menu, so
  // the round never started and every enemy read "took no damage" — a result
  // that looks exactly like the spell having missed everything.
  // ⛔ BASELINE BEFORE THE MENUS ARE DRIVEN. Sampling after them lost a kill:
  // the round resolved while the remaining characters were still being walked
  // through Guard, so the first read already showed a dead goblin and the
  // spell's own damage had happened outside the window.
  const before = [0, 1, 2, 3].map((i) => n.ram[enemyAddr(i)] | (n.ram[enemyAddr(i) + 1] << 8));
  const maxHP  = [0, 1, 2, 3].map((i) => n.ram[enemyAddr(i) + 2] | (n.ram[enemyAddr(i) + 3] << 8));
  const dropAt = [null, null, null, null];
  const cur = before.slice();

  // One loop: drive any open command menu to Guard, and poll HP every frame.
  // ⛔ The other three GUARD rather than Attack — a physical hit inside the
  // window is indistinguishable from the spell having reached that body.
  let sinceMenu = 0;
  for (let f = 0; f < 1400; f++) {
    n.run(1);
    if (SHOT && f % 30 === 0) n.screenshot(`${SHOT}${String(shotN++).padStart(3, '0')}.png`);
    for (let i = 0; i < 4; i++) {
      const hp = n.ram[enemyAddr(i)] | (n.ram[enemyAddr(i) + 1] << 8);
      if (dropAt[i] === null && hp < cur[i]) dropAt[i] = f;
      cur[i] = hp;
    }
    if (++sinceMenu >= 15 && commandMenuOpen(n)) {
      sinceMenu = 0;
      n.press('down', 10, 26);
      n.press('a', 10, 26);
    }
  }
  const hit = dropAt.filter((v) => v !== null);
  const spread = hit.length > 1 ? Math.max(...hit) - Math.min(...hit) : 0;
  return { picked, bodies: maxHP.filter((v) => v > 0).length, before, after: cur, dropAt,
           damaged: hit.length, spreadFrames: spread };
}

// ── main ───────────────────────────────────────────────────────────────────
const sweep = arg('sweep', null);
const rom0 = readFileSync(BASE_ROM);
const b5of = (id) => rom0[SPELL_DATA + id * SPELL_STRIDE + 5];

if (arg('damage', null) !== null) {
  const id = Number(arg('damage'));
  const p5 = arg('patch5', null);
  const r = damageTiming(id, p5 === null ? null : Number(p5));
  if (r.error) { console.log('ERROR ' + r.error); process.exit(1); }
  console.log(`spell 0x${id.toString(16).padStart(2, '0')} picked=${JSON.stringify(r.picked)} bodies=${r.bodies}`);
  console.log(`  hp ${r.before.join('/')} -> ${r.after.join('/')}`);
  console.log(`  damaged ${r.damaged} of ${r.bodies};  first HP drop at frame ${JSON.stringify(r.dropAt)}`);
  console.log(`  spread between first and last drop: ${r.spreadFrames} frames ` +
              `(${(r.spreadFrames / 60).toFixed(2)}s) -> ${r.spreadFrames <= 2 ? 'SIMULTANEOUS' : 'SERIAL'}`);
} else if (!sweep) {
  const id = num('spell', 0x31);
  const p5 = arg('patch5', null);
  const nat = b5of(id);
  const r = probe(id, p5 === null ? null : Number(p5));
  const tag = p5 === null ? `+5=0x${nat.toString(16).padStart(2, '0')}`
                          : `+5=0x${nat.toString(16).padStart(2, '0')}->0x${Number(p5).toString(16)}`;
  if (r.error) { console.log(`spell 0x${id.toString(16)}  ${tag}  ERROR ${r.error}`); process.exit(1); }
  console.log(`spell 0x${id.toString(16).padStart(2, '0')}  ${tag}  bodies=${r.bodies}  ` +
              `picked=${JSON.stringify(r.picked)}  ` +
              `listKept=${(r.kept * 100).toFixed(0)}%  ${r.scope}`);
} else {
  const s = SCHOOLS[sweep];
  const rows = (arg('rows', '0,1,2,3,4,5,6,7')).split(',').map(Number);
  const out = [];
  for (const row of rows) {
    for (let col = 0; col < s.cols; col++) {
      const id = spellIdForCell(row, col, s.colBase);
      const b5 = b5of(id);
      const r = probe(id, null);
      const rec = { id, b5, lvl: 8 - row, col, school: sweep, ...r };
      out.push(rec);
      const verdict = r.error ? r.error : r.scope;
      console.log(`0x${id.toString(16).padStart(2, '0')} ${sweep} L${8 - row}c${col}  +5=0x${b5.toString(16).padStart(2, '0')}` +
                  `  bit6=${(b5 & 0x40) ? 'Y' : '.'}  bit5=${(b5 & 0x20) ? 'Y' : '.'}  ` +
                  `kept=${r.kept === undefined ? '--' : (r.kept * 100).toFixed(0) + '%'}  ${verdict}`);
      writeFileSync(join(__dirname, `spell-target-${sweep}.json`), JSON.stringify(out, null, 2));
    }
  }
}
