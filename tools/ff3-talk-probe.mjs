#!/usr/bin/env node
// ff3-talk-probe.mjs — walk to each FF3 NPC on a map, talk, read the box off
// the screen, and check it against the string id the rule PREDICTED.
//
// WHY
// `stringId = npcId + 0x202` rests on FOUR measurements, and a small constant
// offset is exactly the shape that has been wrong twice already (FF1's
// `dialogueId == objType`, FF2's the same). See
// `feedback_one_confirmation_is_not_a_rule`.
//
// WHAT THE CPU ACTUALLY DOES, from `tools/ff3-talk-trace.mjs`:
//   3B/B6BF  LDX $71          ; the NPC's slot
//   3B/B6C1  LDA $0740,X      ; a PER-NPC dialogue byte held in RAM
//   3B/B6C4  STA $76          ; -> the string id LOW byte
//   3B/B6C6  LDA #$84         ; base $8400 -> string block 0x200
//   3B/B6CA  BEQ ; else LDA #$86   ; ...or $8600 -> block 0x300 when $78 is set
//   3F/E231  LDA $76 / STA $92
//   3F/EE9F  LDA $92 / ASL A / TAY / LDA ($94),Y    ; the pointer fetch
//
// ⛔ So the id is NOT computed from the npcId by arithmetic — it is a per-NPC
// byte in RAM, and there is a SECOND string block. `+0x202` can only ever be a
// description of what that table happens to contain, never a derivation. This
// probe measures whether the description holds.
//
//   node tools/ff3-talk-probe.mjs --state ff3-freeroam.state --map 7
//   node tools/ff3-talk-probe.mjs --state ff3-freeroam.state --map 7 --npc 4,3
//
// ⛔ FF3 compresses text (DTE), so screen text is matched against DECODED
// strings, and EVERY matching id is reported — an ambiguity stays visible.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const { loadRom, decodeString, glyph } = await import('./lib/ff3-text.mjs');
const { loadMap } = await import('../src/map-loader.js');
// ⛔ do NOT import npc-dialogue.mjs — it is a script and prints its whole dump
// on import. The constant is small; it is mirrored here with its source named.
const NPC_DIALOGUE_BASE = 0x202;   // == npc-dialogue.mjs#NPC_DIALOGUE_BASE

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const MAP = parseInt(flag('map', '7'), 10);
const ONE = flag('npc', null);
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

/** MEASURED by walking and diffing — the same addresses FF1 and FF2 use. */
const PLAYER_X = 0x68, PLAYER_Y = 0x69;
/** MEASURED: 16 frames advances exactly one tile. 5 moves nothing at all. */
const STEP_HOLD = 16, STEP_REST = 16;
const WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;

const rom = loadRom(ROMP);
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
const RESET = fs.readFileSync(STATE, 'utf8');

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const DIR = {
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const press = (b, hold = STEP_HOLD, after = STEP_REST) => {
  nes.buttonDown(1, b); run(hold); nes.buttonUp(1, b); run(after);
};
const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];

/** Restore, warp to the map, settle. */
function reset() {
  nes.fromJSON(JSON.parse(RESET));
  run(8);
  for (let f = 0; f < 240; f++) {
    nes.cpu.mem[WARP_MAP] = MAP; nes.cpu.mem[WARP_FLAG] = 0x80;
    nes.frame();
    if (nes.cpu.mem[WARP_FLAG] !== 0x80) break;
  }
  run(180);
}

function goTo(tx, ty, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const [x, y] = at();
    if (x === tx && y === ty) return true;
    if (x !== tx && (i % 2 === 0 || y === ty)) press(DIR[x < tx ? 'right' : 'left']);
    else if (y !== ty) press(DIR[y < ty ? 'down' : 'up']);
    else return false;
  }
  const [x, y] = at();
  return x === tx && y === ty;
}

/** Text on screen — FF3 expands its text before drawing, so tile == char. */
function screenText() {
  const v = nes.ppu.vramMem;
  const out = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) { const g = glyph(v[base + r * 32 + c]); s += (g === null ? ' ' : g); }
      s = s.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{4,}/.test(s)) out.push(s);
    }
  }
  return out;
}

/** Ids whose decoded text contains this fragment. */
function idsMatching(frag) {
  const out = [];
  for (let id = 0x200; id < 0x400; id++) {
    const t = decodeString(rom, id).replace(/\s+/g, ' ').trim();
    if (t && t.includes(frag)) out.push(id);
  }
  return out;
}

function talkTo(tx, ty) {
  const SPOTS = [[tx, ty + 1, 'up'], [tx - 1, ty, 'right'], [tx + 1, ty, 'left'], [tx, ty - 1, 'down']];
  for (const [sx, sy, dir] of SPOTS) {
    reset();
    if (!goTo(sx, sy)) continue;
    press(DIR[dir]);
    press(Controller.BUTTON_A, 5, 40);
    const lines = screenText();
    if (lines.length) return { from: [sx, sy], dir, lines };
  }
  return null;
}

const md = loadMap(rom, MAP);
const npcs = (md.npcs || []).filter(n => !ONE ||
  (n.x === +ONE.split(',')[0] && n.y === +ONE.split(',')[1]));
console.log(`FF3 talk probe — map ${MAP}, ${npcs.length} NPC(s)\n`);

let good = 0, tried = 0;
for (const n of npcs) {
  const said = talkTo(n.x, n.y);
  if (!said) { console.log(`(${n.x},${n.y}) npcId ${n.id}: no box opened from any side\n`); continue; }
  const line = [...said.lines].sort((a, b) => b.length - a.length)[0];
  const frag = line.slice(0, 26);
  const hits = idsMatching(frag);
  const predicted = n.id + NPC_DIALOGUE_BASE;
  const ok = hits.includes(predicted);
  tried++; if (ok) good++;
  console.log(`(${n.x},${n.y})  npcId ${n.id}  [from ${said.from} facing ${said.dir}]`);
  console.log(`    on screen : "${frag}"`);
  console.log(`    ids whose text matches: ${hits.length ? hits.map(h => '0x' + h.toString(16)).join(', ') : '(none)'}`);
  console.log(`    npcId + 0x${NPC_DIALOGUE_BASE.toString(16)} predicts 0x${predicted.toString(16)}  ` +
              `${ok ? '✓ MATCHES the screen' : '✗ MISMATCH'}`);
  console.log('');
}
if (tried) {
  console.log(`── npcId + 0x${NPC_DIALOGUE_BASE.toString(16)} predicted ${good}/${tried} talked-to NPCs correctly ──`);
  if (good !== tried) process.exitCode = 1;
}
