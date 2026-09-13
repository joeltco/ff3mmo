#!/usr/bin/env node
// Exercise Z from the customer's tile, not talkToNpc called directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { mapSt } = await import('../src/map-state.js');
const { clearNpcs, placeTownNpcs } = await import('../src/npc.js');
const { handleInput } = await import('../src/movement.js');
const { keys } = await import('../src/input-handler.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP } = await import('../src/sprite.js');
const { msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { wordMenuSt, closeWordMenu, handleWordMenuInput } = await import('../src/word-menu.js');
const { shopSt } = await import('../src/shop.js');
const { ps } = await import('../src/player-stats.js');
setPlayerSprite({ getDirection: () => DIR_UP, setDirection() {}, resetFrame() {} });
ps.words = { airship: 1 };
ps.flags = {}; ps.quests = {};
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
for (const [id, x, y, shop] of [[9, 23, 5, null], [12, 9, 25, 'kazus_item'], [16, 3, 24, 'kazus_weapon'], [17, 3, 6, 'kazus_armor']]) {
  closeWordMenu(); forceCloseMsgBox(); clearNpcs(); shopSt.state = 'closed';
  mapSt.currentMapId = id; mapSt.onWorldMap = false;
  mapSt.mapData = loadMap(rom, id);
  mapSt.mapRenderer = new MapRenderer(mapSt.mapData, x, y);
  mapSt.worldX = x * 16; mapSt.worldY = y * 16;
  mapSt.bossSprite = null; mapSt.moving = false;
  placeTownNpcs(id);
  keys.z = true; handleInput();
  assert.notEqual(msgState.state, 'none', `map ${id}: customer cannot talk across counter`);
  // Finish the actual dialogue callback so the real merchant menu opens.
  for (let i = 0; i < 32 && msgState.onAdvance; i++) msgState.onAdvance();
  if (msgState.onClose) msgState.onClose();
  if (shop) {
    assert.equal(wordMenuSt.open, true, `map ${id}: no merchant menu`);
    assert.equal(wordMenuSt.rows[0].label, 'SHOP');
    msgState.state = 'hold'; msgState.onAdvance = null;
    handleWordMenuInput({ z: true });
    assert.equal(shopSt.shopId, shop);
    assert.equal(wordMenuSt.open, false);
  }
}
console.log('check-counter-talk: OK — customer Z reaches tavern/merchant dialogue and SHOP');
