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
const { setPlayerInventory, getItemCount } = await import('../src/inventory.js');
ps.flags = {}; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
function talk(map, x, y) {
  forceCloseMsgBox(); transSt.state = 'none'; loadMapById(map);
  mapSt.worldX = x*16; mapSt.worldY = y*16; dir = DIR_UP;
  keys.z = true; handleInput();
}
for (const [map,x,y,item,flag] of [[44,13,26,0xa6,'doctor_healed'], [33,19,4,0xa8,'mrs_cid_healed']]) {
  setPlayerInventory({}); talk(map,x,y);
  assert.notEqual(msgState.state,'none'); assert.equal(msgState.isPrompt,false);
  assert.equal(ps.flags[flag],undefined);
  setPlayerInventory({[item]:2}); talk(map,x,y);
  assert.equal(msgState.isPrompt,true);
  forceCloseMsgBox(); assert.equal(getItemCount(item),2);
  talk(map,x,y); const accept = msgState.onAccept; accept();
  assert.equal(getItemCount(item),1); assert.equal(ps.flags[flag],1);
  accept(); assert.equal(getItemCount(item),1, 'stale prompt consumed twice');
  talk(map,x,y); assert.equal(msgState.isPrompt,false);
  assert.equal(getItemCount(item),1);
}
// Native reward/passage doors enforce treatment, then open after it.
for(const [map,dest,flag] of [[33,35,'mrs_cid_healed'],[44,123,'doctor_healed']]) {
  forceCloseMsgBox();loadMapById(map);
  let door;
  for(let y=0;y<32;y++)for(let x=0;x<32;x++) {
    const t=mapSt.mapRenderer.getTriggerAt(x,y);
    if(t?.source==='dynamic'&&t.type===1&&mapSt.mapData.entranceData[t.trigId]===dest)door=[x,y];
  }
  assert.ok(door,`missing native treatment door in ${map}`);
  const at=()=>{forceCloseMsgBox();transSt.state='none';transSt.pendingAction=null;mapSt.disabledTrigger=null;mapSt.worldX=door[0]*16;mapSt.worldY=door[1]*16;assert.equal(checkTrigger(),true);};
  delete ps.flags[flag];at();assert.equal(transSt.pendingAction,null);
  ps.flags[flag]=1;ps.knownSpells=[0x2f];at();
  assert.equal(typeof transSt.pendingAction,'function');transSt.pendingAction();transSt.state='none';
  assert.equal(mapSt.currentMapId,dest===35?35:4000);
}
// Use Z facing the native spring in every town that shares its ROM room.
ps.stats={maxHP:100,maxMP:20};
for(const map of [11,32,64,77]) {
  ps.hp=1;ps.mp=0;ps.status={mask:0x41,poisonDmgTick:3};
  talk(map,3,6);
  assert.equal(ps.hp,100);assert.equal(ps.mp,20);assert.equal(ps.status.mask,0);
}
console.log('check-story-treatments: OK — real talk, missing item, cancellation, cure and repeat');
