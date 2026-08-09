// Locate the RAM byte holding the current encounter's formation index.
//
// Strategy, entirely data-driven — no 6502 tracing, no guessed addresses:
//
//  1. The ROM's monster-set table ($2E:$8400, 6 bytes: pal0, pal1, id x4) is the
//     same table the encounter generator uses. Read it and collect every
//     formation index whose monster list is goblins-only, since the saved battle
//     is a goblin fight.
//  2. Scan the 2KB of work RAM for bytes holding one of those indices. That's a
//     small candidate set.
//  3. Prove which candidate is real: poke a formation with a visibly different
//     monster, let the battle redraw, and see whether that monster's tiles
//     actually appear on screen. The capture module already recognises a monster
//     by matching its ROM tile bytes, so this verifies itself.

const { readFileSync, writeFileSync } = require('fs');
const { execFileSync } = require('child_process');
const { Nes } = require('./nes.cjs');
const { catalogEntry, capture } = require('./capture.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const SET_OFF = 16 + 0x2E * 0x2000 + 0x400;

function notify(msg) {
  try { execFileSync('/home/joeltco/bin/vira-notify', [msg], { timeout: 120000 }); }
  catch { /* a failed push must never kill the run */ }
}

/** formation index -> [monster ids] (0xFF = empty slot) */
function formations() {
  const out = [];
  for (let i = 0; i < 256; i++) {
    const o = SET_OFF + i * 6;
    out.push({
      idx: i,
      pal0: rom[o], pal1: rom[o + 1],
      ids: [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF),
    });
  }
  return out;
}

const FORMS = formations();
const goblinOnly = FORMS.filter((f) => f.ids.length && f.ids.every((id) => id === 0x00))
                        .map((f) => f.idx);

// A target formation whose monster is big and unmistakable, and whose tiles the
// catalog knows, so a successful poke is obvious.
const target = FORMS.find((f) => f.ids.length && f.ids.every((id) => id === f.ids[0])
                                 && f.ids[0] !== 0x00 && catalogEntry(f.ids[0]));

console.log('goblin-only formation indices:', goblinOnly.join(', ') || '(none)');
console.log('probe target: formation', target && target.idx, '-> monster 0x' +
            (target ? target.ids[0].toString(16).padStart(2, '0') : '??'));

const battleState = JSON.parse(readFileSync(__dirname + '/battle-state.json', 'utf8'));
const nes = new Nes(REPO + '/FF3-English.nes');
nes.load(battleState);
nes.run(2);

// Step 2 — candidate addresses in work RAM.
const candidates = [];
for (let a = 0; a < 0x800; a++) if (goblinOnly.includes(nes.ram[a])) candidates.push(a);
console.log('candidate RAM addresses:', candidates.length);

// Step 3 — poke each candidate, redraw, look for the target monster.
const targetEntry = catalogEntry(target.ids[0]);
const hits = [];
for (const addr of candidates) {
  nes.load(battleState);
  nes.run(2);
  nes.ram[addr] = target.idx;
  nes.run(180);                              // let the battle re-render
  const res = capture(nes, targetEntry);
  if (res) {
    hits.push(addr);
    console.log(`HIT $${addr.toString(16).padStart(4, '0')} -> monster 0x` +
                target.ids[0].toString(16).padStart(2, '0') + ' rendered');
    nes.screenshot(`/tmp/formation-hit-${addr.toString(16)}.png`);
    break;
  }
}

if (hits.length) {
  writeFileSync(__dirname + '/formation-addr.json', JSON.stringify({ addr: hits[0] }));
  notify(`Formation byte found at $${hits[0].toString(16)}. Starting the full monster sweep.`);
} else {
  console.log('no candidate produced a different monster');
  notify('Formation byte not found by RAM poke — falling back to farming random encounters.');
}
