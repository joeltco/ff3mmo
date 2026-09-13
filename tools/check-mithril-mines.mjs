#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { memorySaveDB } from './lib/save-db-fixture.mjs';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
memorySaveDB();
const writes = [];
globalThis.window.ff3Auth = { serverLoadSaves: async () => [{ name: [65], inventory: {} }],
  serverSave: async (_slot, data) => { writes.push(structuredClone(data)); return true; } };
const { MapRenderer } = await import('../src/map-renderer.js');
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS, dungeonResumeAnchor } = await import('../src/data/dungeons.js');
const { applyFeature } = await import('../src/dungeons/compile.js');
const { sanitizeDungeonRun, startOrResumeDungeonRun } = await import('../src/dungeons/run-state.js');
const { initMapLoading, loadMapById } = await import('../src/map-loading.js');
const { mapSt } = await import('../src/map-state.js');
const { transSt } = await import('../src/transitions.js');
const { ps } = await import('../src/player-stats.js');
const { setPlayerInventory, playerInventory } = await import('../src/inventory.js');
const { ITEMS } = await import('../src/data/items.js');
const { INV_CAP } = await import('../src/data/limits.js');
const { handleInput, startMove, updateMovement } = await import('../src/movement.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { keys } = await import('../src/input-handler.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT } = await import('../src/sprite.js');
const { forceCloseMsgBox, msgState } = await import('../src/message-box.js');
const saves = await import('../src/save-state.js');
const { readLocalSnapshot } = await import('../src/save-sync.js');
const { parseSaveSlots } = await import('../src/save.js');
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
const dungeon = DUNGEONS.find(d => d.id === 'mines');
function path(renderer, start, end) {
  const queue = [start], parents = new Map([[start.join(','), null]]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const at = [x + dx, y + dy], key = at.join(',');
      if (parents.has(key) || !renderer.isPassable(...at, 0)) continue;
      parents.set(key, [x, y]); queue.push(at);
    }
  }
  if (!end) return parents;
  if (!parents.has(end.join(','))) return null;
  const result = [];
  for (let at = end; parents.get(at.join(',')); at = parents.get(at.join(','))) result.unshift(at);
  return result;
}
const signatures = [new Set(), new Set()];
for (let k = 0; k < 400; k++) for (let floor = 0; floor < 2; floor++) {
  const seed = 1754900000000 + k * 7919;
  const map = generateFloor(rom, floor, seed, dungeon);
  signatures[floor].add(Buffer.from(map.tilemap).toString('hex'));
  assert.deepEqual(map.tilemap, generateFloor(rom, floor, seed, dungeon).tilemap);
  const renderer = new MapRenderer(map, map.entranceX, map.entranceY);
  const reached = path(renderer, map.route.entrance);
  for (const f of map.features) {
    const [x, y] = f.at;
    if (f.kind === 'landmark') assert(reached.has(f.at.join(',')), 'endpoint reachable');
    else assert([[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(at => reached.has(at.join(','))), `${f.id}: no approach`);
    if (f.kind === 'passage') {
      assert(!renderer.isPassable(x,y,0), 'secret is closed before discovery');
      assert(!map.triggerMap.has(f.at.join(',')), 'closed wall has no active staircase');
      applyFeature(map, f, dungeon);
      assert(path(renderer, map.route.entrance, f.at), 'discovered stairs reachable');
    }
  }
  for (const [coord, trigger] of map.triggerMap) if (trigger.type === 1) {
    assert(map.dungeonDestinations.has(`1:${trigger.trigId}`), `unwired stair ${coord}`);
  }
  assert.equal(map.warpTile, null, 'no generic boss-platform warp');
}
assert.deepEqual(signatures.map(s => s.size), [3, 3], 'three controlled branch variants per section');
let direction = DIR_UP;
setPlayerSprite({ getDirection: () => direction, setDirection: d => { direction = d; }, resetFrame() {}, setWalkProgress() {} });
const { initTextDecoder } = await import('../src/text-decoder.js');
initTextDecoder(rom);
initMapLoading(rom);
await saves.loadSlotsFromDB(); saves.setPsAligned(true);
ps.stats = {level:5,exp:0,maxHP:100,maxMP:20};
ps.flags = {}; ps.quests = {}; ps.words = {}; ps.dungeonRun = null; ps.knownSpells = [];
ps.consumedTiles = {}; ps.consumedTilesAt = {}; ps.vehicle = 0; ps.hp = 100; ps.mp = 20;
setPlayerInventory({});
const random = Math.random; Math.random = () => 0.99999; // isolate exploration from random battle rolls
function finishTransition() {
  assert.equal(typeof transSt.pendingAction, 'function');
  const action = transSt.pendingAction; transSt.pendingAction = null;
  action(); transSt.state = 'none';
}
function walkTo(x, y) {
  const steps = path(mapSt.mapRenderer, [mapSt.worldX/16, mapSt.worldY/16], [x,y]);
  assert(steps, `no walking route to ${x},${y}`);
  for (const [nx, ny] of steps) {
    const cx = mapSt.worldX/16, cy = mapSt.worldY/16;
    const d = nx > cx ? DIR_RIGHT : nx < cx ? DIR_LEFT : ny > cy ? DIR_DOWN : DIR_UP;
    startMove(d, true); updateMovement(1000);
    assert.equal(mapSt.worldX/16,nx); assert.equal(mapSt.worldY/16,ny);
    if (transSt.pendingAction) finishTransition();
    forceCloseMsgBox();
  }
}
function act(d) { direction = d; keys.z = true; handleInput(); }
loadMapById(10); mapSt.mapStack = [];
mapSt.worldX=21*16;mapSt.worldY=11*16;mapSt.disabledTrigger=null;
assert(checkTrigger());finishTransition();assert.equal(mapSt.currentMapId,12000);
const seed=ps.dungeonRun.seed;
for (const id of [12000,12001,12002]) assert.deepEqual(dungeonResumeAnchor(id),{mapId:10,x:21,y:12});
assert.equal(dungeonResumeAnchor(2001),null);
walkTo(23,9);act(DIR_UP);
assert.equal(ps.dungeonRun.features['old-face'],1);
assert.notEqual(msgState.state,'none');forceCloseMsgBox();
walkTo(23,8);assert.equal(mapSt.currentMapId,12001);
assert.equal(mapSt.bossSprite,null);
walkTo(20,8);assert.equal(ps.flags.mines_explored,1);
// Full inventory never consumes the guaranteed cache or the run's reward bit.
const full = Object.fromEntries([...ITEMS.keys()].filter(id => id !== 0x27 && id !== 0x64).slice(0,INV_CAP).map(id => [id,1]));
setPlayerInventory(full);
walkTo(25,6);act(DIR_UP);
assert.equal(mapSt.mapData.tilemap[5*32+25],0x7c);
assert.equal(ps.dungeonRun.features['sword-cache'],undefined);forceCloseMsgBox();
setPlayerInventory({});act(DIR_UP);forceCloseMsgBox();
assert.equal(playerInventory[0x27],1);
assert.equal(ps.dungeonRun.features['sword-cache'],1);
await saves.saveSlotsToDB();
const saved=(await readLocalSnapshot()).slots[0];
assert.equal(saved.inventory[0x27],1,'reward and opened chest share a snapshot');
assert.equal(saved.dungeonRun.features['sword-cache'],1);
assert(writes.some(s=>s.inventory[0x27]===1 && s.dungeonRun?.features['sword-cache']===1));
// Clear transient state and restore the real codec. The first section is a
// safe re-entry anchor; its hidden stair and the already opened cache remain.
ps.dungeonRun=parseSaveSlots([saved])[0].dungeonRun;
mapSt.dungeonSeed=null;mapSt.mapStack=[{mapId:10,x:21*16,y:11*16}];loadMapById(12000);
assert.equal(mapSt.dungeonSeed,seed);
assert.equal(mapSt.mapData.tilemap[8*32+23],0x73);
walkTo(23,8);assert.equal(mapSt.currentMapId,12001);
assert.equal(mapSt.mapData.tilemap[5*32+25],0x7d);
const tool = mapSt.mapData.features.find(f=>f.id==='tool-cache');
walkTo(tool.at[0],tool.at[1]+1);act(DIR_UP);forceCloseMsgBox();
assert.equal(playerInventory[0x64],1);
// Return via the real backtracking stairs, all the way to the Kazus door.
walkTo(5,26);assert.equal(mapSt.currentMapId,12000);
walkTo(5,26);assert.equal(mapSt.currentMapId,10);
assert.deepEqual([mapSt.worldX/16,mapSt.worldY/16],[21,11]);
const unfinished={...ps.dungeonRun,features:{'old-face':1,'end-working':1}};
assert.equal(startOrResumeDungeonRun(unfinished,dungeon,seed+1).seed,seed);
assert.equal(startOrResumeDungeonRun(ps.dungeonRun,dungeon,seed+1).seed,seed+1);
assert.equal(sanitizeDungeonRun({...ps.dungeonRun,version:999}),null);
assert.equal(sanitizeDungeonRun({}),null);
Math.random=random;
console.log('PASS: Mines 800 generated sections, walking discovery, endpoint, guaranteed loot, full bag, save/reload and Kazus return.');
