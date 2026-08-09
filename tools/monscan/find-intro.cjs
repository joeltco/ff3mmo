// Breadth-first search for the button sequence that gets FF3 from the name
// screen into gameplay.
//
// Hand-guessing this failed four times: the naming screen accepts a letter,
// takes a confirm, then silently ignores further input for reasons that aren't
// obvious from the outside. Rather than keep theorising about FF3's input
// debounce, snapshot the name screen once and brute-force short button
// sequences against it — the emulator is fast and savestates make each trial
// nearly free.
//
// Success signal: the name grid disappears. The grid occupies most of the lower
// screen, so a transition moves hundreds of nametable tiles at once; a cursor
// step moves one or two.

const { Nes } = require('./nes.cjs');
const { writeFileSync } = require('fs');

const ROM = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const BUTTONS = ['a', 'start', 'b', 'down', 'right', 'up', 'left', 'select'];
const TRANSITION_TILES = 0; // replaced by pixel fraction below

const n = new Nes(ROM);
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);   // through the opening crawl
const nameScreen = n.save();

// Compare RENDERED PIXELS, not nametable tile ids.
//
// Two earlier signals both lied. Whole-screen tile diff counted "advanced to
// the next character's name screen" as success. Grid-region tile diff still
// fired, because the game redraws the alphabet with different tile ids that
// render identically — 313 of 480 tiles "changed" on a visually identical
// screen. The framebuffer is the only thing that can't be fooled: two name
// screens look the same, gameplay doesn't.
function pixelSig() {
  const s = [];
  for (let y = 0; y < 240; y += 4)
    for (let x = 0; x < 256; x += 4)
      s.push(n.fb[y * 256 + x] & 0xFFFFFF);
  return s;
}
// Sample the baseline under EXACTLY the trial conditions — restore the state,
// idle the same number of frames, then read. Sampling straight after the intro
// mash caught a mid-transition frame, so every trial scored as a huge change
// against a baseline that was never the settled name screen.
const SETTLE = 120;
n.load(nameScreen); n.run(SETTLE);
const baseSig = pixelSig();
const changed = () => pixelSig().reduce((a, v, i) => a + (v !== baseSig[i] ? 1 : 0), 0);
const TOTAL = baseSig.length;

// Guard: idling twice must score ~0, or the signal is still lying.
n.load(nameScreen); n.run(SETTLE);
console.log('idle-vs-idle noise:', changed(), '/', TOTAL);

console.log('name screen reached at frame', n.frames);

// Iterative deepening: try every sequence of length 1..MAXLEN.
const MAXLEN = 6;
let tried = 0;
let winner = null;

function walk(prefix) {
  if (winner) return;
  if (prefix.length === MAXLEN) return;
  for (const btn of BUTTONS) {
    if (winner) return;
    const seq = prefix.concat(btn);
    n.load(nameScreen);
    for (const b of seq) n.press(b, 8, 60);
    n.run(SETTLE);
    tried++;
    const d = changed();
    if (d > TOTAL * 0.35) {
      winner = { seq, d, frames: n.frames };
      n.screenshot('/tmp/intro-solved.png');
      return;
    }
    walk(seq);
  }
}

walk([]);

if (winner) {
  console.log('SOLVED:', winner.seq.join(' -> '), `(${winner.d} tiles moved, ${tried} tried)`);
  writeFileSync(__dirname + '/intro-sequence.json', JSON.stringify(winner.seq, null, 2));
} else {
  console.log('no sequence found up to length', MAXLEN, `(${tried} tried)`);
}
