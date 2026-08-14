// battle-sfx-capture.cjs — attribute FF3's BATTLE sounds to the events that
// produce them.
//
// `world-sfx-captured.js` covers the field sounds (doors, chests, warps) and
// `spell-sfx-captured.js` covers every spell impact. Five constants sit in
// neither, carried only in prose comments since v1.7.873:
//
//   MAGIC_CAST 98 ($a1)   CONFIRM 70 ($85)   ATTACK_HIT 113 ($b0)
//   KNIFE_HIT 119 ($b6)   MONSTER_DEATH 114 ($b1)
//
// This runs a real battle on an UNPATCHED ROM — the monster must be able to die
// and to hit back, which is exactly what the unkillable/harmless sweep goblin
// cannot do — and logs every $7F49 write with its frame plus a screenshot a
// moment later, so each sound can be tied to what was happening.
//
//   node tools/monscan/battle-sfx-capture.cjs
//   ROUNDS=6 SHOTS=/tmp/out node tools/monscan/battle-sfx-capture.cjs
//
// Prints the ordered timeline; the screenshots are the attribution evidence.

const { Nes } = require('./nes.cjs');
const { mkdirSync } = require('fs');
const { join } = require('path');

const ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const ROUNDS = parseInt(process.env.ROUNDS || '8', 10);
const SHOTS = process.env.SHOTS || '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/battlesfx';
mkdirSync(SHOTS, { recursive: true });

// Sounds that belong to the round rather than to any action — established by the
// spell sweep ($b6 at ~185f in 47 of 48 traces) and the battle-row table in
// world-sfx-captured.js. Kept visible rather than filtered: the point here is to
// find out what each one IS.
const NAMES = {
  0x85: 'CONFIRM?      ($85 -> 70)',
  0x98: 'CURSOR        ($98 -> 89)',
  0x86: 'ERROR/refusal ($86 -> 71)',
  0xa1: 'MAGIC_CAST?   ($a1 -> 98)',
  0xb0: 'ATTACK_HIT?   ($b0 -> 113)',
  0xb6: 'KNIFE_HIT?    ($b6 -> 119)',
  0xb1: 'MONSTER_DEATH?($b1 -> 114)',
  0xff: 'stop-sfx      ($ff)',
  0x95: 'BATTLE_SWIPE  ($95 -> 86)',
};

let frame = 0;
const events = [];
const pending = [];
const n = new Nes(ROM, {
  onBatteryRamWrite: (addr, val) => {
    if ((addr | 0) !== 0x7F49) return;
    const v = val & 0xFF;
    events.push({ f: frame, v });
    pending.push({ f: frame, v });
  },
});

const origFrame = n.nes.frame.bind(n.nes);
n.nes.frame = function () { frame++; return origFrame(); };

function run(k) {
  for (let i = 0; i < k; i++) {
    n.nes.frame();
    for (const p of pending) {
      // 25 frames later: long enough for the hit / death / message to be drawn,
      // short enough that the next action has not started.
      if (!p.done && frame - p.f === 25) {
        p.done = true;
        n.screenshot(join(SHOTS, `f${String(p.f).padStart(5, '0')}-$${p.v.toString(16)}.png`));
      }
    }
  }
}
const press = (b, hold = 8, after = 24) => { n.nes.buttonDown(1, require('./nes.cjs').BTN[b]); run(hold); n.nes.buttonUp(1, require('./nes.cjs').BTN[b]); run(after); };
const spriteCount = () => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};

// Boot + reach a battle (the shared monscan choreography).
run(300);
for (let i = 0; i < 25; i++) press('start', 6, 45);
for (let block = 0; block < 10; block++) {
  for (let k = 0; k < 6; k++) press('a', 8, 25);
  press('down', 8, 40);
}
run(600);
let inBattle = spriteCount() > 12;
for (let blk = 0; blk < 30 && !inBattle; blk++) {
  press('a', 8, 25); press('down', 8, 40);
  inBattle = spriteCount() > 12;
}
if (!inBattle) { console.error('never reached a battle'); process.exit(1); }
run(60);
n.screenshot(join(SHOTS, '00-battle.png'));
console.log('in battle at frame ' + frame);

// MODE=attack: everyone swings — the party's hits land and monsters die.
// MODE=guard:  everyone guards — nothing dies, so the MONSTERS get turn after
//              turn and their hits on the party are what sounds. An
//              attack-only run kills the encounter before a monster ever
//              connects, which is why $b0 never appeared in one.
const MODE = process.env.MODE || 'attack';
for (let r = 0; r < ROUNDS; r++) {
  for (let c = 0; c < 4; c++) {
    if (MODE === 'guard') { press('down', 8, 22); press('a', 8, 26); }
    else { press('a', 8, 26); press('a', 8, 26); }
  }
  run(480);
}

console.log('\ntimeline (every $7F49 write, with a screenshot 25f later):\n');
for (const e of events) {
  console.log(`  f${String(e.f).padStart(6)}  $${e.v.toString(16).padStart(2, '0')}  ${NAMES[e.v] || ''}`);
}
const counts = new Map();
for (const e of events) counts.set(e.v, (counts.get(e.v) || 0) + 1);
console.log('\ncounts:');
for (const [v, c] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  $${v.toString(16).padStart(2, '0')} -> nsf ${String(v - 0x3f).padStart(3)}  x${c}  ${NAMES[v] || ''}`);
}
console.log('\nshots -> ' + SHOTS);
