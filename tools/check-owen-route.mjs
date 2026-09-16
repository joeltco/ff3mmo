#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {}, fonts:{load:async()=>[]} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.requestAnimationFrame=fn=>fn();
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
ps.flags = { nepto_restored: 1 }; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
ps.stats = { level:15, maxHP: 100, maxMP: 12 }; ps.jobIdx=1; ps.hp = 100; ps.mp = 12;
function finishTransition() {
  assert.equal(typeof transSt.pendingAction, 'function');
  transSt.pendingAction(); transSt.pendingAction = null; transSt.state = 'none';
}
function enterAt(x, y) {
  mapSt.worldX = x * 16; mapSt.worldY = y * 16; mapSt.disabledTrigger = null;
  assert.equal(checkTrigger(), true, `no trigger at ${mapSt.currentMapId}:${x},${y}`);
  finishTransition();
}
const {DUNGEONS,dungeonResumeAnchor,isEncounterFloor}=await import('../src/data/dungeons.js');
const {ENCOUNTERS}=await import('../src/data/encounters.js');
const {sanitizeDungeonRun,startOrResumeDungeonRun}=await import('../src/dungeons/run-state.js');
const owen=DUNGEONS.find(d=>d.id==='owen');
assert.deepEqual(owen.design.floors,['machine-gallery','distribution','shaft','control','engine']);
for(let id=6000;id<=6004;id++)assert.deepEqual(dungeonResumeAnchor(id),{world:{x:63,y:32}});
ps.dungeonRun={dungeonId:'mines',version:1,seed:11,features:{'old-face':1}};
mapSt.onWorldMap = true; mapSt.mapStack = [];
enterAt(63,32); assert.equal(mapSt.currentMapId,6000);
assert.equal(ps.dungeonRun.dungeonId,'owen');
const seed=ps.dungeonRun.seed;
ps.dungeonRun.features={'power-bank':1,'gallery-cache':1};
loadMapById(6000);
assert.equal(mapSt.mapData.tilemap[8*32+12],0x30,'saved control must replay on real load');
assert.equal(mapSt.mapData.tilemap[12*32+14],0x7d,'saved chest must stay claimed');
assert.equal(startOrResumeDungeonRun(ps.dungeonRun,owen,seed+1).seed,seed);
assert.deepEqual(sanitizeDungeonRun({...ps.dungeonRun,features:{'power-bank':1,'old-face':1}}).features,{'power-bank':1});
for (let floor=0;floor<4;floor++) {
  const md=mapSt.mapData;
  assert.equal(md.sectionId,owen.design.floors[floor]);
  assert.equal(md.designVersion,1);
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
  // Descend via the real return stair, then climb again; no stale breadcrumbs.
  const back=mapSt.mapData.route.entrance;
  enterAt(...back); assert.equal(mapSt.currentMapId,6000+floor);
  assert.equal(mapSt.worldX/16,x); assert.equal(mapSt.worldY/16,y);
  enterAt(x,y); assert.equal(mapSt.currentMapId,6001+floor);
}
assert.ok(mapSt.bossSprite);
assert.equal(mapSt.mapData.sectionId,'engine');
assert.equal(isEncounterFloor(owen,4),false);
assert.equal(ENCOUNTERS.get('tower_owen_f5').rate,0);
assert(mapSt.mapRenderer.isPassable(6,8));
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
assert.equal(ps.dungeonRun,null,'completed climb must allow a new seed');
console.log('check-owen-route: OK — five authored floors, ascent/descent, run isolation, recovery anchors, no boss encounters, boss gate, completed exit');

// Exercise the real title-screen resume branch with every legacy indoor Owen ID.
const {initSpriteAssets}=await import('../src/boot.js');
initSpriteAssets(rom);
const {Sprite}=await import('../src/sprite.js');
const {SPRITE_PAL_TOP,SPRITE_PAL_BTM}=await import('../src/job-sprites.js');
setPlayerSprite(new Sprite(rom,SPRITE_PAL_TOP,SPRITE_PAL_BTM));
const saves=await import('../src/save-state.js');
const {titleSt,updateTitle}=await import('../src/title-screen.js');
for(let id=6000;id<=6004;id++) {
  saves.setSelectCursor(0);
  saves.setSaveSlots([{name:[65],stats:{},level:15,exp:0,hp:100,mp:12,
    onWorldMap:false,currentMapId:id,worldX:29*16,worldY:29*16,
    flags:{nepto_restored:1},knownSpells:[0x2e]}]);
  titleSt.state='main-out';titleSt.timer=0;updateTitle(10000);
  assert.equal(mapSt.onWorldMap,true,`legacy ${id} save must resume outside`);
  assert.equal(mapSt.worldX/16,63);assert.equal(mapSt.worldY/16,32);
}
console.log('check-owen-route: OK — actual title-screen recovery of all five legacy indoor saves');

// A player may retreat before completion, all the way through the authored entry.
enterAt(63,32);assert.equal(mapSt.currentMapId,6000);
const retreatSeed=ps.dungeonRun.seed;
enterAt(...mapSt.mapData.route.entrance);
assert.equal(mapSt.onWorldMap,true);assert.equal(mapSt.worldX/16,63);assert.equal(mapSt.worldY/16,32);
assert.equal(ps.flags.owen_restored,undefined,'retreat must not complete the tower');
enterAt(63,32);assert.equal(ps.dungeonRun.seed,retreatSeed);
console.log('check-owen-route: OK — retreat outside and re-entry preserve unfinished run');
