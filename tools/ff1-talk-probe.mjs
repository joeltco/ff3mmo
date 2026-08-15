#!/usr/bin/env node
// ff1-talk-probe.mjs — walk to an FF1 NPC, talk, read the box off the screen,
// and check it against the string id the rule PREDICTED.
//
// WHY
// FF1's `objType -> dialogue` rule rested on ONE screen measurement (a Coneria
// Castle guard, type 32, string 49). FF2's rule looked just as settled off one
// measurement and was wrong — see `feedback_one_confirmation_is_not_a_rule`.
// This makes the measurement repeatable and plural.
//
// THE RULE, confirmed from the CPU by `tools/ff1-talk-trace.mjs`:
//   $902B  LDA $6F00,X          ; the object TYPE (X = slot)
//   $9034  ASL A / ROL $15      ; type * 2, 16-bit
//   $9037  ASL A / ROL $15      ; type * 4
//   $903A  ADC #$D5 / LDA #$95  ; + $95D5  = file 0x395E5
//   $9046  LDA ($14),Y          ; the four record bytes -> $10 $11 $12 $13
//   $9059  LDA $16 / ASL A / TAY
//   $906C  LDA $90D3,Y          ; a per-type CODE handler, then JMP ($0016)
// and the two handler shapes:
//   $941B  LDY $10 / JSR $9091 / BCS -> LDA $12 ; else LDA $11   (flag-gated)
//   $9492  LDA $11 / RTS                        (unconditional)
// so **record byte 1 is the default line** and byte 2 is the post-flag line.
//
//   node tools/ff1-talk-probe.mjs --state ff1-hall.state --all
//   node tools/ff1-talk-probe.mjs --state ff1-hall.state --talk 13,9
//
// ⛔ FF1 compresses text (DTE), so the ROM bytes are NOT the displayed bytes and
// a byte search finds nothing. Screen text is matched against DECODED strings
// instead. To keep that from being circular, the probe reports EVERY id whose
// text matches, not just the predicted one — if the decoder mapped two ids to
// the same text the ambiguity is visible rather than hidden.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';

const F1 = await import('./lib/ff1-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const TALK = flag('talk', null);
const ALL = args.includes('--all');
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';

/** MEASURED by stepping and diffing all of RAM + cartridge WRAM. */
const PLAYER_X = 0x68, PLAYER_Y = 0x69;
/** MEASURED: a hold of 6 frames advances exactly one tile. */
const STEP_HOLD = 6, STEP_REST = 26;

const rom = F1.loadRom(ROMP);
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
const RESET = fs.readFileSync(STATE, 'utf8');

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const BTN = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP,
  down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const press = (k, hold = STEP_HOLD, after = STEP_REST) => {
  nes.buttonDown(1, BTN[k]); run(hold); nes.buttonUp(1, BTN[k]); run(after);
};
const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];
const mapId = () => nes.cpu.mem[F1.MAP_ID_ADDR];
const reset = () => { nes.fromJSON(JSON.parse(RESET)); run(20); press('b'); press('b'); run(20); };

/** Walk to (tx,ty), alternating axes so a wall on one still routes. */
function goTo(tx, ty, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const [x, y] = at();
    if (x === tx && y === ty) return true;
    if (x !== tx && (i % 2 === 0 || y === ty)) press(x < tx ? 'right' : 'left');
    else if (y !== ty) press(y < ty ? 'down' : 'up');
    else return false;
  }
  const [x, y] = at();
  return x === tx && y === ty;
}

/**
 * The text on screen. By the time FF1 draws a box it has already expanded the
 * DTE, so the nametable tiles ARE the characters (tile index == char code).
 * All four nametables, because the previous screen's tiles linger.
 */
function screenText() {
  const v = nes.ppu.vramMem;
  const lines = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) {
        const g = F1.glyph(v[base + r * 32 + c]);
        s += (g === null || g === '\n') ? ' ' : g;
      }
      s = s.trim();
      if (/[A-Za-z]{4,}/.test(s)) lines.push(s);
    }
  }
  return lines;
}

/** Ids whose decoded text contains this screen fragment. */
function idsMatching(frag, limit = 0x200) {
  const out = [];
  for (let id = 0; id < limit; id++) {
    const t = F1.decodeString(rom, id, { nl: ' ' }).replace(/\s+/g, ' ').trim();
    if (t && t.replace(/\s+/g, ' ').includes(frag)) out.push(id);
  }
  return out;
}

/** Walk next to a tile, face it, press A, and report what appeared. */
function talkTo(tx, ty) {
  const SPOTS = [[tx, ty + 1, 'up'], [tx - 1, ty, 'right'], [tx + 1, ty, 'left'], [tx, ty - 1, 'down']];
  for (const [sx, sy, dir] of SPOTS) {
    reset();
    if (!goTo(sx, sy)) continue;
    press(dir);
    press('a'); run(30);
    const lines = screenText();
    // ⛔ "Nothing here." means NO OBJECT is standing there — FF1 spawns some
    // map objects conditionally (a story NPC who has been kidnapped is absent),
    // so a ROM coordinate is not a promise that anyone is on it. Counting that
    // as a rule failure would be wrong; keep looking from another side.
    if (lines.length && !lines.some(l => /^Nothing here/.test(l))) {
      return { from: [sx, sy], dir, lines };
    }
  }
  return null;
}

reset();
const MAP = mapId();
const objects = F1.mapObjects(rom, MAP);
console.log(`FF1 talk probe — map ${MAP}, player starts at ${at()}\n`);

const targets = ALL ? objects.map(o => ({ x: o.x, y: o.y, type: o.type }))
  : TALK ? [{ x: +TALK.split(',')[0], y: +TALK.split(',')[1] }] : [];
if (!targets.length) { console.error('give --talk X,Y or --all'); process.exit(1); }

let good = 0, tried = 0;
for (const t of targets) {
  const obj = objects.find(o => o.x === t.x && o.y === t.y);
  const type = obj ? obj.type : t.type;
  const said = talkTo(t.x, t.y);
  if (!said) {
    // absent (conditional spawn) or unreachable — reported, never counted
    const live = Array.from({ length: 16 }, (_, i) => nes.cpu.mem[0x6F00 + i * 0x10]);
    console.log(`(${t.x},${t.y}) type ${type}: nobody there` +
                `${live.includes(type) ? ' (in RAM, but unreachable)' : ' (not spawned — RAM slot empty)'}\n`);
    continue;
  }
  const line = [...said.lines].sort((a, b) => b.length - a.length)[0];
  const frag = line.replace(/\s+/g, ' ').trim().slice(0, 28);
  const hits = idsMatching(frag);
  const predicted = F1.dialogueForType(rom, type);
  const ok = hits.includes(predicted);
  tried++; if (ok) good++;
  console.log(`(${t.x},${t.y})  objType ${type}  [from ${said.from} facing ${said.dir}]`);
  console.log(`    on screen : "${frag}"`);
  console.log(`    ids whose text matches: ${hits.length ? hits.join(', ') : '(none)'}`);
  console.log(`    record [${F1.dialogueRecordForType(rom, type)}] predicts string ${predicted}  ` +
              `${ok ? '✓ MATCHES the screen' : '✗ MISMATCH'}`);
  console.log('');
}
if (tried) {
  console.log(`── record byte 1 predicted ${good}/${tried} talked-to objects correctly ──`);
  if (good !== tried) process.exitCode = 1;
}
