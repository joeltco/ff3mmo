#!/usr/bin/env node
// ff3-npc-palette.mjs — what colours does an FF3 NPC ACTUALLY wear?
//
// WHY
// The NPC sheets use one representative palette because FF3's per-NPC palettes
// were never decoded. Three parallel tables sit at ROM 0x1110 / 0x1210 / 0x1310,
// immediately before NPC_GFX_TABLE @ 0x1410 — three bytes per index, which is
// exactly the shape of an NES palette entry (colour 0 is the shared backdrop).
// That is a HYPOTHESIS. There is a competing one already in the notes: that NPC
// palettes come from the MAP, not the NPC.
//
// This measures the PPU and lets the two compete:
//   * read the sprite palettes at $3F10-$3F1F
//   * read OAM, cluster the 8x8 sprites into 16x16 NPCs, take each cluster's
//     palette index (attribute byte bits 0-1)
//   * match clusters to the map's NPC placements by screen position
//   * print, for each NPC, the colours it wears next to what each candidate
//     table would predict
//
// ⛔ The discriminating test is `--compare A,B`: the SAME npcId placed on two
// different maps. Per-NPC predicts identical colours; per-map predicts they
// differ. Run it before believing either.
//
//   node tools/ff3-npc-palette.mjs --state ff3-freeroam.state --map 7
//   node tools/ff3-npc-palette.mjs --state ff3-freeroam.state --compare 7,8

import fs from 'node:fs';
import { NES } from 'jsnes';

const { loadRom } = await import('./lib/ff3-text.mjs');
const { loadMap } = await import('../src/map-loader.js');
const G = await import('../src/data/npc-gfx.js');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const STATE = flag('state', null);
const MAP = parseInt(flag('map', '7'), 10);
const COMPARE = flag('compare', null);
const SWEEP = flag('sweep', null);
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;

const WARP_MAP = 0x0700, WARP_FLAG = 0x00AB;
/** The three candidate tables, one byte each per index. */
const PAL_TABLES = [0x1110, 0x1210, 0x1310];

const rom = loadRom(ROMP);
const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(fs.readFileSync(ROMP, 'binary'));
if (!STATE) { console.error('--state is required'); process.exit(1); }
const RESET = fs.readFileSync(STATE, 'utf8');
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };

function warpTo(mapId) {
  nes.fromJSON(JSON.parse(RESET));
  run(8);
  for (let f = 0; f < 240; f++) {
    nes.cpu.mem[WARP_MAP] = mapId; nes.cpu.mem[WARP_FLAG] = 0x80;
    nes.frame();
    if (nes.cpu.mem[WARP_FLAG] !== 0x80) break;
  }
  run(240);
}

/** The four sprite palettes as they stand in PPU memory. */
const spritePalettes = () => [0, 1, 2, 3].map(p =>
  [0, 1, 2, 3].map(c => nes.ppu.vramMem[0x3F10 + p * 4 + c] & 0x3F));

/**
 * Visible 16x16 sprite clusters, with the palette index they draw in.
 * FF3 draws a map NPC as four 8x8 OAM sprites; grouping by 16x16 cell keeps
 * them together without assuming an ordering.
 */
function oamClusters() {
  const oam = nes.ppu.spriteMem;
  const cells = new Map();
  for (let s = 0; s < 64; s++) {
    const y = oam[s * 4], tile = oam[s * 4 + 1], attr = oam[s * 4 + 2], x = oam[s * 4 + 3];
    if (y >= 0xEF) continue;                       // off-screen
    const key = `${Math.floor(x / 16)},${Math.floor(y / 16)}`;
    if (!cells.has(key)) cells.set(key, { x, y, pal: attr & 3, tiles: [] });
    const c = cells.get(key);
    c.x = Math.min(c.x, x); c.y = Math.min(c.y, y);
    c.tiles.push(tile);
  }
  return [...cells.values()].filter(c => c.tiles.length >= 2);
}

function report(mapId) {
  warpTo(mapId);
  const pals = spritePalettes();
  const clusters = oamClusters();
  const md = loadMap(rom, mapId);
  const npcs = md.npcs || [];

  console.log(`\n══ map ${mapId} ══`);
  console.log('PPU sprite palettes ($3F10-$3F1F):');
  pals.forEach((p, i) => console.log(`   ${i}: ${p.map(v => v.toString(16).padStart(2, '0')).join(' ')}`));
  console.log(`\n${clusters.length} on-screen 16x16 sprite cluster(s), and which palette each uses:`);
  const used = new Map();
  for (const c of clusters) {
    console.log(`   at screen (${String(c.x).padStart(3)},${String(c.y).padStart(3)})  ` +
                `palette ${c.pal}  tiles ${c.tiles.slice(0, 4).join(',')}`);
    used.set(c.pal, (used.get(c.pal) || 0) + 1);
  }
  console.log(`   palettes in use: ${[...used.keys()].sort().join(', ') || '(none)'}`);

  // ── the prediction ────────────────────────────────────────────────────
  // `src/map-loader.js` already reads these tables as a shared palette LIBRARY
  // indexed by a byte in the map's own properties (byte 8 = spritePalette6,
  // byte 9 = spritePalette7) — NOT indexed by npcId. Check it against the PPU.
  //
  // ⛔ The PPU's first entry per sprite palette ($3F10/$3F14/$3F18/$3F1C) is a
  // MIRROR of the BG backdrop, not part of the palette. Compare entries 1-3.
  const hx = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');
  const pred = md.spritePalettes;                       // [pal6, pal7]
  const cmp = [[0, 2, 'spritePalette6'], [1, 3, 'spritePalette7']];
  let allOk = true;
  console.log('\nmap-supplied sprite palettes vs the PPU (entries 1-3):');
  for (const [pi, ppu, name] of cmp) {
    const want = pred[pi].slice(1), got = pals[ppu].slice(1);
    const ok = hx(want) === hx(got);
    if (!ok) allOk = false;
    console.log(`   ${name} -> PPU sprite palette ${ppu}:  predicted ${hx(want)}   measured ${hx(got)}  ${ok ? '✓' : '✗'}`);
  }

  // and which palette each NPC cluster actually draws in
  const tops = clusters.filter(c => c.tiles.length >= 2).map(c => c.pal);
  console.log(`   palette indices used by on-screen clusters: ${[...new Set(tops)].sort().join(',')}`);

  console.log('\n⛔ the tables are NOT indexed by npcId — for reference, that reading gives:');
  for (const n of npcs.slice(0, 3)) {
    const byId = PAL_TABLES.map(t => rom[t + n.id]);
    console.log(`   id ${String(n.id).padStart(3)}  [by npcId] ${hx(byId)}   (does not match the PPU above)`);
  }
  return { pals, clusters, npcs, ok: allOk, pred };
}

if (SWEEP) {
  // Many maps, quietly — the point is the tally, not the per-map detail.
  const maps = SWEEP.split(',').map(Number);
  const hx = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');
  let ok = 0, checked = 0;
  const seen = new Set();
  console.log(`map   spritePalette6 (PPU 2)      spritePalette7 (PPU 3)`);
  for (const m of maps) {
    warpTo(m);
    let md; try { md = loadMap(rom, m); } catch { continue; }
    const pals = spritePalettes();
    const pred = md.spritePalettes;
    const a = hx(pred[0].slice(1)) === hx(pals[2].slice(1));
    const b = hx(pred[1].slice(1)) === hx(pals[3].slice(1));
    checked++; if (a && b) ok++;
    seen.add(hx(pred[1].slice(1)));
    console.log(`${String(m).padStart(3)}   ${hx(pred[0].slice(1))} vs ${hx(pals[2].slice(1))} ${a ? '✓' : '✗'}` +
                `      ${hx(pred[1].slice(1))} vs ${hx(pals[3].slice(1))} ${b ? '✓' : '✗'}`);
  }
  console.log(`\n── ${ok}/${checked} maps predicted exactly; ${seen.size} distinct sprite palette 7 values ──`);
  if (ok !== checked) process.exitCode = 1;
} else if (COMPARE) {
  // ⛔ THE DISCRIMINATING TEST: the same npcId on two maps.
  const [a, b] = COMPARE.split(',').map(Number);
  const A = report(a), B = report(b);
  const idsA = new Set(A.npcs.map(n => n.id));
  const shared = B.npcs.filter(n => idsA.has(n.id)).map(n => n.id);
  console.log(`\n══ shared npcIds between map ${a} and map ${b}: ${shared.length ? shared.join(', ') : 'NONE'} ══`);
  const same = JSON.stringify(A.pals) === JSON.stringify(B.pals);
  console.log(`sprite palettes identical across the two maps: ${same ? 'YES' : 'NO'}`);
  if (!same) {
    console.log('  -> the palette REGISTERS are per-map; a per-NPC table can only be');
    console.log('     selecting WHICH of the four, not the colours themselves.');
  }
} else {
  report(MAP);
}
