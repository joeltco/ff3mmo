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
const { handleInput, startMove, updateMovement } = await import('../src/movement.js');
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
const { battleSt } = await import('../src/battle-state.js');
const { tickRandomEncounter } = await import('../src/battle-encounter.js');
ps.flags={};ps.quests={};ps.words={};ps.knownSpells=[];ps.vehicle=0;
ps.stats={level:20,maxHP:150,maxMP:10};ps.hp=150;ps.mp=10;
function finish(){assert.equal(typeof transSt.pendingAction,'function');transSt.pendingAction();transSt.pendingAction=null;transSt.state='none';}
function at(x,y){mapSt.worldX=x*16;mapSt.worldY=y*16;mapSt.disabledTrigger=null;assert.equal(checkTrigger(),true);}
function world(x,y){forceCloseMsgBox();mapSt.starEffect=null;mapSt.onWorldMap=true;mapSt.mapStack=[];transSt.state='none';transSt.pendingAction=null;at(x,y);}
function endpoint(map,flag,x,y,spell){
  forceCloseMsgBox();mapSt.starEffect=null;loadMapById(map);
  // Victory gating is checked by the boss tests. Inject its flag here to
  // isolate endpoint movement and save data from turn/animation timing.
  battleSt.enemyDefeated=!!spell;
  const w=mapSt.warpTile;mapSt.worldX=w.x*16;mapSt.worldY=(w.y+1)*16;
  startMove(DIR_UP,true);updateMovement(1000);assert.ok(mapSt.starEffect);
  const done=mapSt.starEffect.onComplete;mapSt.starEffect=null;done();finish();
  assert.equal(mapSt.onWorldMap,true);assert.equal(mapSt.worldX/16,x);assert.equal(mapSt.worldY/16,y);
  assert.equal(ps.flags[flag],1);if(spell)assert.ok(ps.knownSpells.includes(spell));
}
// Kazus's mine door, and a bossless finish.
loadMapById(10);at(21,11);finish();assert.equal(mapSt.currentMapId,12000);
loadMapById(12002);assert.equal(mapSt.bossSprite,null);
endpoint(12002,'mines_explored',93,59);
for(const [x,y,base,flag,spell] of [[32,53,10000,'dohr_defeated',0x0d],[89,96,11000,'bahamut_defeated',0x06]]){
  delete ps.flags.invincible_acquired;world(x,y);
  assert.equal(transSt.pendingAction,null);assert.notEqual(msgState.state,'none');
  ps.flags.invincible_acquired=1;world(x,y);finish();assert.equal(mapSt.currentMapId,base);
  endpoint(base+3,flag,x,y,spell);
  const count=ps.knownSpells.length;world(x,y);finish();endpoint(base+3,flag,x,y,spell);
  assert.equal(ps.knownSpells.length,count,'repeat trial duplicated summon');
}
// A chocobo travels without consuming the player's parked ship slot.
ps.vehicleParked=1;ps.vehicleParkedMode=3;ps.vehicleParkedX=80;ps.vehicleParkedY=80;
world(39,25);finish();assert.equal(mapSt.currentMapId,93);
mapSt.worldX=9*16;mapSt.worldY=7*16;dir=DIR_UP;keys.z=true;handleInput();
assert.equal(msgState.isPrompt,true);msgState.onAccept();finish();forceCloseMsgBox();
assert.equal(ps.vehicle,1);assert.equal(ps.vehicleParkedMode,3);
assert.equal(tickRandomEncounter(),false);
keys.z=true;handleInput();assert.equal(ps.vehicle,0);
assert.equal(ps.vehicleParked,1);assert.equal(ps.vehicleParkedX,80);
console.log('check-side-excursions: OK — mines, gated summons, repeat rewards, chocobo and parked ship');
