// refusal-trace.cjs — WHY does the game refuse a level-8 spell?
//
// The refusal buzz ($86 -> $7F49) is written from $fb00, which is the shared
// sound-request routine — it tells us nothing about the branch that decided to
// refuse. So: keep a ring buffer of every PC executed, and when the refusal
// write lands, dump the instructions that ran just before it. That is the
// decision path, measured, and it is what says which byte to patch.
//
//   node tools/monscan/refusal-trace.cjs
//   JOB=19 ROW=0 COL=2 DEPTH=120 node tools/monscan/refusal-trace.cjs

const { Nes } = require('./nes.cjs');

const ROM = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const JOB = parseInt(process.env.JOB || '19', 10);
const MASK = parseInt(process.env.MASK || '0x3f', 16);
const ROW = parseInt(process.env.ROW || '0', 10);
const COL = parseInt(process.env.COL || '2', 10);
const DEPTH = parseInt(process.env.DEPTH || '160', 10);

const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const MP_OFF = 0x30, SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;

let armed = false;
let caught = null;
const ring = new Int32Array(4096);
const ringA = new Int32Array(4096);   // accumulator at that PC
const ringX = new Int32Array(4096);
const ringY = new Int32Array(4096);
let ri = 0;

const n = new Nes(ROM, {
  onBatteryRamWrite: (addr, val) => {
    if (!armed || caught) return;
    if ((addr | 0) === 0x7F49 && (val & 0xFF) === 0x86) {
      const out = [];
      for (let k = DEPTH; k >= 1; k--) {
        const i = (ri - k + ring.length) % ring.length;
        if (!ring[i]) continue;
        out.push({ pc: ring[i], a: ringA[i], x: ringX[i], y: ringY[i] });
      }
      caught = out;
    }
  },
});

// Ring-record every executed instruction.
const cpu = n.nes.cpu;
const origEmulate = cpu.emulate.bind(cpu);
cpu.emulate = function () {
  // Record GAME code only. The sound engine and NMI live at $f800+ and spin in
  // a wait loop, which swamped a 4000-instruction window with $fb81/$fb83 and
  // hid the branch that actually decided to refuse.
  if (cpu.REG_PC >= 0xf000) return origEmulate();
  ring[ri] = cpu.REG_PC;
  ringA[ri] = cpu.REG_ACC;
  ringX[ri] = cpu.REG_X;
  ringY[ri] = cpu.REG_Y;
  ri = (ri + 1) % ring.length;
  return origEmulate();
};

function grant() {
  const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
  n.ram[a] = JOB; n.ram[a + 1] = 99;
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
}
const sc = () => { let c = 0; for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++; return c; };

n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
let ib = false;
for (let blk = 0; blk < 20 && !ib; blk++) {
  for (let k = 0; k < 6 && !ib; k++) { grant(); n.press('a', 8, 25); ib = sc() > 12; }
  if (!ib) { grant(); n.press('down', 8, 40); ib = sc() > 12; }
}
if (!ib) { console.error('never reached a battle'); process.exit(1); }
n.run(60); grant();

n.press('a', 8, 30); n.press('down', 8, 30); n.press('a', 8, 30);
for (let i = 0; i < ROW; i++) n.press('down', 8, 24);
for (let i = 0; i < COL; i++) n.press('right', 8, 24);

armed = true;                     // only from the pick press onward
n.press('a', 8, 40);

if (!caught) { console.log('no refusal buzz seen — the pick may have SUCCEEDED'); process.exit(0); }

console.log(`refusal traced — last ${caught.length} instructions before $86 hit $7F49:\n`);
// Collapse the shared sound routine's tail; the interesting part is the caller.
for (const e of caught) {
  console.log('  PC=$' + e.pc.toString(16).padStart(4, '0') +
    '  A=$' + e.a.toString(16).padStart(2, '0') +
    ' X=$' + e.x.toString(16).padStart(2, '0') +
    ' Y=$' + e.y.toString(16).padStart(2, '0'));
}

// The call site: the highest PC below $f000 seen recently is usually the
// battle-menu code, since $fb00 is the sound stub in the fixed bank.
const callers = caught.filter(e => e.pc < 0xf000).map(e => e.pc);
if (callers.length) {
  const uniq = [...new Set(callers)].sort((a, b) => a - b);
  console.log('\nnon-$f000 PCs in the window (the deciding code):');
  console.log('  ' + uniq.map(p => '$' + p.toString(16)).join(' '));
}
