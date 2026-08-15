#!/usr/bin/env node
// nes12-npc-palette.mjs — what colours does an FF1 / FF2 NPC actually wear?
//
// The FF3 answer turned out to be per-MAP (see tools/ff3-npc-palette.mjs):
// a shared palette library indexed by the map's own properties, with no per-NPC
// selection at all. FF1 and FF2 need the same treatment rather than the same
// assumption — they are a different engine generation, and an NPC's palette
// could just as well ride the object type.
//
// THE METHOD, identical for both games
//   * read the sprite palettes at $3F10-$3F1F
//   * read OAM, cluster the 8x8 sprites into 16x16 NPCs, take each cluster's
//     palette index (attribute byte bits 0-1)
//   * report which indices NPCs use, and whether NPCs on ONE map differ
//
// That last point is the discriminating question:
//   all NPCs on a map share one index  -> the palette is a property of the MAP
//   NPCs on one map use different ones -> it rides the object/type
//
//   node tools/nes12-npc-palette.mjs --game ff1 --state ff1-castle.state
//   node tools/nes12-npc-palette.mjs --game ff2 --state ff2-town.state
//
// ⛔ The first entry of each sprite palette ($3F10/$3F14/$3F18/$3F1C) MIRRORS
// the BG backdrop and is not part of the palette — compare entries 1-3.
// ⛔ Build nothing before `nes.fromJSON`: it replaces `nes.cpu`.

import fs from 'node:fs';
import { NES, Controller } from 'jsnes';
import { makeTracer, bankAt, groupByPc, hex } from './lib/nes-trace.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const GAME = flag('game', 'ff1');
const STATE = flag('state', null);
const STEPS = parseInt(flag('steps', '0'), 10);
const TRACE = args.includes('--trace');
const GOTO = flag('goto', null);

const GAMES = {
  ff1: {
    rom: process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes',
    mapId: 0x0048,
    /** MEASURED: live map objects, 16 bytes apart, byte 0 = type. */
    objRam: 0x6F00, objStride: 0x10, objSlots: 16,
    hold: 6,
  },
  ff2: {
    rom: process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes',
    mapId: null,
    objRam: null,
    hold: 6,
  },
};
const G = GAMES[GAME];
if (!G) { console.error(`--game must be ff1 or ff2`); process.exit(1); }
if (!STATE) { console.error('--state is required'); process.exit(1); }

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(G.rom, 'binary'));
nes.fromJSON(JSON.parse(fs.readFileSync(STATE, 'utf8')));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const press = (b, hold = G.hold, after = 22) => {
  nes.buttonDown(1, b); run(hold); nes.buttonUp(1, b); run(after);
};
const ROMBYTES = new Uint8Array(fs.readFileSync(G.rom));
run(20);
// close any box the state was parked in
press(Controller.BUTTON_B); press(Controller.BUTTON_B); run(30);
// ⛔ The palette is uploaded ON MAP LOAD, not per frame — so the hook has to be
// live BEFORE the walk that crosses a door, not after it.
const PALTRACE = args.includes('--paltrace');
const palWrites = [];
const bufWrites = [];
let palTracer = null;
if (PALTRACE) {
  palTracer = makeTracer(nes);
  // ⛔ FF1 re-uploads the WHOLE palette every frame from a RAM buffer at $03C0
  // ($03D0-$03DF = the four sprite palettes), so watching $2007 only ever shows
  // the copier. The interesting write is the one that FILLS that buffer.
  palTracer.onWrite = (addr, val, pc) => {
    // ⛔ $03C0 is only a COPY: $D8AB does `LDA $0780,X / STA $03C0,X`. The
    // palette actually lands in $0780 first, so watch both.
    if ((addr >= 0x03C0 && addr <= 0x03DF) || (addr >= 0x0780 && addr <= 0x07AF)) {
      // ⛔ FF1's map palette is copied `LDA ($10),Y / STA $0780,Y` for 0x30
      // bytes, with the high byte built by `ORA #$A0` — so the SET lives in the
      // $A000 half of the switchable window. Capture the pointer, not just the PC.
      bufWrites.push({ pc, addr, val, bank: bankAt(nes, ROMBYTES, 0x8000),
                       src: nes.cpu.mem[0x10] | (nes.cpu.mem[0x11] << 8) });
      return;
    }
    if (addr !== 0x2007) return;
    const v = nes.ppu.vramAddress & 0x3FFF;
    if (v >= 0x3F00 && v <= 0x3F1F) {
      palWrites.push({ pc, vram: v, val: val & 0x3F, bank: bankAt(nes, ROMBYTES, 0x8000) });
    }
  };
  palTracer.recording = true;
}

for (let i = 0; i < STEPS; i++) press(Controller.BUTTON_DOWN);

// ⛔ $68/$69 is the live player tile in ALL THREE games — same engine family.
const PX = 0x68, PY = 0x69;
const at = () => [nes.cpu.mem[PX], nes.cpu.mem[PY]];
if (GOTO) {
  const [tx, ty] = GOTO.split(',').map(Number);
  const D = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
              left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };
  for (let i = 0; i < 80; i++) {
    const [x, y] = at();
    if (x === tx && y === ty) break;
    if (x !== tx && (i % 2 === 0 || y === ty)) press(D[x < tx ? 'right' : 'left']);
    else if (y !== ty) press(D[y < ty ? 'down' : 'up']);
    else break;
  }
  console.log(`walked to ${at()} (wanted ${tx},${ty})`);
}

const hx = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');

/** The four sprite palettes as they stand in PPU memory. */
const spritePalettes = () => [0, 1, 2, 3].map(p =>
  [0, 1, 2, 3].map(c => nes.ppu.vramMem[0x3F10 + p * 4 + c] & 0x3F));
/** The four BG palettes, for context. */
const bgPalettes = () => [0, 1, 2, 3].map(p =>
  [0, 1, 2, 3].map(c => nes.ppu.vramMem[0x3F00 + p * 4 + c] & 0x3F));

/** Visible 16x16 sprite clusters and the palette index each draws in. */
function oamClusters() {
  const oam = nes.ppu.spriteMem;
  const cells = new Map();
  for (let s = 0; s < 64; s++) {
    const y = oam[s * 4], tile = oam[s * 4 + 1], attr = oam[s * 4 + 2], x = oam[s * 4 + 3];
    if (y >= 0xEF) continue;
    const key = `${Math.floor(x / 16)},${Math.floor(y / 16)}`;
    if (!cells.has(key)) cells.set(key, { x, y, pal: attr & 3, tiles: [], n: 0 });
    const c = cells.get(key);
    c.x = Math.min(c.x, x); c.y = Math.min(c.y, y);
    c.tiles.push(tile); c.n++;
  }
  return [...cells.values()].filter(c => c.n >= 2);
}

console.log(`══ ${GAME.toUpperCase()} — ${STATE.split('/').pop()} ══`);
if (G.mapId !== null) console.log(`map ($${G.mapId.toString(16)}) = ${nes.cpu.mem[G.mapId]}`);
if (G.objRam !== null) {
  const types = Array.from({ length: G.objSlots }, (_, i) => nes.cpu.mem[G.objRam + i * G.objStride]);
  console.log(`live object types: [${types.join(',')}]`);
}

const sp = spritePalettes(), bg = bgPalettes();
console.log('\nPPU sprite palettes ($3F10-$3F1F), entries 1-3:');
sp.forEach((p, i) => console.log(`   ${i}: ${hx(p.slice(1))}`));
console.log('PPU BG palettes ($3F00-$3F0F), entries 1-3:');
bg.forEach((p, i) => console.log(`   ${i}: ${hx(p.slice(1))}`));

const clusters = oamClusters();
console.log(`\n${clusters.length} on-screen 16x16 sprite cluster(s):`);
for (const c of clusters) {
  console.log(`   at (${String(c.x).padStart(3)},${String(c.y).padStart(3)})  palette ${c.pal}` +
              `  ${c.n} tiles  [${c.tiles.slice(0, 4).join(',')}]`);
}

// ── the discriminating question ───────────────────────────────────────────
// The player is a cluster too, so "how many palettes are in use" alone does not
// answer it. Report the spread, and let the caller compare across maps.
const byPal = new Map();
for (const c of clusters) byPal.set(c.pal, (byPal.get(c.pal) || 0) + 1);
console.log(`\npalette index -> cluster count: ` +
  [...byPal].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${p}:${n}`).join('  '));
console.log(`distinct palette indices on this ONE map: ${byPal.size}`);
// ⛔ Do NOT read "4 indices in use" as per-NPC variety: the PLAYER takes 0 and 1
// and every NPC takes 2 and 3. MEASURED by y-coordinate in both games —
// FF1 (112,76)=pal2 above (112,84)=pal3; FF2 (80,92)=pal2 above (80,100)=pal3 —
// and confirmed in code (FF2's layout tables hold only attrs 02/03/43).
const npcPals = [...byPal.keys()].filter(p => p >= 2).sort();
console.log(`  player uses 0/1; NPC clusters use ${npcPals.join('/') || '(none on screen)'}`);
console.log('  -> top half = sprite palette 2, bottom half = sprite palette 3');

// ── where does the ATTRIBUTE byte come from? ──────────────────────────────
// Both games build OAM in a RAM page and DMA it via $4014, so the palette index
// is written as byte 2 of each 4-byte entry in that page. Hooking those writes
// names the instruction that chooses an NPC's palette — which beats inferring it
// from correlations, the way the dialogue rules kept going wrong.
if (TRACE) {
  const t = makeTracer(nes);
  let dmaPage = -1;
  const attrWrites = [];
  t.onWrite = (addr, val, pc) => {
    if (addr === 0x4014) { dmaPage = val; return; }
    if (dmaPage < 0) return;
    const base = dmaPage << 8;
    if (addr >= base && addr < base + 0x100 && (addr - base) % 4 === 2) {
      // the attribute comes from `LDA ($80),Y` — record WHERE that points, so
      // the layout table can be read straight out of the ROM afterwards
      const src = nes.cpu.mem[0x80] | (nes.cpu.mem[0x81] << 8);
      attrWrites.push({ pc, slot: (addr - base) >> 2, val, pal: val & 3, src });
    }
  };
  t.recording = true;
  run(4);                       // one frame is a whole OAM rebuild
  t.recording = false;

  console.log(`\n── OAM attribute writes (DMA page $${dmaPage.toString(16)}00) ──`);
  if (!attrWrites.length) {
    console.log('  none seen — the page may be written before $4014 was observed; run more frames');
  }
  for (const [pc, ws] of groupByPc(attrWrites).slice(0, 10)) {
    const pals = [...new Set(ws.map(w => w.pal))].sort();
    const vals = [...new Set(ws.map(w => w.val))].sort((a, b) => a - b);
    console.log(`  ${hex(pc)}  ${String(ws.length).padStart(3)} write(s)  slots ${ws.length > 8 ? ws.slice(0, 8).map(w => w.slot).join(',') + '…' : ws.map(w => w.slot).join(',')}`);
    console.log(`         palette indices ${pals.join(',')}   raw bytes ${vals.map(v => '0x' + v.toString(16)).join(' ')}`);
    const srcs = [...new Set(ws.map(w => w.src))].sort((a, b) => a - b);
    console.log(`         ($80) pointed at ${srcs.slice(0, 6).map(v => hex(v)).join(' ')}${srcs.length > 6 ? ' …' : ''}`);
    console.log(`         bank at $8000 = ${bankAt(nes, new Uint8Array(fs.readFileSync(G.rom)), 0x8000)}` +
                `   -> node tools/dis6502-ff1.mjs ${GAME === 'ff2' ? '--ff2 ' : ''}<bank> <fileOffset>`);
  }
}

// ── where do the four sprite palettes come from? ──────────────────────────
// Knowing NPCs wear palettes 2 and 3 is only half the answer; the colours in
// those slots still have to be sourced. The hook above was live across the walk.
if (PALTRACE) {
  palTracer.recording = false;
  console.log(`\n── writes into PPU palette memory (${palWrites.length}) ──`);
  if (!palWrites.length) {
    console.log('  none — no map load happened during the walk. Use --goto to cross a door.');
  }
  for (const [pc, ws] of groupByPc(palWrites).slice(0, 6)) {
    console.log(`  ${hex(pc)}  ${ws.length} write(s)   bank at $8000 = ${ws[0].bank}` +
                `   -> node tools/dis6502-ff1.mjs ${GAME === 'ff2' ? '--ff2 ' : ''}${ws[0].bank} <fileOffset>`);
    console.log(`      ${ws.slice(0, 20).map(w => `${w.vram.toString(16)}=${w.val.toString(16).padStart(2, '0')}`).join(' ')}`);
  }
  console.log(`\n── writes into the $03C0 palette BUFFER (${bufWrites.length}) ──`);
  for (const [pc, ws] of groupByPc(bufWrites).slice(0, 8)) {
    const addrs = [...new Set(ws.map(w => w.addr))].sort((a, b) => a - b);
    console.log(`  ${hex(pc)}  ${ws.length} write(s)  bank ${ws[0].bank}` +
                `  -> ${(() => {
                  // ⛔ a PC at $C000+ lives in the FIXED last bank, not the one
                  // mapped at $8000 — using the $8000 bank disassembles garbage.
                  const total = (ROMBYTES.length - 0x10) / 0x4000;
                  const fixed = pc >= 0xC000;
                  const bank = fixed ? total - 1 : ws[0].bank;
                  const base = fixed ? 0xC000 : 0x8000;
                  const off = 0x10 + bank * 0x4000 + ((pc - 3) - base);
                  return `node tools/dis6502-ff1.mjs ${GAME === 'ff2' ? '--ff2 ' : ''}${bank} 0x${off.toString(16)}`;
                })()}`);
    console.log(`      addrs ${addrs.slice(0, 16).map(a => a.toString(16)).join(' ')}${addrs.length > 16 ? ` … (${addrs.length})` : ''}`);
    const srcs = [...new Set(ws.map(w => w.src))].sort((a, b) => a - b);
    console.log(`      ($10) pointed at ${srcs.slice(0, 5).map(v => hex(v)).join(' ')}${srcs.length > 5 ? ' …' : ''}`);
    const sprite = ws.filter(w => w.addr >= 0x03D8);
    if (sprite.length) console.log(`      NPC palette bytes ($03D8-$03DF): ` +
      sprite.slice(0, 8).map(w => `${w.addr.toString(16)}=${w.val.toString(16).padStart(2, '0')}`).join(' '));
  }

  // ⛔ do NOT dump every $2007 write: FF1 re-uploads all 32 bytes EVERY FRAME,
  // so a full dump is thousands of repeats of the same palette.
  const spr = palWrites.filter(w => w.vram >= 0x3F10);
  if (spr.length) {
    console.log(`\n  sprite palette, first upload: ${spr.slice(0, 16).map(w => w.val.toString(16).padStart(2, '0')).join(' ')}` +
                `   (${spr.length} sprite-palette writes total — it is re-sent every frame)`);
  }
}
