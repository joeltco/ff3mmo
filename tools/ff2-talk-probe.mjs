#!/usr/bin/env node
// ff2-talk-probe.mjs — what does an FF2 NPC ACTUALLY say, and which table entry
// is that?
//
// WHY THIS EXISTS
// `dialogueId == objType` was adopted for FF2 off ONE coincidence: the first
// NPC you meet (Hilda, object type 1) says the string at index 1 of the table
// at 0x18010. Rendering the NPC sheet exposed it — 175 placed object types
// resolve to lines whose "speakers" include a pendant, a bell, a torch and an
// airship. Those are ASK/LEARN keywords, not people.
//
// THE METHOD — the rule is never assumed, only measured
//   1. boot a savestate standing on a town map
//   2. walk to a named tile and press A at the NPC there
//   3. read the box straight off the nametable. FF2 has already expanded the
//      text by the time it draws, so TILE INDEX == CHARACTER CODE (the same
//      trick that decoded all three scripts)
//   4. find that text in the ROM, walk back to the string's start
//   5. find which table holds a pointer to it, and at which index
//
// Step 5 produces the id. Comparing it to the object type placed on that tile
// is the whole experiment.
//
//   node tools/ff2-talk-probe.mjs --state ff2-town.state --talk 7,19
//   node tools/ff2-talk-probe.mjs --state ff2-town.state --map 0x3510,4 --all
//
// ⛔ jsnes' mmap.load returns the byte at ADDR-1 for this ROM. Everything here
// reads `nes.ppu.vramMem`, `nes.cpu.mem` and the raw ROM file, never mmap.load.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { createCanvas } from '@napi-rs/canvas';

const F2 = await import('./lib/ff2-text.mjs');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const SHOT = flag('shot', null);
const TALK = flag('talk', null);
const MAP = flag('map', '0x3510,4');
const ALL = args.includes('--all');
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

/** MEASURED by stepping and diffing all 2KB of RAM: only these track the walk. */
const PLAYER_X = 0x68, PLAYER_Y = 0x69;

const rom = new Uint8Array(fs.readFileSync(ROMP));
const fb = new Uint32Array(256 * 240);
const nes = new NES({ onFrame: (b) => fb.set(b), onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));

const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const BTN = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
  start: Controller.BUTTON_START, select: Controller.BUTTON_SELECT,
};
// ⛔ a `!BTN[k]` guard is WRONG here: jsnes numbers BUTTON_A as 0.
const press = (k, hold = 6, after = 14) => {
  nes.buttonDown(1, BTN[k]); run(hold); nes.buttonUp(1, BTN[k]); run(after);
};
const at = () => [nes.cpu.mem[PLAYER_X], nes.cpu.mem[PLAYER_Y]];

if (!STATE) { console.error('--state is required (a savestate standing on a town map)'); process.exit(1); }
const RESET = fs.readFileSync(STATE, 'utf8');
const reset = () => {
  nes.fromJSON(JSON.parse(RESET));
  run(8);
  press('b'); press('b'); run(40);   // close whatever box the state was parked in
};

/** Walk to (tx,ty). Alternates axes so a wall on one of them still routes. */
function goTo(tx, ty, tries = 80) {
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

// ── reading the screen ────────────────────────────────────────────────────
// The PPU draws ゛ as its own tile over the base kana, so the nametable holds
// タ where the ROM holds the composed ダ. Normalise both sides or every word
// with a voiced consonant fails to match — which is most of them.
const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '');

/** Sentence-like text on screen, from ALL four nametables (FF2 scrolls). */
function screenLines() {
  const v = nes.ppu.vramMem;
  const out = [];
  for (const base of [0x2000, 0x2400, 0x2800, 0x2C00]) {
    for (let r = 0; r < 30; r++) {
      const bytes = [];
      for (let c = 0; c < 32; c++) bytes.push(v[base + r * 32 + c]);
      const runs = [];
      let cur = [];
      // 0xFF is a SPACE and belongs inside a run — breaking on it chops a
      // sentence into fragments too short and too samey to identify.
      for (const b of bytes) {
        if (F2.glyph(b) !== null) cur.push(b);
        else { if (cur.length >= 6) runs.push(cur); cur = []; }
      }
      if (cur.length >= 6) runs.push(cur);
      // Rank by VARIETY: the message-box border is a long run of two tiles,
      // while a sentence of the same length uses a dozen characters.
      for (const rn of runs) {
        if (new Set(rn).size < 6) continue;
        out.push(strip(rn.map(b => F2.glyph(b)).join('')).replace(/^ +| +$/g, ''));
      }
    }
  }
  return out;
}

// One normalised character per ROM byte, so an index into this string IS a
// file offset. A byte with no glyph becomes NUL, never a space, or arbitrary
// data would match the spaces inside a sentence.
const romStr = Array.from(rom, b => {
  const c = F2.glyph(b);
  return c === null ? '\0' : strip(c);
}).join('');

/**
 * Where in the ROM is this displayed line?
 *
 * ⛔ A displayed line is NOT contiguous in the ROM: `18 NN` name/keyword
 * inserts splice other strings into it, so "ヒルダ「あいことばは" exists only on
 * screen. Match the longest CONTIGUOUS fragment instead.
 */
function locate(line) {
  for (let len = line.length; len >= 6; len--) {
    for (let i = 0; i + len <= line.length; i++) {
      const frag = line.slice(i, i + len);
      if (frag.includes('\0') || !/[ぁ-んァ-ン]/.test(frag)) continue;
      const hits = [];
      for (let k = romStr.indexOf(frag); k !== -1; k = romStr.indexOf(frag, k + 1)) hits.push(k);
      if (hits.length) return { frag, hits };
    }
  }
  return null;
}

/**
 * Which table entry points at the string containing `off`?
 *
 * The string starts after the previous 0x00 terminator. A pointer to it is its
 * little-endian NES address; FF2 is MMC1, so the bank holding `start` appears
 * at $8000 (or $C000 when it is the last bank).
 */
function resolveId(off, tables = [0x18010, 0x28010, 0x4010]) {
  let start = off;
  while (start > 0 && rom[start - 1] !== 0x00) start--;
  const out = { start, ids: [], sites: [] };
  const TOTAL = (rom.length - 0x10) / 0x4000;
  const bankIdx = Math.floor((start - 0x10) / 0x4000);
  const bankStart = 0x10 + bankIdx * 0x4000;
  for (const winBase of (bankIdx === TOTAL - 1 ? [0xC000] : [0x8000, 0xC000])) {
    const nesAddr = winBase + (start - bankStart);
    const lo = nesAddr & 0xFF, hi = (nesAddr >> 8) & 0xFF;
    for (const base of tables) {
      for (let id = 0; id < 1024; id++) {
        const p = base + id * 2;
        if (p + 1 >= rom.length) break;
        if (rom[p] === lo && rom[p + 1] === hi) out.ids.push({ base, id, nesAddr });
      }
    }
    for (let p = 0x10; p < rom.length - 1; p++) {
      if (rom[p] === lo && rom[p + 1] === hi) out.sites.push(p);
    }
  }
  return out;
}

/** Walk to a tile, face the NPC on it, press A, and report what it said. */
function talkTo(tx, ty) {
  const SPOTS = [
    [tx, ty + 1, 'up'], [tx - 1, ty, 'right'], [tx + 1, ty, 'left'], [tx, ty - 1, 'down'],
  ];
  for (const [sx, sy, dir] of SPOTS) {
    reset();
    if (!goTo(sx, sy)) continue;
    press(dir);            // the NPC tile is solid, so this only turns us
    press('a'); run(28);
    const lines = screenLines().filter(l => !/^[ヘホ]+$/.test(l));
    // "そのほうこうには なにもない" = nothing in that direction -> wrong side
    if (!lines.length || lines.some(l => l.includes('なにもない'))) continue;
    return { from: [sx, sy], dir, lines };
  }
  return null;
}

// ── run it ────────────────────────────────────────────────────────────────
const [blockStr, mapStr] = MAP.split(',');
const BLOCK = parseInt(blockStr, 16), MAPI = parseInt(mapStr, 10);
const objects = F2.mapObjects(rom, BLOCK, MAPI);

const targets = ALL
  ? objects.map(o => ({ x: o.x, y: o.y, type: o.type }))
  : TALK
    ? [{
        x: +TALK.split(',')[0], y: +TALK.split(',')[1],
        type: objects.find(o => o.x === +TALK.split(',')[0] && o.y === +TALK.split(',')[1])?.type,
      }]
    : [];

if (!targets.length) { console.error('give --talk X,Y or --all'); process.exit(1); }

console.log(`FF2 talk probe — block 0x${BLOCK.toString(16)} map ${MAPI}\n`);
const results = [];
for (const t of targets) {
  const said = talkTo(t.x, t.y);
  if (!said) { console.log(`(${t.x},${t.y}) type ${t.type}: no box opened from any side\n`); continue; }
  const line = [...said.lines].sort((a, b) => b.length - a.length)[0];
  const loc = locate(line);
  console.log(`(${t.x},${t.y})  objType ${t.type}  [from ${said.from} facing ${said.dir}]`);
  console.log(`    said: "${said.lines.join(' / ').slice(0, 76)}"`);
  if (!loc) { console.log('    not found in the ROM\n'); continue; }
  const r = resolveId(loc.hits[0]);
  const ids = r.ids.map(i => `0x${i.base.toString(16)}[${i.id}]`).join(', ') || '(no known table)';
  console.log(`    string @0x${r.start.toString(16)}  ->  ${ids}`);
  const hit = r.ids.find(i => i.base === 0x18010);
  if (hit) console.log(`    ${hit.id === t.type ? '✓ id == objType' : `✗ id ${hit.id} != objType ${t.type}`}`);
  console.log('');
  results.push({ ...t, id: hit?.id ?? null });
}

const checkable = results.filter(r => r.id !== null && r.type !== undefined);
if (checkable.length) {
  const same = checkable.filter(r => r.id === r.type).length;
  console.log(`── ${same}/${checkable.length} objects have dialogue id == objType ──`);
}

if (SHOT) {
  const cv = createCanvas(256, 240);
  const g = cv.getContext('2d');
  const img = g.createImageData(256, 240);
  for (let i = 0; i < 256 * 240; i++) {
    const p = fb[i];
    img.data[i * 4] = p & 0xFF; img.data[i * 4 + 1] = (p >> 8) & 0xFF;
    img.data[i * 4 + 2] = (p >> 16) & 0xFF; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  fs.writeFileSync(SHOT, cv.toBuffer('image/png'));
  console.log(`\nshot -> ${SHOT}`);
}
