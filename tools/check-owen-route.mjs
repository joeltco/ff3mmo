#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const { initMapLoading } = await import('../src/map-loading.js');
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
ps.flags = { nepto_restored: 1 }; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
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
enterAt(63,32); assert.equal(mapSt.currentMapId,6000);
for (let floor=0;floor<4;floor++) {
  const md=mapSt.mapData;
  const next=[...md.triggerMap].find(([,t]) => md.dungeonDestinations.get(`${t.type}:${t.trigId}`)?.mapId === 6001+floor);
  assert.ok(next, `floor ${floor}: no upstairs`);
  const [x,y]=next[0].split(',').map(Number);
  const queue=[[mapSt.worldX/16,mapSt.worldY/16]], seen=new Set([queue[0].join(',')]);
  for(let i=0;i<queue.length;i++) for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx=queue[i][0]+dx,ny=queue[i][1]+dy,key=`${nx},${ny}`;
    if(nx<0||ny<0||nx>31||ny>31||seen.has(key)||!mapSt.mapRenderer.isPassable(nx,ny))continue;
    seen.add(key);queue.push([nx,ny]);
  }
  assert.ok(seen.has(`${x},${y}`),`floor ${floor}: stairs unreachable`);
  enterAt(x,y); assert.equal(mapSt.currentMapId,6001+floor);
}
assert.ok(mapSt.bossSprite);
const w=mapSt.warpTile;
function step() {
  mapSt.worldX=w.x*16;mapSt.worldY=(w.y+1)*16;mapSt.moving=false;
  startMove(DIR_UP,true);updateMovement(1000);
}
mapSt.starEffect=null; battleSt.enemyDefeated=false; step();
assert.equal(mapSt.starEffect,null); assert.equal(ps.flags.owen_restored,undefined);
battleSt.enemyDefeated=true; step();
assert.ok(mapSt.starEffect);mapSt.starEffect.onComplete();finishTransition();
assert.equal(ps.flags.owen_restored,1);assert.equal(mapSt.onWorldMap,true);
assert.equal(mapSt.worldX/16,63);assert.equal(mapSt.worldY/16,32);
console.log('check-owen-route: OK — entrance, four reachable ascents, boss gate, completed exit');
