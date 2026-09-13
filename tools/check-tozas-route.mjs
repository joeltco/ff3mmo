#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const { initMapLoading, loadMapById } = await import('../src/map-loading.js');
const { mapSt } = await import('../src/map-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { transSt } = await import('../src/transitions.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { startMove, updateMovement } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP } = await import('../src/sprite.js');
const { ps } = await import('../src/player-stats.js');
let dir = DIR_UP;
setPlayerSprite({ getDirection: () => dir, setDirection: d => { dir = d; }, resetFrame() {}, setWalkProgress() {} });
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
initMapLoading(rom);
mapSt.worldMapData = loadWorldMap(rom, 0);
mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
ps.knownSpells = [0x2f, 0x2e];
ps.flags = { doctor_healed: 1 }; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
ps.stats = { maxHP: 100, maxMP: 12 }; ps.hp = 100; ps.mp = 12;
function finishTransition() {
  assert.equal(typeof transSt.pendingAction, 'function');
  transSt.pendingAction(); transSt.pendingAction = null; transSt.state = 'none';
}
function enterAt(x, y) {
  mapSt.worldX = x * 16; mapSt.worldY = y * 16; mapSt.disabledTrigger = null;
  assert.equal(checkTrigger(), true, `no trigger at ${mapSt.currentMapId}:${x},${y}`);
  finishTransition();
}
mapSt.onWorldMap = true; mapSt.mapStack = [];
enterAt(95, 96);
assert.equal(mapSt.currentMapId, 43);
enterAt(8, 8);
assert.equal(mapSt.currentMapId, 44);
// Native in-room staircase, then the tunnel door at the other landing.
enterAt(26, 30);
assert.equal(mapSt.currentMapId, 44);
assert.equal(mapSt.worldX / 16, 29);
enterAt(29, 4);
assert.equal(mapSt.currentMapId, 4000);

function finishPassage(expectedX, expectedY) {
  // Floor generation and stair topology have their own multi-seed sweep;
  // this checks the final-room interaction, route selection, and return state.
  loadMapById(4002);
  assert.equal(mapSt.bossSprite, null, 'bossless passage spawned a boss');
  assert.equal(battleSt.enemyDefeated, false);
  const w = mapSt.warpTile;
  assert.ok(w, 'no endpoint');
  mapSt.worldX = w.x * 16; mapSt.worldY = (w.y + 1) * 16;
  startMove(DIR_UP, true); updateMovement(1000);
  assert.ok(mapSt.starEffect, 'endpoint did not activate');
  mapSt.starEffect.onComplete(); finishTransition();
  assert.equal(mapSt.onWorldMap, true);
  assert.equal(mapSt.worldX / 16, expectedX); assert.equal(mapSt.worldY / 16, expectedY);
  assert.equal(ps.flags.tozas_passage_open, 1);
  assert.equal(ps.lastWorldExitX, expectedX); assert.equal(ps.lastWorldExitY, expectedY);
}
finishPassage(86, 92);
enterAt(86, 92);
assert.equal(mapSt.currentMapId, 4000);
finishPassage(95, 96);
console.log('check-tozas-route: OK — village stairs, generated tunnel, bossless exit, reverse journey');
