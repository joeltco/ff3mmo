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
const { startMove, updateMovement, handleInput } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP, DIR_LEFT } = await import('../src/sprite.js');
const { msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { keys } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
let dir = DIR_UP;
setPlayerSprite({ getDirection: () => dir, setDirection: d => { dir = d; }, resetFrame() {}, setWalkProgress() {} });
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
initMapLoading(rom);
mapSt.worldMapData = loadWorldMap(rom, 0);
mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
assert.deepEqual(mapSt.worldMapRenderer.getTriggerAt(88, 69), { type: 'event', eventId: 2 });
assert.deepEqual(mapSt.worldMapRenderer.getTriggerAt(88, 66), { type: 'event', eventId: 3 });
assert.equal(mapSt.worldMapRenderer.getTriggerAt(95, 41).destMap, 114);
assert.deepEqual(mapSt.worldMapData.triggerPositions.get(2), {x:32,y:53}, 'only event 9 may locate Lake Dohr');
ps.knownSpells = []; ps.flags = {}; ps.quests = {}; ps.words = {}; ps.vehicle = 0;
ps.stats = { maxHP: 100, maxMP: 12 }; ps.hp = 3; ps.mp = 0;
mapSt.onWorldMap = true; mapSt.worldX = 88 * 16; mapSt.worldY = 69 * 16;
mapSt.disabledTrigger = null; mapSt.mapStack = [];
assert.equal(checkTrigger(), true);
assert.equal(transSt.destMapId, 92);
transSt.pendingAction(); transSt.state = 'none';
assert.equal(mapSt.currentMapId, 92);

// Walk the actual collision graph from the ROM entrance to the summit.
const start = [mapSt.worldX / 16, mapSt.worldY / 16];
const todo = [start], seen = new Set([start.join(',')]);
for (let i = 0; i < todo.length; i++) {
  const [x, y] = todo[i];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
    if (nx < 0 || ny < 0 || nx >= 32 || ny >= 32 || seen.has(key)) continue;
    if (!mapSt.mapRenderer.isPassable(nx, ny)) continue;
    seen.add(key); todo.push([nx, ny]);
  }
}
assert.ok(seen.has('11,2'), 'summit is disconnected from mountain entrance');
mapSt.worldX = 11 * 16; mapSt.worldY = 2 * 16;
startMove(DIR_UP, true); updateMovement(1000);
assert.notEqual(msgState.state, 'none', 'summit exit did not start Bahamut scene');
for (let i = 0; i < 32 && msgState.onAdvance; i++) msgState.onAdvance();
msgState.onClose();
assert.equal(transSt.destMapId, 185);
transSt.pendingAction(); transSt.state = 'none'; forceCloseMsgBox();
assert.equal(mapSt.currentMapId, 185);
assert.equal(ps.flags.bahamut_escaped, 1);
assert.ok(ps.knownSpells.includes(0x2f));
assert.equal(ps.hp, 100);
assert.equal(ps.lastWorldExitX, 92); assert.equal(ps.lastWorldExitY, 81);

// Springs are reached by the same Z dispatcher as every other interaction.
mapSt.worldX = 5 * 16; mapSt.worldY = 2 * 16; dir = DIR_UP;
ps.hp = 1; ps.status = { mask: 4, poisonDmgTick: 1 };
keys.z = true; handleInput();
assert.equal(ps.hp, 100); assert.equal(ps.status.mask, 0);
forceCloseMsgBox();
mapSt.worldX = 2 * 16; mapSt.worldY = 5 * 16; dir = DIR_LEFT;
keys.z = true; handleInput();
assert.equal(msgState.isPrompt, true);
msgState.onAccept(); transSt.pendingAction(); transSt.state = 'none';
assert.equal(mapSt.onWorldMap, true);
assert.equal(mapSt.worldX / 16, 86); assert.equal(mapSt.worldY / 16, 66);
// Reloading the Copse itself must also keep a usable entrance.
loadMapById(185);
assert.equal(mapSt.mapRenderer.isPassable(mapSt.worldX / 16, mapSt.worldY / 16), true);
console.log('check-mountain-route: OK — world event, climb, summit escape, healing, return warp');
