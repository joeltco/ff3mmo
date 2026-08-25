#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  RENDER IT AND LOOK.  ⛔⛔⛔
//
// battle-shot.mjs — the battle viewport, drawn through the SHIPPED drawers.
//
// There was no way to see this screen without launching the game and walking
// into a fight, which is why the battle backdrop could be decoded, cached, and
// never actually drawn for as long as it was. "The code looks right" is not a
// check; neither is "it renders" — the backdrop rendered fine into a HUD strip
// nobody was looking at while every battle happened over the field map.
//
//   node tools/battle-shot.mjs                    # Ur (map 114), 3 goblins
//   node tools/battle-shot.mjs --map 111          # Altar Cave donor map
//   node tools/battle-shot.mjs --world 60 40      # overworld tile (forest etc)
//   node tools/battle-shot.mjs --bg 5             # force a backdrop id
//   node tools/battle-shot.mjs --all out.png      # every backdrop, one sheet
//
// It calls `drawBattleBackdrop` and `encounterGridLayout` — the same two the
// game calls — so a shot cannot show a composition the game would not produce.
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {} };

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const has = (name) => args.includes(name);

const { mapSt } = await import('../src/map-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { initBattleBackdrop, drawBattleBackdrop, currentBattleBgId } = await import('../src/battle-backdrop.js');
const { encounterGridLayout } = await import('../src/battle-grid.js');
const { getMonsterCanvas } = await import('../src/monster-sprites.js');
const { BATTLE_BG_COUNT } = await import('../src/battle-bg.js');
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');

initBattleBackdrop(rom);

// The party fights three goblins unless told otherwise — enough sprites to show
// where the backdrop band sits relative to the monster grid, which is the whole
// question a still of this screen has to answer.
const monsterId = flag('--monster') ? parseInt(flag('--monster'), 16) : 0x00;
const count = flag('--count') ? parseInt(flag('--count'), 10) : 3;
battleSt.encounterMonsters = Array.from({ length: count }, () => ({ monsterId, hp: 10 }));
battleSt.isRandomEncounter = true;

const CANVAS_W = 256, CANVAS_H = 240;
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;

/** Compose one battle viewport. Returns the canvas. */
function shot(label) {
  const c = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // Outside the viewport is the roster panel / HUD, which this tool does not
  // draw — flat grey so it is obvious it is NOT part of the battle field.
  ctx.fillStyle = '#2a2a34';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  drawBattleBackdrop(ctx);
  // Monsters, at the grid positions the game computes.
  const { gridPos, row0H, row1H, sprH } = encounterGridLayout();
  ctx.save();
  ctx.beginPath(); ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H); ctx.clip();
  for (let i = 0; i < gridPos.length; i++) {
    const mc = getMonsterCanvas(battleSt.encounterMonsters[i].monsterId, null);
    if (!mc) continue;
    const rH = i < 2 ? (row0H || sprH) : (row1H || sprH);
    ctx.drawImage(mc, gridPos[i].x, gridPos[i].y + Math.max(0, (rH - mc.height) >> 1));
  }
  ctx.restore();
  ctx.fillStyle = '#e8e8f0';
  ctx.font = '11px monospace';
  ctx.fillText(label, 4, 14);
  return c;
}

function setScene() {
  if (flag('--world')) {
    const wx = parseInt(args[args.indexOf('--world') + 1], 10);
    const wy = parseInt(args[args.indexOf('--world') + 2], 10);
    mapSt.onWorldMap = true;
    mapSt.worldMapRenderer = new WorldMapRenderer(loadWorldMap(rom, 0));
    mapSt.worldX = wx * 16; mapSt.worldY = wy * 16;
    return `world ${wx},${wy}`;
  }
  mapSt.onWorldMap = false;
  mapSt.currentMapId = flag('--map') ? parseInt(flag('--map'), 10) : 114;
  return `map ${mapSt.currentMapId}`;
}

if (has('--all')) {
  // One sheet, every backdrop, with the monsters in place — the view that
  // answers "does the band sit right against a sprite" for all 24 at once.
  const outPath = flag('--all') && !flag('--all').startsWith('--') ? flag('--all') : 'battle-shots.png';
  mapSt.onWorldMap = false;
  const cols = 4, rows = Math.ceil(BATTLE_BG_COUNT / cols);
  const sheet = createCanvas(cols * CANVAS_W, rows * CANVAS_H);
  const sctx = sheet.getContext('2d');
  sctx.fillStyle = '#101014'; sctx.fillRect(0, 0, sheet.width, sheet.height);
  for (let id = 0; id < BATTLE_BG_COUNT; id++) {
    // Pick a real map that uses this backdrop, so the shot is a scene the game
    // can actually reach — not a forced id.
    let mapForId = null;
    mapSt.onWorldMap = false;
    for (let m = 0; m < 512 && mapForId === null; m++) {
      mapSt.currentMapId = m;
      if (currentBattleBgId() === id) mapForId = m;
    }
    let label;
    if (mapForId !== null) {
      mapSt.currentMapId = mapForId;
      label = `bg ${id} · map ${mapForId}`;
    } else {
      // ⛔ The orphans are NOT filler — they are the overworld's own backdrops
      // (desert, forest, marsh, rock, ocean, sky) plus undersea, which is
      // exactly the set this whole pull was missing. Falling back to map 0 here
      // would have quietly shown grassland six times over and looked complete.
      // Stub the renderer's OWN interface so the scene is still resolved by
      // `currentBattleBgId`, not painted around it.
      mapSt.onWorldMap = true;
      mapSt.worldMapRenderer = { battleBgIdAt: () => id };
      mapSt.worldX = 0; mapSt.worldY = 0;
      label = `bg ${id} · overworld terrain`;
    }
    sctx.drawImage(shot(label), (id % cols) * CANVAS_W, Math.floor(id / cols) * CANVAS_H);
  }
  fs.writeFileSync(outPath, sheet.toBuffer('image/png'));
  console.log('wrote', outPath);
} else if (flag('--bg')) {
  // Force one id through the real resolver by stubbing the world renderer's
  // interface — same trick the sheet uses for the overworld-only backdrops.
  const id = parseInt(flag('--bg'), 10);
  mapSt.onWorldMap = true;
  mapSt.worldMapRenderer = { battleBgIdAt: () => id };
  mapSt.worldX = 0; mapSt.worldY = 0;
  const outPath = flag('--out') || 'battle-shot.png';
  fs.writeFileSync(outPath, shot(`forced bg ${id}`).toBuffer('image/png'));
  console.log(`wrote ${outPath} — forced backdrop ${id}`);
} else {
  const label = setScene();
  const bg = currentBattleBgId();
  const outPath = flag('--out') || 'battle-shot.png';
  fs.writeFileSync(outPath, shot(`${label} · bg ${bg}`).toBuffer('image/png'));
  console.log(`wrote ${outPath} — ${label}, backdrop ${bg}`);
}
