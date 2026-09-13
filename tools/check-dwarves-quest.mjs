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
const { wordMenuSt, closeWordMenu, handleWordMenuInput } = await import('../src/word-menu.js');
ps.knownSpells = [0x2f, 0x2e];
ps.flags = { owen_restored: 1 }; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
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
ps.unlockedJobs = 0x3f;
talkAt(85,17,5);pick('LEARN');assert.equal(ps.words.horn,1);
talkAt(86,12,28);pick('ASK');pick('HORN');pick('ACCEPT');
assert.equal(ps.quests.dwarves_horns.s,'lake');
closeWordMenu();forceCloseMsgBox();
mapSt.worldX=0;mapSt.worldY=23*16;mapSt.disabledTrigger=null;
assert.equal(checkTrigger(),true);transSt.pendingAction();transSt.state='none';
assert.equal(mapSt.currentMapId,7000,'western passage must enter the generated lake');
function victory(map,boss) {
  loadMapById(map); assert.ok(mapSt.bossSprite);
  battleSt.bossId=boss; battleSt.battleState='boss-dissolve';battleSt.battleTimer=1000000;
  updateBattleEndSequence(16);assert.equal(battleSt.enemyDefeated,true);
  battleSt.battleState='none';
}
victory(7003,0xd0);
assert.equal(ps.unlockedJobs,0x3f,'Gutsco must not grant crystal jobs');
talkAt(86,12,28);assert.equal(ps.quests.dwarves_horns.s,'flame');
assert.equal(ps.flags.horns_stolen,1);assert.equal(ps.flags.dwarves_saved,undefined);
closeWordMenu();forceCloseMsgBox();battleSt.enemyDefeated=false;
mapSt.onWorldMap=true;mapSt.worldX=37*16;mapSt.worldY=23*16;mapSt.disabledTrigger=null;
assert.equal(checkTrigger(),true);transSt.pendingAction();transSt.state='none';
assert.equal(mapSt.currentMapId,8000);
victory(8003,0xd1);
assert.equal(ps.unlockedJobs,0x3ff,'Fire Crystal must add jobs 6-9 and retain Wind jobs');
const before=ps.gil;
talkAt(86,12,28);assert.equal(ps.quests.dwarves_horns.s,'done');
assert.equal(ps.flags.dwarves_saved,1);assert.equal(ps.gil,before+2000);
talkAt(86,12,28);assert.equal(ps.gil,before+2000);
closeWordMenu();forceCloseMsgBox();mapSt.worldX=23*16;mapSt.worldY=31*16;mapSt.disabledTrigger=null;
assert.equal(checkTrigger(),true);transSt.pendingAction();transSt.state='none';
assert.equal(mapSt.currentMapId,91,'horns must open the vault');
console.log('check-dwarves-quest: OK — horn lead, lake, Gutsco, theft, Salamander, fire jobs, vault');
