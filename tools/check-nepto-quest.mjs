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
const { noteBossDefeated } = await import('../src/quests.js');
ps.knownSpells = [0x2f, 0x2e];
ps.flags = { doctor_healed: 1 }; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
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
talkAt(51,25,11); pick('LEARN'); assert.equal(ps.words.nepto,1);
talkAt(53,7,7); pick('ASK'); pick('NEPTO'); pick('ACCEPT');
assert.equal(ps.quests.vikings_nepto.s,'eye');
assert.notEqual(ps.vehicleParkedMode,3);
// Ordinary wins and an unrelated boss cannot satisfy the temple objective.
noteBossDefeated(0xcd); talkAt(53,7,7);
assert.equal(ps.quests.vikings_nepto.s,'eye');
// Verify the overworld entrance really selects Nepto's generated run.
closeWordMenu(); forceCloseMsgBox();
mapSt.onWorldMap = true; mapSt.mapStack = []; mapSt.disabledTrigger = null;
mapSt.worldX = 72*16; mapSt.worldY = 72*16;
assert.equal(checkTrigger(),true); transSt.pendingAction(); transSt.state='none';
assert.equal(mapSt.currentMapId,5000);
loadMapById(5003); assert.ok(mapSt.bossSprite);
// Inject the battle-victory event; combat resolution itself has separate gates.
noteBossDefeated(0xce);
talkAt(53,7,7);
assert.equal(ps.quests.vikings_nepto.s,'done');
assert.equal(ps.flags.nepto_restored,1);
assert.equal(ps.vehicleParkedMode,3);
assert.equal(ps.vehicleParkedX,80); assert.equal(ps.vehicleParkedY,80);
assert.equal(ps.gil,600);
const earnedExp=ps.stats.exp;
talkAt(53,7,7); assert.equal(ps.gil,600); assert.equal(ps.stats.exp,earnedExp);
console.log('check-nepto-quest: OK — learn, ask, accept, entrance, victory hand-in, one ship reward');
