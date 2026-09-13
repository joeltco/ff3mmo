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
const { wordMenuSt, closeWordMenu, handleWordMenuInput } = await import('../src/word-menu.js');
// One continuous character's story, with no seeded quest/field-skill flags.
// Travel between scenes is positioned by the harness; victories use the real
// dissolve handler. Separate movement/layout/combat checks cover those layers.
const { findNpcAt }=await import('../src/npc.js');
const { battleSt }=await import('../src/battle-state.js');
const { updateBattleEndSequence }=await import('../src/battle-update.js');
const { setPlayerInventory, hasItem }=await import('../src/inventory.js');
const { parseSaveSlots }=await import('../src/save.js');
const { memorySaveDB }=await import('./lib/save-db-fixture.mjs');memorySaveDB();
const saves=await import('../src/save-state.js');
globalThis.window.ff3Auth={serverLoadSaves:async()=>[{name:[65]}],serverSave:async()=>true};
await saves.loadSlotsFromDB();saves.setPsAligned(true);
ps.flags={};ps.quests={};ps.words={};ps.knownSpells=[];ps.unlockedJobs=1;
ps.stats={level:1,maxHP:100,maxMP:20,exp:0,expToNext:1000000};
ps.hp=100;ps.mp=20;ps.gil=0;ps.vehicle=0;ps.jobLevels={};setPlayerInventory({});
function clear(){closeWordMenu();forceCloseMsgBox();transSt.state='none';transSt.pendingAction=null;mapSt.starEffect=null;mapSt.moving=false;}
function settle(){for(let i=0;i<40&&msgState.onAdvance;i++)msgState.onAdvance();msgState.state='hold';msgState.typed=msgState.bytes?.length||0;}
function finish(){assert.equal(typeof transSt.pendingAction,'function');const fn=transSt.pendingAction;transSt.pendingAction=null;fn();transSt.state='none';}
function talk(map,key){
 clear();loadMapById(map);let npc;
 for(let y=0;y<32;y++)for(let x=0;x<32;x++){const n=findNpcAt(x,y);if(n?.key===key)npc=n;}
 assert.ok(npc,`missing ${key} on ${map}`);
 mapSt.worldX=npc.tileX*16;mapSt.worldY=(npc.tileY+1)*16;dir=DIR_UP;keys.z=true;handleInput();settle();
 if(msgState.onClose&&!msgState.isPrompt)msgState.onClose();settle();
}
function at(map,x,y){clear();loadMapById(map);mapSt.worldX=x*16;mapSt.worldY=y*16;dir=DIR_UP;keys.z=true;handleInput();settle();if(msgState.onClose&&!msgState.isPrompt)msgState.onClose();settle();}
function pick(label){const i=wordMenuSt.rows.findIndex(r=>r.label===label);assert.ok(i>=0,`missing ${label}: ${wordMenuSt.rows.map(r=>r.label)}`);wordMenuSt.index=i;handleWordMenuInput({z:true});settle();}
function victory(map,boss){clear();loadMapById(map);battleSt.bossId=boss;battleSt.battleState='boss-dissolve';battleSt.battleTimer=1000000;updateBattleEndSequence(16);assert.equal(battleSt.enemyDefeated,true);battleSt.battleState='none';}
function exit(){forceCloseMsgBox();const w=mapSt.warpTile;assert.ok(w);mapSt.worldX=w.x*16;mapSt.worldY=(w.y+1)*16;startMove(DIR_UP,true);updateMovement(1000);assert.ok(mapSt.starEffect);const done=mapSt.starEffect.onComplete;mapSt.starEffect=null;done();finish();}
function world(x,y){clear();mapSt.mapStack=[];mapSt.onWorldMap=true;mapSt.worldX=x*16;mapSt.worldY=y*16;mapSt.disabledTrigger=null;assert.equal(checkTrigger(),true);if(msgState.onAdvance){settle();msgState.onClose();}finish();}
async function checkpoint(){await saves.saveSlotsToDB();const s=parseSaveSlots(saves.saveSlots)[0];assert.deepEqual(s.flags,ps.flags);assert.deepEqual(s.quests,ps.quests);assert.deepEqual(s.knownSpells,ps.knownSpells);ps.flags=s.flags;ps.quests=s.quests;ps.words=s.words;ps.knownSpells=s.knownSpells;ps.vehicle=s.vehicle;ps.vehicleParkedMode=s.vehicleParkedMode;}
victory(1004,0xcc);assert.equal(ps.unlockedJobs,0x3f);
talk(18,'sasune_guard_w');pick('LEARN');
talk(29,'sasune_king');pick('LEARN');pick('ASK');pick('SARA');pick('ACCEPT');
assert.ok(hasItem(0xa5));assert.equal(ps.vehicleParkedMode,2);
talk(25,'sasune_hall_servant');talk(10,'kazus_smith');talk(2001,'sara');talk(29,'sasune_king');
assert.equal(ps.flags.daughter_home,1);
talk(12,'cid');pick('ASK');pick('DJINN');pick('ACCEPT');victory(2004,0xcd);talk(12,'cid');
assert.equal(ps.flags.curse_lifted,1);assert.equal(ps.vehicleParkedMode,4);await checkpoint();
// Nelv's permanent passage, then the summit's escape scene.
clear();mapSt.onWorldMap=true;mapSt.worldX=81*16;mapSt.worldY=55*16;ps.vehicle=0;
startMove(DIR_UP,true);assert.equal(msgState.isPrompt,true);msgState.onAccept();finish();assert.equal(ps.flags.nelv_pass_open,1);
clear();loadMapById(92);mapSt.worldX=11*16;mapSt.worldY=2*16;
startMove(DIR_UP,true);updateMovement(1000);settle();msgState.onClose();finish();
assert.equal(mapSt.currentMapId,185);assert.ok(ps.knownSpells.includes(0x2f));
// Provision the optional treatment items; no quest reward is injected.
setPlayerInventory({0xa5:1,0xa6:1,0xa8:1});
at(44,13,26);assert.equal(msgState.isPrompt,true);msgState.onAccept();assert.equal(ps.flags.doctor_healed,1);
clear();loadMapById(4002);battleSt.enemyDefeated=false;exit();assert.equal(ps.flags.tozas_passage_open,1);
at(51,25,11);pick('LEARN');at(53,7,7);pick('ASK');pick('NEPTO');pick('ACCEPT');
world(72,72);assert.equal(mapSt.currentMapId,5000);victory(5003,0xce);at(53,7,7);
assert.equal(ps.flags.nepto_restored,1);assert.equal(ps.vehicleParkedMode,3);await checkpoint();
at(68,14,9);assert.ok(ps.knownSpells.includes(0x2e));
world(63,32);victory(6004,0xcf);exit();assert.equal(ps.flags.owen_restored,1);
at(85,17,5);pick('LEARN');at(86,12,28);pick('ASK');pick('HORN');pick('ACCEPT');
victory(7003,0xd0);at(86,12,28);assert.equal(ps.flags.horns_stolen,1);
world(37,23);victory(8003,0xd1);at(86,12,28);assert.equal(ps.flags.dwarves_saved,1);assert.equal(ps.unlockedJobs,0x3ff);
world(61,82);assert.equal(mapSt.currentMapId,9000);victory(9004,0xd2);exit();assert.equal(ps.flags.hein_defeated,1);
at(81,11,5);pick('LEARN');pick('ASK');pick('WHEEL');pick('ACCEPT');assert.ok(hasItem(0x9c));
at(33,18,5);assert.equal(ps.flags.floating_continent_complete,1);assert.equal(ps.vehicleParkedMode,6);
const earned=ps.stats.exp,gil=ps.gil;await checkpoint();at(33,18,5);assert.equal(ps.stats.exp,earned);assert.equal(ps.gil,gil);
console.log('check-continent-story: OK — continuous fresh story, both crystals, canoe, curse, mountain, Mini/Toad, temple, Owen, horns, Hein, Enterprise and checkpoint codec');
