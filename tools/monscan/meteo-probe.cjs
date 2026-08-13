// meteo-probe.cjs — cast a LEVEL 8 spell for real, and look at the screen.
//
// Why this exists: `spell-sweep.cjs` swept level 8 with Black Mage (job 4),
// whose maxMagicLv is 7. The sweep's own header says what happens then — "the
// pick is refused, the list stays open, and later presses drift the cursor onto
// a lower spell" — so every row-0 value in CAPTURED_SPELL_SFX (0x00, 0x01,
// **0x02 Meteo**) was recorded from a round where the spell was never cast.
// Re-running as Magus produced nothing but $86 (the refusal buzz) once per
// press, so granting the job is not enough either.
//
// This one SCREENSHOTS the menu at each step instead of pressing blind.
//
//   node tools/monscan/meteo-probe.cjs                 # job 19 (Magus)
//   JOB=19 ROW=0 COL=2 node tools/monscan/meteo-probe.cjs
//   SHOTS=/tmp/out node tools/monscan/meteo-probe.cjs

const { Nes } = require('./nes.cjs');
const { mkdirSync } = require('fs');
const { join } = require('path');

const REPO = '/home/joeltco/projects/ff3mmo';
// ROM is overridable so a HEX-PATCHED rom can be probed. Level 8 cannot be
// cast headlessly (see refusal-trace.cjs), so the way to hear Meteor is to
// patch its 8-byte spell record over a level-1 slot a Black Mage CAN cast.
const ROM = process.env.ROM || (REPO + '/FF3-English.nes');

const JOB = parseInt(process.env.JOB || '19', 10);      // 19 = Magus (maxMagicLv 8)
const MASK = parseInt(process.env.MASK || '0x3f', 16);  // all black + white columns
const ROW = parseInt(process.env.ROW || '0', 10);       // 0 = level 8
const COL = parseInt(process.env.COL || '2', 10);       // Meteo
const SHOTS = process.env.SHOTS || '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/meteo';
const FRAMES = parseInt(process.env.FRAMES || '1200', 10);

mkdirSync(SHOTS, { recursive: true });

const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MP_OFF = 0x30, SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;

const sfx = [];
const songs = [];
let frame = -1;
const n = new Nes(ROM, {
  onBatteryRamWrite: (addr, val) => {
    const a = addr | 0, v = val & 0xFF;
    // Capture the PC too. The refusal buzz's WRITE SITE is what tells us which
    // branch to patch — guessing at the check is how wrong patches happen.
    const pc = n.nes.cpu.REG_PC;
    if (a === 0x7F49) sfx.push({ f: frame, v, pc });
    else if (a === 0x7F43) songs.push({ f: frame, v, pc });
  },
});

/** Same grant as spell-sweep, plus the job-level/MP the level-8 list needs. */
function grant() {
  const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
  n.ram[a] = JOB; n.ram[a + 1] = 99;                 // job + character level
  n.ram[b + JOB_LEVELS_OFF + JOB * 2] = 99;          // job level
  for (let l = 0; l < 8; l++) {
    n.ram[a + MP_OFF + l * 2] = 9; n.ram[a + MP_OFF + l * 2 + 1] = 9;
    n.ram[b + SPELL_LIST_OFF + l] = MASK;
  }
  for (let c = 2; c < 4; c++) {                      // kill 3 and 4, keep 2
    const blk = SRAM_BASE + CHARS_A_OFF + c * 0x40;
    n.ram[blk + 0x0C] = 0; n.ram[blk + 0x0D] = 0;
    n.ram[blk + 0x0E] = 0; n.ram[blk + 0x0F] = 0;
  }
}

const spriteCount = () => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};

// ── boot + reach a battle (same choreography the other sweeps use) ────────
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
let inBattle = false;
for (let blk = 0; blk < 20 && !inBattle; blk++) {
  for (let k = 0; k < 6 && !inBattle; k++) { grant(); n.press('a', 8, 25); inBattle = spriteCount() > 12; }
  if (!inBattle) { grant(); n.press('down', 8, 40); inBattle = spriteCount() > 12; }
}
if (!inBattle) { console.error('never reached a battle'); process.exit(1); }
n.run(60);
grant();
n.screenshot(join(SHOTS, '1-battle.png'));

// ── open the magic list and LOOK before committing ────────────────────────
n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
n.screenshot(join(SHOTS, '2-magic-list.png'));
console.log('opened magic list -> 2-magic-list.png');

for (let i = 0; i < ROW; i++) n.press('down', 8, 24);
for (let i = 0; i < COL; i++) n.press('right', 8, 24);
n.screenshot(join(SHOTS, '3-cursor.png'));
console.log(`cursor at row ${ROW} col ${COL} -> 3-cursor.png`);

const sfxBefore = sfx.length;
n.press('a', 8, 30);
n.screenshot(join(SHOTS, '4-after-pick.png'));
const picked = sfx.slice(sfxBefore).map(w => '$' + w.v.toString(16) + '@PC=$' + (w.pc || 0).toString(16));
console.log('sounds on the pick press: ' + (picked.join(' ') || '(none)') +
  (picked.includes('$86') ? '   <-- $86 = REFUSAL BUZZ, the spell was NOT cast' : ''));

n.press('a', 8, 30);              // target select
// Character 2's command menu does not open until the target selection has
// finished animating; pressing straight through left the round un-committed and
// the capture window recorded a battle that never took its turn.
n.run(120);
n.press('down', 8, 30); n.press('a', 8, 30);   // char 2 guards
n.run(60);

// Do not assume the round started. With characters 3 and 4 killed the engine
// still sometimes sits on a command menu, and the capture window then records
// 1200 frames of a battle that never took its turn — which reads exactly like
// "this spell makes no sound". Drive Guard until the round is actually moving,
// and remember how many presses it took so their menu blips can be discounted.
// Window opens HERE, before the kicks — the previous version started counting
// after them and the cast had already played inside the kick loop, so the
// capture came back with only the tail of the round.
const start = sfx.length, songStart = songs.length;
let kicks = 0;
{
  const before = sfx.length;
  for (let attempt = 0; attempt < 10; attempt++) {
    const mark = sfx.length;
    n.run(90);
    if (sfx.length > mark) break;            // something is happening
    n.press('down', 8, 20); n.press('a', 8, 20);
    kicks++;
  }
  if (sfx.length === before && kicks >= 10) console.log('WARNING: round never started');
}
console.log('kicks needed to start the round: ' + kicks);
n.screenshot(join(SHOTS, '5-committed.png'));

// ── capture ───────────────────────────────────────────────────────────────
for (let f = 0; f < FRAMES; f++) {
  frame = f;
  n.nes.frame();
  if (f === 120 || f === 300 || f === 600 || f === 900) n.screenshot(join(SHOTS, `6-cast-f${f}.png`));
}

const own = sfx.slice(start), ownSongs = songs.slice(songStart);
console.log('\nSFX during the cast window:');
const MENU = { 0x85: 'menu confirm (a kick press)', 0x86: 'refusal buzz', 0x98: 'cursor move' };
for (const w of own) console.log('  $' + w.v.toString(16) + ' -> nsf track ' + (w.v - 0x3f) + '  @f' + w.f +
  (MENU[w.v] ? '   [' + MENU[w.v] + ']' : ''));
console.log('SONG requests during the cast window:');
for (const w of ownSongs) console.log('  song ' + w.v + '  @f' + w.f);
if (!own.length && !ownSongs.length) console.log('  (nothing)');
console.log('\nshots -> ' + SHOTS);
