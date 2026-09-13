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
// ⛔ BOTH KINDS OF KEEPER, OR THIS GATE LIES. A keeper WITH speech reaches the
// talk menu and SHOP appears there ('menu'). A keeper with NO speech — Ur's
// WEAPON_KEEPER teaches nothing, answers nothing, has no dialogue — must open
// the shop DIRECTLY ('direct'), because `resolveSpeech` returns null for them.
// v1.12.0 shipped with maps 4/5/8 completely dead and this gate green, because
// every row in it was a Kazus/tavern keeper who happened to have lines. Joel
// found it by walking into Ur. Fixed in v1.13.1.
for (const [id, x, y, shop, mode] of [
  [9, 23, 5, null, 'menu'],
  [12, 9, 25, 'kazus_item', 'menu'],
  [16, 3, 24, 'kazus_weapon', 'menu'],
  [17, 3, 6, 'kazus_armor', 'menu'],
  [5, 3, 24, 'ur_weapon', 'direct'],
  [4, 3, 6, 'ur_armor', 'direct'],
  [8, 8, 16, 'ur_item', 'direct'],
]) {
  closeWordMenu(); forceCloseMsgBox(); clearNpcs(); shopSt.state = 'closed';
  // ⛔ Clear the ID too. Leaving the previous row's shop in `shopSt.shopId`
  // lets a dead counter 'pass' on a stale value from the iteration before.
  shopSt.shopId = null;
  mapSt.currentMapId = id; mapSt.onWorldMap = false;
  mapSt.mapData = loadMap(rom, id);
  mapSt.mapRenderer = new MapRenderer(mapSt.mapData, x, y);
  mapSt.worldX = x * 16; mapSt.worldY = y * 16;
  mapSt.bossSprite = null; mapSt.moving = false;
  placeTownNpcs(id);
  keys.z = true; handleInput();
  if (mode === 'direct') {
    assert.equal(shopSt.shopId, shop, `map ${id}: silent keeper's counter opened nothing`);
    assert.equal(msgState.state, 'none', `map ${id}: silent keeper should not open a box`);
    continue;
  }
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
console.log('check-counter-talk: OK — talking keepers reach dialogue+SHOP, silent keepers open the shop directly');
