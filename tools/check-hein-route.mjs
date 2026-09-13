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
ps.flags = {}; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
ps.stats = { maxHP: 100, maxMP: 12, level: 5, exp: 0, expToNext: 1000000 };
ps.hp = 100; ps.mp = 12; ps.gil = 0;
function settle() {
  for (let i=0;i<32 && msgState.onAdvance;i++) msgState.onAdvance();
  msgState.state = 'hold'; msgState.typed = msgState.bytes?.length || 0;
}
function talkAt(map, x, y) {
  closeWordMenu(); forceCloseMsgBox(); transSt.state = 'none';
  loadMapById(map); mapSt.worldX = x * 16; mapSt.worldY = y * 16;
  dir = DIR_UP; keys.z = true; handleInput(); settle();
  if (msgState.onClose) msgState.onClose(); settle();
}
function pick(label) {
  const i = wordMenuSt.rows.findIndex(r => r.label === label);
  assert.ok(i >= 0, `missing ${label}: ${wordMenuSt.rows.map(r=>r.label)}`);
  wordMenuSt.index = i; handleWordMenuInput({z:true}); settle();
}
const { battleSt } = await import('../src/battle-state.js');
const { updateBattleEndSequence } = await import('../src/battle-update.js');
const { hasItem } = await import('../src/inventory.js');
function finish() { assert.equal(typeof transSt.pendingAction,'function');transSt.pendingAction();transSt.pendingAction=null;transSt.state='none'; }
ps.flags.dwarves_saved=1;
mapSt.onWorldMap=true;mapSt.mapStack=[];mapSt.worldX=61*16;mapSt.worldY=82*16;mapSt.disabledTrigger=null;
assert.equal(checkTrigger(),true);assert.notEqual(msgState.state,'none');
settle();msgState.onClose();finish();forceCloseMsgBox();
assert.equal(mapSt.currentMapId,9000,'Tokkul capture must enter Castle Hein');
loadMapById(9004);assert.ok(mapSt.bossSprite);
battleSt.bossId=0xd2;battleSt.battleState='boss-dissolve';battleSt.battleTimer=1000000;
updateBattleEndSequence(16);battleSt.battleState='none';
assert.equal(ps.flags.hein_defeated,undefined,'story return waits for the exit');
const w=mapSt.warpTile;mapSt.worldX=w.x*16;mapSt.worldY=(w.y+1)*16;mapSt.moving=false;
startMove(DIR_UP,true);updateMovement(1000);assert.ok(mapSt.starEffect);
const completeWarp=mapSt.starEffect.onComplete;mapSt.starEffect=null;completeWarp();finish();
assert.equal(ps.flags.hein_defeated,1);assert.equal(mapSt.worldX/16,40);assert.equal(mapSt.worldY/16,66);
assert.notEqual(msgState.state,'none','the restored tree needs its return scene');
forceCloseMsgBox();mapSt.disabledTrigger=null;assert.equal(checkTrigger(),true);finish();
assert.equal(mapSt.currentMapId,173,'forest event must enter Living Woods');
// Traverse Argus's real door chain, including its story seal.
function door(x,y) { forceCloseMsgBox();mapSt.disabledTrigger=null;mapSt.worldX=x*16;mapSt.worldY=y*16;assert.equal(checkTrigger(),true); }
loadMapById(78);door(15,27);finish();assert.equal(mapSt.currentMapId,83);
delete ps.flags.hein_defeated;transSt.pendingAction=null;door(5,1);
assert.equal(transSt.pendingAction,null,'royal hall opened before rescue');
ps.flags.hein_defeated=1;door(5,1);finish();assert.equal(mapSt.currentMapId,81);
door(17,5);assert.equal(transSt.pendingAction,null,'Argus crossed into a Sasune room');
forceCloseMsgBox();
// The restored woods offer a fresh personal run without resetting the world.
closeWordMenu();transSt.state='none';loadMapById(173);
mapSt.worldX=22*16;mapSt.worldY=22*16;dir=DIR_UP;keys.z=true;handleInput();settle();
assert.equal(typeof msgState.onClose,'function');msgState.onClose();
assert.equal(msgState.isPrompt,true);msgState.onAccept();finish();
assert.equal(mapSt.currentMapId,9000);assert.equal(ps.flags.hein_defeated,1);
talkAt(81,11,5);pick('LEARN');pick('ASK');pick('WHEEL');pick('ACCEPT');
assert.equal(ps.quests.argus_time_wheel.s,'cid');assert.equal(hasItem(0x9c),true);
talkAt(33,18,5);assert.equal(ps.quests.argus_time_wheel.s,'done');
assert.equal(ps.flags.enterprise_upgraded,1);assert.equal(ps.vehicleParkedMode,6);
assert.equal(ps.vehicleParkedX,85);assert.equal(ps.vehicleParkedY,66);
const gil=ps.gil;talkAt(33,18,5);assert.equal(ps.gil,gil);
console.log('check-hein-route: OK — capture, boss victory, restored woods, Time Wheel, flying Enterprise');
