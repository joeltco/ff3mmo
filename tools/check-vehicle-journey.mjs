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
const { transSt } = await import('../src/transitions.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { startMove, updateMovement, handleInput } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP, DIR_LEFT, DIR_RIGHT } = await import('../src/sprite.js');
const { msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { keys } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
let dir = DIR_UP;
setPlayerSprite({ getDirection: () => dir, setDirection: d => { dir = d; }, resetFrame() {}, setWalkProgress() {} });
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
initMapLoading(rom);
mapSt.worldMapData = loadWorldMap(rom, 0);
mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
const { setPlayerInventory } = await import('../src/inventory.js');
ps.flags = {}; ps.quests = {}; ps.words = {};
setPlayerInventory({ 0xa5: 1 });
const r = mapSt.worldMapRenderer;
function place(x, y, mode) {
  mapSt.onWorldMap = true; mapSt.worldX = x * 16; mapSt.worldY = y * 16;
  mapSt.mapStack = []; mapSt.moving = false; mapSt.disabledTrigger = null;
  ps.vehicle = mode; transSt.state = 'none'; forceCloseMsgBox();
}
function move(d) { startMove(d, true); assert.equal(mapSt.moving, true); updateMovement(1000); }
// Choose actual ROM terrain with no entrance, so this checks travel, not a mock mask.
let land;
for (let y = 3; y < 125 && !land; y++) for (let x = 3; x < 123; x++) {
  if ([x, x+1, x+2].every(a => r.isFootWalkable(a,y) && r.isPassableForMode(a,y,5) && !r.getTriggerAt(a,y))) {
    land = [x,y]; break;
  }
}
assert.ok(land);
place(...land, 5); ps.vehicleParked = 0;
move(DIR_RIGHT); move(DIR_RIGHT);
assert.equal(ps.vehicle, 5, 'flight must continue across walkable land');
keys.z = true; handleInput();
assert.equal(ps.vehicle, 0); assert.equal(ps.vehicleParkedMode, 5);
assert.equal(ps.vehicleParkedX, land[0]+2);
move(DIR_LEFT); move(DIR_RIGHT);
assert.equal(ps.vehicle, 5, 'landed craft must board again');
// Flying over Canaan must not pull the player indoors.
place(86,66,5); assert.equal(checkTrigger(), false);
keys.z = true; handleInput(); assert.equal(transSt.destMapId,31);
// A chocobo stays mounted across land and dismounts without moving the ship.
place(...land,1);ps.vehicleParked=1;ps.vehicleParkedMode=3;ps.vehicleParkedX=80;ps.vehicleParkedY=80;
move(DIR_RIGHT);move(DIR_RIGHT);assert.equal(ps.vehicle,1);
keys.z=true;handleInput();assert.equal(ps.vehicle,0);
assert.equal(ps.vehicleParkedMode,3);assert.equal(ps.vehicleParkedX,80);
// Canoe river crossing preserves a parked Enterprise elsewhere.
let bank;
for (let y = 3; y < 125 && !bank; y++) for (let x = 3; x < 124; x++) {
  if (r.isFootWalkable(x,y) && !r.getTriggerAt(x,y)
      && !r.isFootWalkable(x+1,y) && r.isPassableForMode(x+1,y,2)
      && !r.getTriggerAt(x+1,y)) { bank = [x,y]; break; }
}
assert.ok(bank);
place(...bank,0); ps.vehicleParked = 1; ps.vehicleParkedMode = 3;
ps.vehicleParkedX = 80; ps.vehicleParkedY = 80;
move(DIR_RIGHT); assert.equal(ps.vehicle,2);
move(DIR_LEFT); assert.equal(ps.vehicle,0);
assert.equal(ps.vehicleParkedMode,3); assert.equal(ps.vehicleParkedX,80);
// The awarded ship is boardable from the actual Viking shoreline and can return.
assert.equal(r.isFootWalkable(81,80),true);
place(81,80,0); move(DIR_LEFT); assert.equal(ps.vehicle,3);
move(DIR_RIGHT); assert.equal(ps.vehicle,0);
assert.equal(ps.vehicleParkedX,80); assert.equal(ps.vehicleParkedY,80);
// The Nelv rock responds to a blocked move and remains open on world reload.
place(81,55,0); ps.flags = {}; mapSt.worldMapData.boulderCleared = false;
startMove(DIR_UP,true); assert.notEqual(msgState.state,'none');
assert.equal(ps.flags.nelv_pass_open,undefined);
forceCloseMsgBox(); ps.flags.curse_lifted = 1;
startMove(DIR_UP,true); assert.equal(msgState.isPrompt,true);
msgState.onAccept(); transSt.pendingAction(); transSt.state = 'none';
assert.equal(ps.flags.nelv_pass_open,1);
assert.equal(mapSt.worldMapData.boulderCleared,true);
console.log('check-vehicle-journey: OK — flight, landing, reboarding, canoe, Viking ship, Nelv road');
