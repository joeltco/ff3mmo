// shop.js — in-game shop UI: Buy / Sell / Exit root menu + browse + buy/sell.
// Activated when player presses Z facing a shop counter (see movement.js
// handleAction → openShop).
//
// Outer transition (map ↔ shop): NES palette-step fade frames built from a
// snapshot of the live viewport (`buildNesFadeFrames`). Map fades to black,
// then shop box + text fade in via the standard palette-fade pattern.
// Reverse on close.
//
// Inner transitions (root menu ↔ buy/sell): text-palette fade only — same
// pattern as pause-menu PAUSE_TEXT_STEP_MS / PAUSE_TEXT_STEPS.
//
// Magic shops not wired yet.

import { drawText, measureText } from './font-renderer.js';
import { drawBorderedBox, drawHudBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { _makeFadedPal } from './palette.js';
import { _nameToBytes } from './text-utils.js';
import { getItemNameClean } from './text-decoder.js';
import { ITEMS } from './data/items.js';
import { SHOPS } from './data/shops.js';
import { ps } from './player-stats.js';
import { addItem, removeItem, playerInventory } from './inventory.js';
import { showMsgBox } from './message-box.js';
import { playSFX, SFX, pauseMusic, resumeMusic, playFF1Track, stopFF1Music, FF1_TRACKS } from './music.js';
import { ui } from './ui-state.js';
import { buildNesFadeFrames } from './nes-fade.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const ROW_H = 12;

// Inner text-fade timing — matches pause-menu PAUSE_TEXT_STEP_MS / PAUSE_TEXT_STEPS
const TEXT_STEP_MS  = 100;
const TEXT_STEPS    = 4;
const TEXT_FADE_MS  = (TEXT_STEPS + 1) * TEXT_STEP_MS;  // 500ms

// Outer NES fade timing — palette-stepped frames of the map snapshot
const NES_FADE_STEPS   = 4;
const NES_FADE_STEP_MS = 80;
const NES_FADE_MS      = (NES_FADE_STEPS + 1) * NES_FADE_STEP_MS;  // 400ms

// FF3 NES sell price = floor(buy / 2). Items without a price aren't sellable.
function sellPrice(item) { return item && item.price > 0 ? Math.floor(item.price / 2) : 0; }

// State machine:
//   closed
//   → map-out  (NES palette fade of map snapshot, 0→4)
//   → shop-in  (bordered box + text fade in, fadeStep 4→0)
//   → menu     (idle root menu)
//   menu Z Buy/Sell  → menu-out (text fade) → buy-in / sell-in (text fade) → buy / sell
//   menu Z Exit / X  → shop-out (text fade out) → map-in (NES palette fade of snapshot, 4→0) → closed
//   buy / sell  X    → buy-out / sell-out (text fade) → menu-in (text fade) → menu
// confirm dialog overlays buy/sell idle (no fade — small + transient)
export const shopSt = {
  state:      'closed',
  timer:      0,
  shopId:     null,
  rootCursor: 0,        // 0=Buy, 1=Sell, 2=Exit
  cursor:     0,
  confirm:    false,
  sellList:   [],
  afterFade:  null,     // next state after a 'menu-out' (root menu fades into a sub-screen)
  fadeFrames: null,     // [Canvas] from buildNesFadeFrames, lazily built on first map-out frame
};

const ROOT_LABELS = ['Buy', 'Sell', 'Exit'];

// ── Public API ────────────────────────────────────────────────────────────

export function openShop(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop || !shop.items) return false; // magic shops (spells:) not wired
  shopSt.state      = 'map-out';
  shopSt.timer      = 0;
  shopSt.shopId     = shopId;
  shopSt.rootCursor = 0;
  shopSt.cursor     = 0;
  shopSt.confirm    = false;
  shopSt.afterFade  = null;
  shopSt.fadeFrames = null;
  playSFX(SFX.CONFIRM);
  pauseMusic();
  playFF1Track(FF1_TRACKS.SHOP);
  return true;
}

function _close() {
  shopSt.state = 'closed'; shopSt.shopId = null; shopSt.confirm = false;
  shopSt.cursor = 0; shopSt.rootCursor = 0; shopSt.sellList = [];
  shopSt.afterFade = null; shopSt.fadeFrames = null;
  stopFF1Music();
  resumeMusic();
}

function _items() {
  const shop = SHOPS.get(shopSt.shopId);
  return shop ? shop.items : [];
}

function _hoverItemId() {
  if (shopSt.state !== 'buy' && shopSt.state !== 'sell') return null;
  const id = shopSt.state === 'buy'
    ? _items()[shopSt.cursor]
    : (shopSt.sellList[shopSt.cursor] && shopSt.sellList[shopSt.cursor].id);
  return id == null ? null : id;
}

// True if the cursor is on a weapon/armor the player's current job can equip.
// Used by hud-drawing to flip the HUD portrait into a victory-pose flicker.
export function shopHoverEquippable() {
  const id = _hoverItemId();
  if (id == null) return false;
  const item = ITEMS.get(id);
  if (!item || (item.type !== 'weapon' && item.type !== 'armor')) return false;
  return ((item.jobs || 0) & (1 << (ps.jobIdx || 0))) !== 0;
}

// ATK/DEF delta vs the slot the hovered item would replace. Returns positive
// (upgrade), negative (downgrade), or 0 (same / not applicable / not equippable).
// Weapons compare against the better of weaponR / weaponL; armor compares
// against the matching slot. Shields compare against any equipped shield.
export function shopHoverStatDelta() {
  if (!shopHoverEquippable()) return 0;
  const item = ITEMS.get(_hoverItemId());
  if (!item) return 0;
  if (item.type === 'weapon' && item.subtype !== 'shield') {
    const cur = Math.max(_atkOf(ps.weaponR), _atkOf(ps.weaponL));
    return (item.atk || 0) - cur;
  }
  if (item.type === 'armor') {
    if (item.subtype === 'shield') {
      return (item.def || 0) - Math.max(_shieldDefOf(ps.weaponR), _shieldDefOf(ps.weaponL));
    }
    if (item.subtype === 'helmet') return (item.def || 0) - _defOf(ps.head);
    if (item.subtype === 'body')   return (item.def || 0) - _defOf(ps.body);
    if (item.subtype === 'arms')   return (item.def || 0) - _defOf(ps.arms);
  }
  return 0;
}

function _atkOf(id)       { const i = ITEMS.get(id); return (i && i.type === 'weapon' && i.subtype !== 'shield') ? (i.atk || 0) : 0; }
function _defOf(id)       { const i = ITEMS.get(id); return (i && i.type === 'armor') ? (i.def || 0) : 0; }
function _shieldDefOf(id) { const i = ITEMS.get(id); return (i && i.type === 'armor' && i.subtype === 'shield') ? (i.def || 0) : 0; }

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

// ── Update ────────────────────────────────────────────────────────────────

export function updateShop(dt) {
  if (shopSt.state === 'closed') return;
  shopSt.timer += Math.min(dt, 33);
  const s = shopSt.state;
  if      (s === 'map-out'  && shopSt.timer >= NES_FADE_MS)  { shopSt.state = 'shop-in';  shopSt.timer = 0; }
  else if (s === 'shop-in'  && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'menu';     shopSt.timer = 0; }
  else if (s === 'shop-out' && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'map-in';   shopSt.timer = 0; }
  else if (s === 'map-in'   && shopSt.timer >= NES_FADE_MS)  { _close(); }
  else if (s === 'menu-in'  && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'menu';     shopSt.timer = 0; }
  else if (s === 'menu-out' && shopSt.timer >= TEXT_FADE_MS) {
    const next = shopSt.afterFade || 'shop-out';
    shopSt.state = next; shopSt.timer = 0; shopSt.afterFade = null;
  }
  else if (s === 'buy-in'   && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'buy';      shopSt.timer = 0; }
  else if (s === 'buy-out'  && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'menu-in';  shopSt.timer = 0; }
  else if (s === 'sell-in'  && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'sell';     shopSt.timer = 0; }
  else if (s === 'sell-out' && shopSt.timer >= TEXT_FADE_MS) { shopSt.state = 'menu-in';  shopSt.timer = 0; }
}

// Returns true if any fade is in progress (input blocked).
function _isFading() {
  const s = shopSt.state;
  return s === 'map-out' || s === 'shop-in' || s === 'shop-out' || s === 'map-in' ||
         s.endsWith('-in') || s.endsWith('-out');
}

// ── Input ─────────────────────────────────────────────────────────────────

export function handleShopInput(keys) {
  if (shopSt.state === 'closed') return false;
  if (_isFading()) return true;

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
      shopSt.state = 'shop-out'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
    }
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    shopSt.state = 'shop-out'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
  }
}

function _listInput(keys, list, isSell) {
  if (shopSt.confirm) {
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (isSell) _attemptSell(list[shopSt.cursor]);
      else        _attemptBuy(list[shopSt.cursor]);
      shopSt.confirm = false;
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

// Step index for inner text fades (0 = full bright, TEXT_STEPS = blank).
function _textFadeStep(state) {
  if (state.endsWith('-in'))  return TEXT_STEPS - Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  if (state.endsWith('-out')) return Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  return 0;
}

// Step index for outer NES fade (0 = full bright, NES_FADE_STEPS = nearly black).
function _outerFadeStep() {
  if (shopSt.state === 'map-out') return Math.min(Math.floor(shopSt.timer / NES_FADE_STEP_MS), NES_FADE_STEPS);
  if (shopSt.state === 'map-in')  return NES_FADE_STEPS - Math.min(Math.floor(shopSt.timer / NES_FADE_STEP_MS), NES_FADE_STEPS);
  return -1;
}

export function drawShop() {
  if (shopSt.state === 'closed') return;
  const ctx = ui.ctx;

  // ── Outer NES fade phases (map ↔ black) ──────────────────────────────────
  if (shopSt.state === 'map-out' || shopSt.state === 'map-in') {
    if (!shopSt.fadeFrames) {
      // First frame of map-out — capture the live viewport before drawing over it.
      shopSt.fadeFrames = buildNesFadeFrames(ctx.canvas, HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, NES_FADE_STEPS);
    }
    const step = _outerFadeStep();
    const frame = shopSt.fadeFrames[Math.max(0, Math.min(step, NES_FADE_STEPS))];
    if (frame) ctx.drawImage(frame, HUD_VIEW_X, HUD_VIEW_Y);
    return;
  }

  // ── Shop visible phases — black bg + (faded) bordered box + text ─────────
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);

  // Bordered box: faded during shop-in / shop-out (using borderFadeSets), full
  // during all other visible states.
  let boxFadeStep = 0;
  if      (shopSt.state === 'shop-in')  boxFadeStep = TEXT_STEPS - Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  else if (shopSt.state === 'shop-out') boxFadeStep = Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  drawHudBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, boxFadeStep);

  clipToViewport();

  // Sub-screen content. Shop-in / shop-out always show the root menu.
  const s = shopSt.state;
  if (s === 'shop-in' || s === 'shop-out' ||
      s === 'menu' || s === 'menu-in' || s === 'menu-out')
    _drawRootMenu(ctx);
  else if (s === 'buy' || s === 'buy-in' || s === 'buy-out')
    _drawList(ctx, _items(), /*isSell*/false);
  else if (s === 'sell' || s === 'sell-in' || s === 'sell-out')
    _drawList(ctx, shopSt.sellList, /*isSell*/true);

  ctx.restore();

  // Confirm overlay — only show in idle, never during fades
  if (shopSt.confirm && (s === 'buy' || s === 'sell')) {
    const list = s === 'buy' ? _items() : shopSt.sellList;
    _drawConfirm(list[shopSt.cursor], s === 'sell');
  }
}

function _innerTextFadeStep() {
  // Shop-in / shop-out drive the text fade alongside the bordered box.
  if (shopSt.state === 'shop-in')  return TEXT_STEPS - Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  if (shopSt.state === 'shop-out') return Math.min(Math.floor(shopSt.timer / TEXT_STEP_MS), TEXT_STEPS);
  return _textFadeStep(shopSt.state);
}

function _drawGil(ctx, fadeStep) {
  const pal = _makeFadedPal(fadeStep);
  const lbl = _nameToBytes('Gil');
  const val = _nameToBytes(String(ps.gil));
  drawText(ctx, HUD_VIEW_X + 16, HUD_VIEW_Y + 10, lbl, pal);
  drawText(ctx, HUD_VIEW_X + HUD_VIEW_W - 16 - measureText(val), HUD_VIEW_Y + 10, val, pal);
}

function _drawRootMenu(ctx) {
  const fadeStep = _innerTextFadeStep();
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
  const fadeStep = _innerTextFadeStep();
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
