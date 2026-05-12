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
import { drawBorderedBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { _makeFadedPal, _stepPalFade } from './palette.js';
import { _nameToBytes } from './text-utils.js';
import { getItemNameClean, getItemNameShrines, getSpellNameClean, getSpellNameShrines } from './text-decoder.js';
import { ITEMS } from './data/items.js';
import { SHOPS, getShopType } from './data/shops.js';
import { getShopSprite, SHOPKEEP_IMAGE_LAYOUT } from './data/shop-sprites.js';
import { decodeTile, drawTile } from './tile-decoder.js';
import { SPELLS, getSpellBuyPrice, canLearnSpell } from './data/spells.js';
import { ps, grantGil, spendGil } from './player-stats.js';
import { addItem, removeItem, playerInventory } from './inventory.js';
import { showMsgBox } from './message-box.js';
import { playSFX, SFX, pauseMusic, resumeMusic, playFF1Track, stopFF1Music, FF1_TRACKS } from './music.js';
import { ui, isMobile } from './ui-state.js';
import { buildNesFadeFrames } from './nes-fade.js';
import { saveSlotsToDB } from './save-state.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
// Inner area inside the viewport's HUD border tiles (8px frame each side).
// All shop drawing — snapshot, fade frames, black fill — must stay inside
// these bounds so the static HUD-canvas border around the viewport isn't
// touched (and therefore doesn't fade with the snapshot).
const INNER_X = HUD_VIEW_X + 8;
const INNER_Y = HUD_VIEW_Y + 8;
const INNER_W = HUD_VIEW_W - 16;
const INNER_H = HUD_VIEW_H - 16;
const ROW_H = 12;

// v1.7.257 layout — FF1-style. Keeper occupies the upper-left, the
// Buy/Sell/Exit menu sits in the upper-right, and the buy/sell list
// stretches across the bottom of the panel.
const KEEPER_X       = HUD_VIEW_X + 8;       // panel-relative x for the keeper origin
const KEEPER_Y       = HUD_VIEW_Y + 4;       // sprite's row 0 starts here (rows 0-1 are blank backdrop)
const MENU_X         = HUD_VIEW_X + 72;      // Buy/Sell/Exit column, right of keeper
const MENU_Y         = HUD_VIEW_Y + 32;      // first menu row (Buy)
const MENU_STEP      = 16;                   // per-row spacing in menu
const LIST_Y0        = HUD_VIEW_Y + 96;      // first list row (below keeper)
const LIST_VISIBLE_ROWS = Math.floor((HUD_VIEW_Y + HUD_VIEW_H - 8 - LIST_Y0) / ROW_H);  // = 4

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
  scroll:     0,        // first visible row of the buy/sell list (v1.7.257 layout)
  confirm:    false,
  // Quantity selector (v1.7.260) — when `confirm` is true on a non-spell shop,
  // the right column hosts a buy/sell-how-many widget instead of the old blue
  // confirm box. Spells stay single-purchase (`qty` ignored, blue box gone).
  qty:        1,
  qtyMax:     1,
  sellList:   [],
  afterFade:  null,     // next state after a 'menu-out' (root menu fades into a sub-screen)
  fadeFrames: null,     // [Canvas] from buildNesFadeFrames, lazily built on first map-out frame
};

const ROOT_LABELS = ['Buy', 'Sell', 'Exit'];

// ── Public API ────────────────────────────────────────────────────────────

export function openShop(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop || (!shop.items && !shop.spells)) return false;
  // Persist the player's exact tile-in-front-of-counter coords before the
  // shop covers the screen. A tab close while inside the shop will then
  // resume right at the counter on next launch, not at the town entrance
  // (which is the most recent prior save from the loadMapById call).
  saveSlotsToDB();
  shopSt.state      = 'map-out';
  shopSt.timer      = 0;
  shopSt.shopId     = shopId;
  shopSt.rootCursor = 0;
  shopSt.cursor     = 0;
  shopSt.scroll     = 0;
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

function _isSpellShop() {
  const shop = SHOPS.get(shopSt.shopId);
  return !!(shop && shop.spells);
}

// Catalog IDs for the active shop — items (for item shops) or spells (for magic shops).
function _items() {
  const shop = SHOPS.get(shopSt.shopId);
  if (!shop) return [];
  return shop.spells || shop.items || [];
}

function _hoverItemId() {
  if (shopSt.state !== 'buy' && shopSt.state !== 'sell') return null;
  if (_isSpellShop()) return null;
  const id = shopSt.state === 'buy'
    ? _items()[shopSt.cursor]
    : (shopSt.sellList[shopSt.cursor] && shopSt.sellList[shopSt.cursor].id);
  return id == null ? null : id;
}

// True if the cursor is on a weapon/armor the player's current job can equip.
// Used by hud-drawing to flip the HUD portrait into a victory-pose flicker.
export function shopHoverEquippable() {
  if (_isSpellShop()) return false;
  const id = _hoverItemId();
  if (id == null) return false;
  const item = ITEMS.get(id);
  if (!item || (item.type !== 'weapon' && item.type !== 'armor')) return false;
  return ((item.jobs || 0) & (1 << (ps.jobIdx || 0))) !== 0;
}

// ATK/DEF delta vs the slot the hovered item would replace.
//   null  → no indicator (not equipment / not equippable / unknown subtype)
//   > 0   → upgrade (green ▲)
//   < 0   → downgrade (red ▼)
//   = 0   → same stat (white =)
// Weapons compare against the BEST of weaponR / weaponL (the user upgrades
// their main weapon, not their dual-wield padding). If the same item ID is
// already in either hand, treat as = regardless of slot — a duplicate isn't
// an upgrade just because the off-hand is empty.
// Shields compare against the existing shield (at most one can be equipped).
export function shopHoverStatDelta() {
  if (_isSpellShop()) return null;
  if (!shopHoverEquippable()) return null;
  const id = _hoverItemId();
  const item = ITEMS.get(id);
  if (!item) return null;
  if (item.type === 'weapon' && item.subtype !== 'shield') {
    if (ps.weaponR === id || ps.weaponL === id) return 0; // already wielding this exact weapon
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
  return null;
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
      shopSt.cursor = 0; shopSt.scroll = 0; shopSt.state = 'menu-out'; shopSt.timer = 0; shopSt.afterFade = 'buy-in';
      playSFX(SFX.CONFIRM);
    } else if (shopSt.rootCursor === 1) {
      if (_isSpellShop()) { playSFX(SFX.ERROR); return; }   // can't sell spells
      _rebuildSellList();
      shopSt.cursor = 0; shopSt.scroll = 0; shopSt.state = 'menu-out'; shopSt.timer = 0; shopSt.afterFade = 'sell-in';
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

function _qtyCap(target, isSell) {
  if (_isSpellShop()) return 1;
  if (isSell) return Math.min(99, target.count);
  const item = ITEMS.get(target);
  const price = (item && item.price) || 0;
  if (price <= 0) return 99;
  return Math.min(99, Math.floor(ps.gil / price));
}

function _listInput(keys, list, isSell) {
  if (shopSt.confirm) {
    // Spells: single-purchase confirm (existing blue box). Items: in-place
    // quantity selector in the right column.
    const isSpell = _isSpellShop();
    if (!isSpell) {
      if (keys['ArrowUp'])    { keys['ArrowUp']    = false; if (shopSt.qty < shopSt.qtyMax) { shopSt.qty = Math.min(shopSt.qtyMax, shopSt.qty + 1);  playSFX(SFX.CURSOR); } }
      if (keys['ArrowDown'])  { keys['ArrowDown']  = false; if (shopSt.qty > 1)              { shopSt.qty = Math.max(1, shopSt.qty - 1);             playSFX(SFX.CURSOR); } }
      if (keys['ArrowRight']) { keys['ArrowRight'] = false; if (shopSt.qty < shopSt.qtyMax) { shopSt.qty = Math.min(shopSt.qtyMax, shopSt.qty + 10); playSFX(SFX.CURSOR); } }
      if (keys['ArrowLeft'])  { keys['ArrowLeft']  = false; if (shopSt.qty > 1)              { shopSt.qty = Math.max(1, shopSt.qty - 10);            playSFX(SFX.CURSOR); } }
    }
    if (keys['z'] || keys['Z']) {
      keys['z'] = false; keys['Z'] = false;
      if (isSpell) _attemptBuy(list[shopSt.cursor]);
      else if (isSell) _attemptSell(list[shopSt.cursor], shopSt.qty);
      else        _attemptBuy(list[shopSt.cursor], shopSt.qty);
      shopSt.confirm = false;
      shopSt.qty = 1;
      if (isSell) {
        _rebuildSellList();
        if (shopSt.cursor >= shopSt.sellList.length) shopSt.cursor = Math.max(0, shopSt.sellList.length - 1);
        if (shopSt.scroll > shopSt.cursor) shopSt.scroll = shopSt.cursor;
      }
    } else if (keys['x'] || keys['X'] || keys['Escape']) {
      keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
      shopSt.confirm = false; shopSt.qty = 1; playSFX(SFX.CONFIRM);
    }
    return;
  }
  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    if (shopSt.cursor < list.length - 1) {
      shopSt.cursor++;
      if (shopSt.cursor - shopSt.scroll >= LIST_VISIBLE_ROWS) shopSt.scroll = shopSt.cursor - LIST_VISIBLE_ROWS + 1;
      playSFX(SFX.CURSOR);
    }
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    if (shopSt.cursor > 0) {
      shopSt.cursor--;
      if (shopSt.cursor < shopSt.scroll) shopSt.scroll = shopSt.cursor;
      playSFX(SFX.CURSOR);
    }
  }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    if (list.length > 0) {
      shopSt.confirm = true;
      shopSt.qtyMax = _qtyCap(list[shopSt.cursor], isSell);
      shopSt.qty = shopSt.qtyMax > 0 ? 1 : 0;
      playSFX(SFX.CONFIRM);
    }
  }
  if (keys['x'] || keys['X'] || keys['Escape']) {
    keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
    shopSt.state = isSell ? 'sell-out' : 'buy-out'; shopSt.timer = 0; playSFX(SFX.CONFIRM);
  }
}

function _attemptBuy(itemId, qty = 1) {
  if (_isSpellShop()) { _attemptBuySpell(itemId); return; }
  const item = ITEMS.get(itemId);
  if (!item) { playSFX(SFX.ERROR); return; }
  if (qty <= 0) { playSFX(SFX.ERROR); return; }
  const total = item.price * qty;
  if (!spendGil(total)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes('Not enough gil!'));
    return;
  }
  addItem(itemId, qty);
  saveSlotsToDB();
  playSFX(SFX.TREASURE);
  showMsgBox(_actionMsg(qty > 1 ? `Bought ${qty} ` : 'Bought ', itemId));
}

function _attemptBuySpell(spellId) {
  const spell = SPELLS.get(spellId);
  if (!spell) { playSFX(SFX.ERROR); return; }
  const price = getSpellBuyPrice(spellId);
  if (!canLearnSpell(ps.jobIdx, spellId)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes("Can't learn that!"));
    return;
  }
  if (ps.knownSpells && ps.knownSpells.includes(spellId)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes('Already known!'));
    return;
  }
  if (!spendGil(price)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes('Not enough gil!'));
    return;
  }
  if (!ps.knownSpells) ps.knownSpells = [];
  ps.knownSpells.push(spellId);
  saveSlotsToDB();
  playSFX(SFX.TREASURE);
  showMsgBox(_spellActionMsg('Learned ', spellId));
}

function _spellActionMsg(prefixStr, spellId) {
  const prefix = _nameToBytes(prefixStr);
  const name   = getSpellNameClean(spellId);
  const out    = new Uint8Array(prefix.length + name.length + 1);
  out.set(prefix, 0);
  out.set(name, prefix.length);
  out[prefix.length + name.length] = 0xC4; // !
  return out;
}

function _attemptSell(entry, qty = 1) {
  if (!entry || !entry.id || entry.count <= 0) { playSFX(SFX.ERROR); return; }
  const n = Math.max(1, Math.min(qty, entry.count));
  grantGil(entry.price * n);
  for (let i = 0; i < n; i++) removeItem(entry.id);
  saveSlotsToDB();
  playSFX(SFX.TREASURE);
  showMsgBox(_actionMsg(n > 1 ? `Sold ${n} ` : 'Sold ', entry.id));
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
      // First frame of map-out — capture the live inner viewport (skip the
      // HUD border tiles around it) before drawing over it.
      shopSt.fadeFrames = buildNesFadeFrames(ctx.canvas, INNER_X, INNER_Y, INNER_W, INNER_H, NES_FADE_STEPS);
    }
    const step = _outerFadeStep();
    const frame = shopSt.fadeFrames[Math.max(0, Math.min(step, NES_FADE_STEPS))];
    if (frame) ctx.drawImage(frame, INNER_X, INNER_Y);
    return;
  }

  // ── Shop visible phases — black inner fill + text ────────────────────────
  // The static HUD canvas already drew the viewport border this frame; we
  // only fill the inner area so the border isn't disturbed.
  ctx.fillStyle = '#000';
  ctx.fillRect(INNER_X, INNER_Y, INNER_W, INNER_H);

  clipToViewport();

  // v1.7.257 layout — keeper + Gil + right-column menu are present in
  // every visible shop state. The buy/sell item list paints on top of
  // the lower half only when we're inside those states.
  const s = shopSt.state;
  const fadeStep = _innerTextFadeStep();
  // Keeper sprite only fades on the outer shop-in / shop-out transitions
  // (matches the bordered-box fade). Intra-shop menu sub-fades
  // (menu-in / menu-out / buy-in / sell-in / etc.) leave the keeper at
  // full saturation so it doesn't flicker every time the user picks
  // Buy / Sell.
  const keeperFade = (s === 'shop-in' || s === 'shop-out') ? fadeStep : 0;
  _drawShopkeeper(ctx, KEEPER_X, KEEPER_Y, keeperFade);
  _drawGil(ctx, fadeStep);
  // Menu always at the same brightness during intra-shop transitions —
  // selecting Buy/Sell shouldn't flash the Buy/Sell/Exit text to black,
  // because the menu is part of the panel layout (right column), not a
  // sub-screen that fades out. Only the outer shop-in / shop-out tween
  // touches the menu palette.
  // While the qty selector is up, the Buy/Sell/Exit text is suppressed
  // entirely — the same right column is reused as the qty widget.
  const isItemConfirm = shopSt.confirm && (s === 'buy' || s === 'sell') && !_isSpellShop();
  if (!isItemConfirm) {
    const menuFade = (s === 'shop-in' || s === 'shop-out') ? fadeStep : 0;
    _drawRootMenu(ctx, menuFade);
  }
  if (s === 'buy' || s === 'buy-in' || s === 'buy-out')
    _drawList(ctx, _items(), /*isSell*/false);
  else if (s === 'sell' || s === 'sell-in' || s === 'sell-out')
    _drawList(ctx, shopSt.sellList, /*isSell*/true);

  if (isItemConfirm) {
    const list = s === 'buy' ? _items() : shopSt.sellList;
    _drawQuantity(ctx, fadeStep, list[shopSt.cursor], s === 'sell');
  }

  ctx.restore();

  // Spell shops keep the original blue confirm box (single-purchase flow,
  // qty selector doesn't apply — you can only learn a spell once).
  if (shopSt.confirm && (s === 'buy' || s === 'sell') && _isSpellShop()) {
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
  // Label sits at the right column (after the keeper) so the sprite's
  // upper-left area stays clean. Value right-aligned at the panel edge.
  drawText(ctx, MENU_X, HUD_VIEW_Y + 10, lbl, pal);
  drawText(ctx, HUD_VIEW_X + HUD_VIEW_W - 16 - measureText(val), HUD_VIEW_Y + 10, val, pal);
}

// FF1-style shopkeeper sprite — 10×10 BG nametable rect using the FF1
// `lut_ShopkeepImage` layout (`SHOPKEEP_IMAGE_LAYOUT`). The 13 keeper
// tiles for the active shop type live in `SHOP_KEEPER_TILES` keyed by
// FF1 canonical type ('weapon'|'armor'|'white-magic'|'black-magic'|
// 'item'); ff3mmo's 4-type catalog maps through `FF3MMO_TO_FF1` inside
// `getShopSprite`. No-op when the capture for the active type hasn't
// landed yet — adding tile bytes to the map lights up the matching
// shops with no further wiring.
//
// Layout tile indices 1..13 reference `sprite.tiles` (13×16 bytes), tile
// 0 in the layout means "transparent backdrop" — skipped.
//
// `fadeStep` runs the keeper's palette slots 1..3 through `nesColorFade`
// that many times so the sprite fades in/out alongside the menu text
// during shop-in / shop-out and sub-state transitions. Slot 0 stays
// transparent and is never recolored.
function _drawShopkeeper(ctx, originX, originY, fadeStep = 0) {
  const sprite = getShopSprite(getShopType(shopSt.shopId));
  if (!sprite || !sprite.tiles || sprite.tiles.length < 13 * 16) return;
  const basePal = sprite.palette;
  if (!basePal || basePal.length < 4) return;
  const pal = basePal.slice();
  for (let s = 0; s < fadeStep; s++) _stepPalFade(pal);
  for (let row = 0; row < SHOPKEEP_IMAGE_LAYOUT.length; row++) {
    const rowTiles = SHOPKEEP_IMAGE_LAYOUT[row];
    for (let col = 0; col < rowTiles.length; col++) {
      const idx = rowTiles[col];
      if (idx === 0) continue;            // backdrop — leave transparent
      const tileOff = (idx - 1) * 16;     // 1..13 maps to byte offsets 0..192
      const pixels = decodeTile(sprite.tiles, tileOff);
      drawTile(ctx, pixels, pal, originX + col * 8, originY + row * 8);
    }
  }
}

// Right-column menu — Buy / Sell / Exit. Drawn in every shop state
// so the player always has the keeper + menu context, even while the
// buy/sell list has focus below. Cursor only renders when state is
// 'menu' (interactive); during buy/sell/confirm the items list owns
// the cursor.
function _drawRootMenu(ctx, fadeStep) {
  const pal = _makeFadedPal(fadeStep);
  for (let i = 0; i < ROOT_LABELS.length; i++) {
    drawText(ctx, MENU_X + 16, MENU_Y + i * MENU_STEP, _nameToBytes(ROOT_LABELS[i]), pal);
  }
  if (shopSt.state === 'menu') {
    drawCursorFaded(MENU_X, MENU_Y + shopSt.rootCursor * MENU_STEP - 4, fadeStep);
  }
}

// Buy / sell item list — full panel width below the keeper. Scrolls
// when the list overflows `LIST_VISIBLE_ROWS` rows; blink arrows pinned
// to the right edge mirror the battle spell list's affordance.
function _drawList(ctx, list, isSell) {
  const fadeStep = _innerTextFadeStep();
  const pal = _makeFadedPal(fadeStep);

  const nameX  = HUD_VIEW_X + 24;
  const priceX = HUD_VIEW_X + HUD_VIEW_W - 16;

  if (list.length === 0) {
    drawText(ctx, nameX, LIST_Y0, _nameToBytes(isSell ? 'Nothing to sell' : '---'), pal);
    return;
  }

  // Clamp scroll so the visible window always shows real rows.
  const maxScroll = Math.max(0, list.length - LIST_VISIBLE_ROWS);
  if (shopSt.scroll > maxScroll) shopSt.scroll = maxScroll;
  const start = shopSt.scroll;

  const isSpell = _isSpellShop();
  for (let r = 0; r < LIST_VISIBLE_ROWS && start + r < list.length; r++) {
    const i = start + r;
    const y = LIST_Y0 + r * ROW_H;
    if (isSpell) {
      const id = list[i];
      if (!SPELLS.get(id)) continue;
      const price = getSpellBuyPrice(id);
      const name  = getSpellNameShrines(id);
      const pNum  = _nameToBytes(String(price));
      drawText(ctx, nameX, y, name, pal);
      drawText(ctx, priceX - measureText(pNum), y, pNum, pal);
      continue;
    }
    const id    = isSell ? list[i].id    : list[i];
    const price = isSell ? list[i].price : (ITEMS.get(id) && ITEMS.get(id).price) || 0;
    if (!ITEMS.get(id)) continue;
    const name  = getItemNameShrines(id);
    const pNum  = _nameToBytes(String(price));
    drawText(ctx, nameX, y, name, pal);
    drawText(ctx, priceX - measureText(pNum), y, pNum, pal);
  }

  // Scroll arrows — same primitives the battle spell list uses.
  const arrowX = HUD_VIEW_X + HUD_VIEW_W - 12;
  const blink = (Math.floor(Date.now() / 250) & 1) === 0;
  if (start > 0 && ui.scrollArrowUp && blink) {
    ctx.drawImage(ui.scrollArrowUp, arrowX, LIST_Y0 - 4);
  }
  if (start + LIST_VISIBLE_ROWS < list.length && ui.scrollArrowDown && blink) {
    ctx.drawImage(ui.scrollArrowDown, arrowX, LIST_Y0 + LIST_VISIBLE_ROWS * ROW_H - 4);
  }

  if (shopSt.state === 'buy' || shopSt.state === 'sell') {
    const visRow = shopSt.cursor - start;
    drawCursorFaded(HUD_VIEW_X + 8, LIST_Y0 + visRow * ROW_H - 4, 0);
  }
}

// Right-column quantity selector (v1.7.260). Replaces the old blue
// confirm box for item shops. Up/Down ±1, Right/Left ±10, capped at
// `shopSt.qtyMax` and 1. Z commits, X cancels (input wired in
// `_listInput`). Spells skip this path and keep the blue confirm.
//
// Layout in the right column (x = MENU_X..panel right edge, ~56 px):
//   y=22  "Buy" / "Sell"           (header)
//   y=38  "qty"  label / value     (label left, qty right-aligned)
//   y=54  "gil"  label / value     (label left, qty*price right-aligned)
//   y=70  cursor (decorative — input is via arrow keys, not a vertical cursor)
function _drawQuantity(ctx, fadeStep, target, isSell) {
  if (!target) return;
  const pal = _makeFadedPal(fadeStep);
  const labelX = MENU_X;
  const valRx  = HUD_VIEW_X + HUD_VIEW_W - 16;

  const header = _nameToBytes(isSell ? 'Sell' : 'Buy');
  drawText(ctx, labelX, HUD_VIEW_Y + 22, header, pal);

  const qtyLbl = _nameToBytes('qty');
  drawText(ctx, labelX, HUD_VIEW_Y + 38, qtyLbl, pal);
  const qtyStr = String(shopSt.qty).padStart(2, '0');
  const qtyVal = _nameToBytes(qtyStr);
  drawText(ctx, valRx - measureText(qtyVal), HUD_VIEW_Y + 38, qtyVal, pal);

  // Cost = qty × price. For sell, the entry holds the per-unit price.
  const unit = isSell
    ? target.price
    : ((ITEMS.get(target) && ITEMS.get(target).price) || 0);
  const cost = unit * shopSt.qty;
  const costLbl = _nameToBytes('gil');
  drawText(ctx, labelX, HUD_VIEW_Y + 54, costLbl, pal);
  const costVal = _nameToBytes(String(cost));
  drawText(ctx, valRx - measureText(costVal), HUD_VIEW_Y + 54, costVal, pal);
}

// Text palette tuned for the blue confirm box: color 1/2 (font shadow) map
// to NES $02 (the same blue as the box bg), so the shadow is invisible and
// the white glyph reads cleanly. Color 0 stays transparent.
const CONFIRM_TEXT_PAL = [0x02, 0x02, 0x02, 0x30];

function _drawConfirm(target, isSell) {
  if (!target) return;
  const isSpell = _isSpellShop();
  const itemId = isSell ? target.id : target;
  if (isSpell) {
    if (!SPELLS.get(itemId)) return;
  } else if (!ITEMS.get(itemId)) {
    return;
  }
  const ctx = ui.ctx;
  const boxW = HUD_VIEW_W;
  const boxH = 40;
  const boxY = HUD_VIEW_Y + HUD_VIEW_H - boxH;
  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, boxY, boxW, boxH, true);

  const verb = isSell ? 'Sell ' : (isSpell ? 'Learn ' : 'Buy ');
  const prefix = _nameToBytes(verb);
  const name   = isSpell ? getSpellNameClean(itemId) : getItemNameClean(itemId);
  const line1  = new Uint8Array(prefix.length + name.length + 1);
  line1.set(prefix, 0);
  line1.set(name, prefix.length);
  line1[prefix.length + name.length] = 0xC5; // ?
  drawText(ctx, HUD_VIEW_X + 12, boxY + 10, line1, CONFIRM_TEXT_PAL);

  // Mobile shows on-screen A/B buttons; desktop uses Z/X keys.
  const hint = _nameToBytes(isMobile ? 'A=Yes  B=No' : 'Z=Yes  X=No');
  drawText(ctx, HUD_VIEW_X + boxW - 12 - measureText(hint), boxY + 24, hint, CONFIRM_TEXT_PAL);
  ctx.restore();
}
