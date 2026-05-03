// shop.js — in-game shop UI: browse items, buy, deduct gil.
// Activated when player presses Z facing a shop counter (see movement.js
// handleAction → openShop). Magic shops not wired yet.

import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { drawBorderedBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { _nameToBytes } from './text-utils.js';
import { getItemNameClean } from './text-decoder.js';
import { ITEMS } from './data/items.js';
import { SHOPS } from './data/shops.js';
import { ps } from './player-stats.js';
import { addItem } from './inventory.js';
import { showMsgBox } from './message-box.js';
import { playSFX, SFX } from './music.js';
import { ui } from './ui-state.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const ROW_H = 12;

export const shopSt = {
  open:    false,
  shopId:  null,
  cursor:  0,
  confirm: false, // confirm dialog active over the item list
};

export function openShop(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop || !shop.items) return false; // magic shops (spells:) not yet supported
  shopSt.open    = true;
  shopSt.shopId  = shopId;
  shopSt.cursor  = 0;
  shopSt.confirm = false;
  playSFX(SFX.CONFIRM);
  return true;
}

function closeShop() {
  shopSt.open = false; shopSt.shopId = null;
  shopSt.cursor = 0; shopSt.confirm = false;
}

function _items() {
  const shop = SHOPS.get(shopSt.shopId);
  return shop ? shop.items : [];
}

// ── Input ─────────────────────────────────────────────────────────────────

export function handleShopInput(keys) {
  if (!shopSt.open) return false;
  const items = _items();

  if (shopSt.confirm) {
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      _attemptBuy(items[shopSt.cursor]);
      shopSt.confirm = false;
    } else if (keys['x'] || keys['X'] || keys['Escape']) {
      keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
      shopSt.confirm = false;
      playSFX(SFX.CONFIRM);
    }
    return true;
  }

  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    if (shopSt.cursor < items.length - 1) { shopSt.cursor++; playSFX(SFX.CURSOR); }
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    if (shopSt.cursor > 0) { shopSt.cursor--; playSFX(SFX.CURSOR); }
  }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    if (items.length > 0) { shopSt.confirm = true; playSFX(SFX.CONFIRM); }
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    closeShop();
    playSFX(SFX.CONFIRM);
  }
  return true;
}

function _attemptBuy(itemId) {
  const item = ITEMS.get(itemId);
  if (!item) { playSFX(SFX.ERROR); return; }
  if (ps.gil < item.price) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes('Not enough gil!'));
    return;
  }
  ps.gil -= item.price;
  addItem(itemId, 1);
  playSFX(SFX.TREASURE);
  // "Bought <name>!"  — concat "Bought " + ROM-decoded name + "!"
  const prefix = _nameToBytes('Bought ');
  const name   = getItemNameClean(itemId);
  const out    = new Uint8Array(prefix.length + name.length + 1);
  out.set(prefix, 0);
  out.set(name, prefix.length);
  out[prefix.length + name.length] = 0xC4; // !
  showMsgBox(out);
}

// ── Draw ──────────────────────────────────────────────────────────────────

export function drawShop() {
  if (!shopSt.open) return;
  const ctx = ui.ctx;
  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);

  // Gil header — right-aligned
  const gilLabel = _nameToBytes('Gil');
  const gilVal   = _nameToBytes(String(ps.gil));
  const headerY  = HUD_VIEW_Y + 10;
  drawText(ctx, HUD_VIEW_X + 16, headerY, gilLabel, TEXT_WHITE);
  drawText(ctx, HUD_VIEW_X + HUD_VIEW_W - 16 - measureText(gilVal), headerY, gilVal, TEXT_WHITE);

  // Item list
  const items   = _items();
  const listY0  = headerY + 16;
  const nameX   = HUD_VIEW_X + 24;
  const priceX  = HUD_VIEW_X + HUD_VIEW_W - 16;
  for (let i = 0; i < items.length; i++) {
    const id    = items[i];
    const item  = ITEMS.get(id);
    if (!item) continue;
    const y     = listY0 + i * ROW_H;
    const name  = getItemNameClean(id);
    const price = _nameToBytes(String(item.price));
    drawText(ctx, nameX, y, name, TEXT_WHITE);
    drawText(ctx, priceX - measureText(price), y, price, TEXT_WHITE);
    if (i === shopSt.cursor) drawCursorFaded(HUD_VIEW_X + 8, y - 4, 0);
  }

  ctx.restore();

  if (shopSt.confirm) _drawConfirm(items[shopSt.cursor]);
}

function _drawConfirm(itemId) {
  const ctx = ui.ctx;
  const item = ITEMS.get(itemId);
  if (!item) return;
  const boxW = HUD_VIEW_W;
  const boxH = 40;
  const boxY = HUD_VIEW_Y + HUD_VIEW_H - boxH;
  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, boxY, boxW, boxH, true);
  // "Buy <name>?"
  const prefix = _nameToBytes('Buy ');
  const name   = getItemNameClean(itemId);
  const line1  = new Uint8Array(prefix.length + name.length + 1);
  line1.set(prefix, 0);
  line1.set(name, prefix.length);
  line1[prefix.length + name.length] = 0xC5; // ?
  drawText(ctx, HUD_VIEW_X + 12, boxY + 10, line1, TEXT_WHITE);
  // Z=Yes / X=No hint
  const hint = _nameToBytes('Z=Yes  X=No');
  drawText(ctx, HUD_VIEW_X + boxW - 12 - measureText(hint), boxY + 24, hint, TEXT_WHITE);
  ctx.restore();
}
