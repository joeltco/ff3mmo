// shop.js — in-game shop UI: Buy / Sell / Exit root menu + browse + buy/sell.
// Activated when player presses Z facing a shop counter (see movement.js
// handleAction → openShop). Text fades match the pause-menu pattern. Magic
// shops not wired yet.

import { drawText, measureText } from './font-renderer.js';
import { drawBorderedBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { _makeFadedPal } from './palette.js';
import { _nameToBytes } from './text-utils.js';
import { getItemNameClean } from './text-decoder.js';
import { ITEMS } from './data/items.js';
import { SHOPS } from './data/shops.js';
import { ps } from './player-stats.js';
import { addItem, removeItem, playerInventory } from './inventory.js';
import { showMsgBox } from './message-box.js';
import { playSFX, SFX } from './music.js';
import { ui } from './ui-state.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const ROW_H = 12;

// Text-fade timing — matches pause-menu PAUSE_TEXT_STEP_MS / PAUSE_TEXT_STEPS
const TEXT_STEP_MS = 100;
const TEXT_STEPS   = 4;
const FADE_TOTAL   = (TEXT_STEPS + 1) * TEXT_STEP_MS;  // 500ms

// Outer alpha fade for the whole shop overlay — map fades out as shop fades in.
const OUTER_FADE_MS = 250;

// FF3 NES sell price = floor(buy / 2). Items without a price aren't sellable.
function sellPrice(item) { return item && item.price > 0 ? Math.floor(item.price / 2) : 0; }

// shopSt.state machine:
//   'closed'
//   'opening' (alpha fade) → 'menu'
//   'menu'   → 'closing' (Exit / X) → 'closed'   |   → 'menu-out' (Buy / Sell)
//   'menu-out' (text fade) → 'buy-in' or 'sell-in' (per shopSt.afterFade)
//   'buy-in'  (text fade) → 'buy'  → 'buy-out'  (text fade) → 'menu-in'
//   'sell-in' (text fade) → 'sell' → 'sell-out' (text fade) → 'menu-in'
//   'menu-in' (text fade)  → 'menu'
// confirm dialog overlays buy/sell idle states (no fade — small + transient)
export const shopSt = {
  state:   'closed',
  timer:   0,
  shopId:  null,
  rootCursor: 0,    // 0=Buy, 1=Sell, 2=Exit
  cursor:  0,       // index into items list (buy) or sellable inventory (sell)
  confirm: false,
  sellList: [],     // cached entries [{ id, count, price }] when entering sell
  afterFade: null,  // next state after a text fade-out completes
};

const ROOT_LABELS = ['Buy', 'Sell', 'Exit'];

// ── Public API ────────────────────────────────────────────────────────────

export function openShop(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop || !shop.items) return false; // magic shops (spells:) not wired
  shopSt.state      = 'opening';
  shopSt.timer      = 0;
  shopSt.shopId     = shopId;
  shopSt.rootCursor = 0;
  shopSt.cursor     = 0;
  shopSt.confirm    = false;
  shopSt.afterFade  = null;
  playSFX(SFX.CONFIRM);
  return true;
}

function _close() {
  shopSt.state = 'closed'; shopSt.shopId = null; shopSt.confirm = false;
  shopSt.cursor = 0; shopSt.rootCursor = 0; shopSt.sellList = [];
  shopSt.afterFade = null;
}

function _items() {
  const shop = SHOPS.get(shopSt.shopId);
  return shop ? shop.items : [];
}

function _rebuildSellList() {
  const out = [];
  for (const [k, count] of Object.entries(playerInventory)) {
    if (count <= 0) continue;
    const id = Number(k);
    const item = ITEMS.get(id);
    if (!item || !item.price) continue;
    out.push({ id, count, price: sellPrice(item) });
  }
  shopSt.sellList = out;
}

// ── Update (fade transitions) ─────────────────────────────────────────────

export function updateShop(dt) {
  if (shopSt.state === 'closed') return;
  shopSt.timer += Math.min(dt, 33);
  if (shopSt.state === 'opening' && shopSt.timer >= OUTER_FADE_MS) { shopSt.state = 'menu'; shopSt.timer = 0; }
  else if (shopSt.state === 'closing' && shopSt.timer >= OUTER_FADE_MS) { _close(); }
  else if (shopSt.state === 'menu-in'  && shopSt.timer >= FADE_TOTAL) { shopSt.state = 'menu'; shopSt.timer = 0; }
  else if (shopSt.state === 'menu-out' && shopSt.timer >= FADE_TOTAL) {
    const next = shopSt.afterFade || 'closing';
    shopSt.state = next; shopSt.timer = 0; shopSt.afterFade = null;
  }
  else if (shopSt.state === 'buy-in'  && shopSt.timer >= FADE_TOTAL) { shopSt.state = 'buy';  shopSt.timer = 0; }
  else if (shopSt.state === 'buy-out' && shopSt.timer >= FADE_TOTAL) { shopSt.state = 'menu-in'; shopSt.timer = 0; }
  else if (shopSt.state === 'sell-in' && shopSt.timer >= FADE_TOTAL) { shopSt.state = 'sell'; shopSt.timer = 0; }
  else if (shopSt.state === 'sell-out'&& shopSt.timer >= FADE_TOTAL) { shopSt.state = 'menu-in'; shopSt.timer = 0; }
}

// Outer alpha for the whole shop draw (0 = fully transparent, 1 = solid)
function _outerAlpha() {
  if (shopSt.state === 'opening') return Math.min(shopSt.timer / OUTER_FADE_MS, 1);
  if (shopSt.state === 'closing') return Math.max(1 - shopSt.timer / OUTER_FADE_MS, 0);
  return 1;
}

// ── Input ─────────────────────────────────────────────────────────────────

export function handleShopInput(keys) {
  if (shopSt.state === 'closed') return false;
  // Block input during any fade — outer (opening/closing) or inner (text)
  if (shopSt.state === 'opening' || shopSt.state === 'closing') return true;
  if (shopSt.state.endsWith('-in') || shopSt.state.endsWith('-out')) return true;

  if (shopSt.state === 'menu')      _menuInput(keys);
  else if (shopSt.state === 'buy')  _listInput(keys, _items(), /*isSell*/false);
  else if (shopSt.state === 'sell') _listInput(keys, shopSt.sellList, /*isSell*/true);
  return true;
}

function _menuInput(keys) {
  if (keys['ArrowDown']) { keys['ArrowDown'] = false; shopSt.rootCursor = (shopSt.rootCursor + 1) % 3; playSFX(SFX.CURSOR); }
  if (keys['ArrowUp'])   { keys['ArrowUp']   = false; shopSt.rootCursor = (shopSt.rootCursor + 2) % 3; playSFX(SFX.CURSOR); }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    if (shopSt.rootCursor === 0) {
      shopSt.cursor = 0; shopSt.state = 'menu-out'; shopSt.timer = 0; shopSt.afterFade = 'buy-in';
      playSFX(SFX.CONFIRM);
    } else if (shopSt.rootCursor === 1) {
      _rebuildSellList();
      shopSt.cursor = 0; shopSt.state = 'menu-out'; shopSt.timer = 0; shopSt.afterFade = 'sell-in';
      playSFX(SFX.CONFIRM);
    } else {
      shopSt.state = 'closing'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
    }
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    shopSt.state = 'closing'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
  }
}

function _listInput(keys, list, isSell) {
  if (shopSt.confirm) {
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (isSell) _attemptSell(list[shopSt.cursor]);
      else        _attemptBuy(list[shopSt.cursor]);
      shopSt.confirm = false;
      // For sell: rebuild list since count changed
      if (isSell) {
        _rebuildSellList();
        if (shopSt.cursor >= shopSt.sellList.length) shopSt.cursor = Math.max(0, shopSt.sellList.length - 1);
      }
    } else if (keys['x'] || keys['X'] || keys['Escape']) {
      keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
      shopSt.confirm = false; playSFX(SFX.CONFIRM);
    }
    return;
  }
  if (keys['ArrowDown']) { keys['ArrowDown'] = false; if (shopSt.cursor < list.length - 1) { shopSt.cursor++; playSFX(SFX.CURSOR); } }
  if (keys['ArrowUp'])   { keys['ArrowUp']   = false; if (shopSt.cursor > 0) { shopSt.cursor--; playSFX(SFX.CURSOR); } }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    if (list.length > 0) { shopSt.confirm = true; playSFX(SFX.CONFIRM); }
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    shopSt.state = isSell ? 'sell-out' : 'buy-out'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
  }
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
  showMsgBox(_actionMsg('Bought ', itemId));
}

function _attemptSell(entry) {
  if (!entry || !entry.id || entry.count <= 0) { playSFX(SFX.ERROR); return; }
  ps.gil += entry.price;
  removeItem(entry.id);
  playSFX(SFX.TREASURE);
  showMsgBox(_actionMsg('Sold ', entry.id));
}

function _actionMsg(prefixStr, itemId) {
  const prefix = _nameToBytes(prefixStr);
  const name   = getItemNameClean(itemId);
  const out    = new Uint8Array(prefix.length + name.length + 1);
  out.set(prefix, 0);
  out.set(name, prefix.length);
  out[prefix.length + name.length] = 0xC4; // !
  return out;
}

// ── Draw ──────────────────────────────────────────────────────────────────

function _fadeStepFor(state) {
  if (state.endsWith('-in'))  return TEXT_STEPS - Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  if (state.endsWith('-out')) return Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  return 0;
}

export function drawShop() {
  if (shopSt.state === 'closed') return;
  const ctx = ui.ctx;
  const alpha = _outerAlpha();
  if (alpha <= 0) return;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * alpha;
  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);

  // Outer fade (opening/closing) always shows the root menu — the only thing
  // visible during those states. Inner sub-screens render in their own states.
  if (shopSt.state === 'opening' || shopSt.state === 'closing' ||
      shopSt.state === 'menu' || shopSt.state === 'menu-in' || shopSt.state === 'menu-out')
    _drawRootMenu(ctx);
  else if (shopSt.state === 'buy' || shopSt.state === 'buy-in' || shopSt.state === 'buy-out')
    _drawList(ctx, _items(), /*isSell*/false);
  else if (shopSt.state === 'sell' || shopSt.state === 'sell-in' || shopSt.state === 'sell-out')
    _drawList(ctx, shopSt.sellList, /*isSell*/true);

  ctx.restore();
  ctx.globalAlpha = prevAlpha;

  // Confirm overlays the list — only show in idle, never during fades
  if (shopSt.confirm && (shopSt.state === 'buy' || shopSt.state === 'sell')) {
    const list = shopSt.state === 'buy' ? _items() : shopSt.sellList;
    _drawConfirm(list[shopSt.cursor], shopSt.state === 'sell');
  }
}

function _drawGil(ctx, fadeStep) {
  const pal = _makeFadedPal(fadeStep);
  const lbl = _nameToBytes('Gil');
  const val = _nameToBytes(String(ps.gil));
  drawText(ctx, HUD_VIEW_X + 16, HUD_VIEW_Y + 10, lbl, pal);
  drawText(ctx, HUD_VIEW_X + HUD_VIEW_W - 16 - measureText(val), HUD_VIEW_Y + 10, val, pal);
}

function _drawRootMenu(ctx) {
  const fadeStep = _fadeStepFor(shopSt.state);
  const pal = _makeFadedPal(fadeStep);
  _drawGil(ctx, fadeStep);
  const startY = HUD_VIEW_Y + 36;
  for (let i = 0; i < ROOT_LABELS.length; i++) {
    const y = startY + i * 16;
    drawText(ctx, HUD_VIEW_X + 24, y, _nameToBytes(ROOT_LABELS[i]), pal);
  }
  if (shopSt.state === 'menu')
    drawCursorFaded(HUD_VIEW_X + 8, startY + shopSt.rootCursor * 16 - 4, fadeStep);
}

function _drawList(ctx, list, isSell) {
  const fadeStep = _fadeStepFor(shopSt.state);
  const pal = _makeFadedPal(fadeStep);
  _drawGil(ctx, fadeStep);

  const listY0 = HUD_VIEW_Y + 26;
  const nameX  = HUD_VIEW_X + 24;
  const priceX = HUD_VIEW_X + HUD_VIEW_W - 16;

  if (list.length === 0) {
    drawText(ctx, nameX, listY0, _nameToBytes(isSell ? 'Nothing to sell' : '---'), pal);
    return;
  }

  for (let i = 0; i < list.length; i++) {
    const id    = isSell ? list[i].id    : list[i];
    const price = isSell ? list[i].price : (ITEMS.get(id) && ITEMS.get(id).price) || 0;
    if (!ITEMS.get(id)) continue;
    const y     = listY0 + i * ROW_H;
    const name  = getItemNameClean(id);
    const pNum  = _nameToBytes(String(price));
    drawText(ctx, nameX, y, name, pal);
    drawText(ctx, priceX - measureText(pNum), y, pNum, pal);
  }
  // Hide cursor during fade
  if (shopSt.state === 'buy' || shopSt.state === 'sell')
    drawCursorFaded(HUD_VIEW_X + 8, listY0 + shopSt.cursor * ROW_H - 4, 0);
}

function _drawConfirm(target, isSell) {
  if (!target) return;
  const itemId = isSell ? target.id : target;
  const item   = ITEMS.get(itemId);
  if (!item) return;
  const ctx = ui.ctx;
  const boxW = HUD_VIEW_W;
  const boxH = 40;
  const boxY = HUD_VIEW_Y + HUD_VIEW_H - boxH;
  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, boxY, boxW, boxH, true);

  const verb = isSell ? 'Sell ' : 'Buy ';
  const prefix = _nameToBytes(verb);
  const name   = getItemNameClean(itemId);
  const line1  = new Uint8Array(prefix.length + name.length + 1);
  line1.set(prefix, 0);
  line1.set(name, prefix.length);
  line1[prefix.length + name.length] = 0xC5; // ?
  drawText(ctx, HUD_VIEW_X + 12, boxY + 10, line1, _makeFadedPal(0));

  const hint = _nameToBytes('Z=Yes  X=No');
  drawText(ctx, HUD_VIEW_X + boxW - 12 - measureText(hint), boxY + 24, hint, _makeFadedPal(0));
  ctx.restore();
}
