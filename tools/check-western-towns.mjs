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
const { transSt } = await import('../src/transitions.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { handleInput } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP } = await import('../src/sprite.js');
const { msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { keys } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
let dir = DIR_UP;
setPlayerSprite({ getDirection: () => dir, setDirection: d => { dir = d; }, resetFrame() {}, setWalkProgress() {} });
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
initMapLoading(rom);
mapSt.worldMapData = loadWorldMap(rom, 0);
mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
ps.flags = {nepto_restored:1}; ps.quests = {}; ps.words = {}; ps.vehicle = 0; ps.knownSpells=[];
loadMapById(68); mapSt.worldX=14*16;mapSt.worldY=9*16;dir=DIR_UP;
keys.z=true;handleInput();assert.ok(ps.knownSpells.includes(0x2e));
forceCloseMsgBox();keys.z=true;handleInput();assert.equal(ps.knownSpells.filter(s=>s===0x2e).length,1);
forceCloseMsgBox();
for(const [x,y,id] of [[15,94,60],[31,48,67],[110,76,69]]) {
  transSt.state='none';mapSt.onWorldMap=true;mapSt.worldX=x*16;mapSt.worldY=y*16;
  mapSt.disabledTrigger=null;mapSt.mapStack=[];
  assert.equal(checkTrigger(),true);transSt.pendingAction();transSt.state='none';
  assert.equal(mapSt.currentMapId,id);
}
// Walk each terrace stair in the actual renderer's changing elevation.
loadMapById(60);
const r=mapSt.mapRenderer;
for(const y of [29,28,27,26,25]) {
  assert.ok(r.isPassable(17,y), `blocked terrace at 17,${y}`);r.commitZ(17,y);
}
// A character without either field skill receives a hint, not entry.
ps.knownSpells=[];
for(const [x,y] of [[95,96],[72,72],[63,32]]) {
  forceCloseMsgBox();transSt.state='none';transSt.pendingAction=null;
  mapSt.onWorldMap=true;mapSt.worldX=x*16;mapSt.worldY=y*16;mapSt.disabledTrigger=null;
  assert.equal(checkTrigger(),true);assert.notEqual(msgState.state,'none');
  assert.equal(transSt.pendingAction,null);
}
console.log('check-western-towns: OK — native entrances, terraced stairs, Toad lesson and spell gates');
