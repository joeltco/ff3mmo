// trade.js — roster "Trade" → give-only offer flow (v1.7.237).
//
// Lifecycle mirror of party-invite.js + pvp-search.js. Picking Trade
// on a roster target opens an inline item-pick panel; selecting an item
// starts a persistent "Offering [item] to X..." invitation. The target
// rolls an accept chance every 4-10 s on a per-target sim timer. On
// accept, the item leaves the player's inventory (in single-player it
// just disappears — the fake-player side has no inventory yet); on
// timeout / cap / cancel the item stays.
//
// Today the target's accept roll is *simulated* on a per-target timer.
// When real networked players land, swap the sim timer for the
// websocket-relayed "trade_response" signal — the rest of the flow is
// the same. Same cutover seam as the PVP search and party invite.
//
// Accept formula: item-value-weighted, clamped. AGI / level differential
// doesn't apply — the bid IS the item. See getAcceptChance for the
// constants.

import { ITEMS } from './data/items.js';
import { playerInventory, removeItem, buildItemSelectList } from './inventory.js';
import { ps } from './player-stats.js';
import { battleSt } from './battle-state.js';
import { _nameToBytes } from './text-utils.js';
import { showMsgBox, replaceMsgBoxText, dismissMsgBox } from './message-box.js';
import { playSFX, SFX } from './music.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { getItemNameClean } from './text-decoder.js';
import { drawBorderedBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { ui } from './ui-state.js';

// HUD viewport (duplicated where needed — canonical source in pvp-math.js)
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

const BASE_ACCEPT  = 0.25;
const PRICE_DIVISOR = 1500;  // 1500-gil item adds +1.0 → clamps to MAX
const ACCEPT_MIN   = 0.10;
const ACCEPT_MAX   = 0.90;

const OFFER_TIMEOUT_MS  = 5 * 60 * 1000;
const MAX_MISSED_ROLLS  = 3;
const TARGET_ROLL_MIN_MS = 4000;
const TARGET_ROLL_MAX_MS = 10000;
const COOLDOWN_MS       = 60 * 1000;
const ACCEPTED_HOLD_MS  = 1000;

const ROW_H = 14;
const VISIBLE_ROWS = 5;

export const tradeSt = {
  state:           'closed',   // 'closed' | 'item-pick' | 'offering' | 'resolving'
  target:          null,
  itemId:          -1,
  cursor:          0,
  scroll:          0,
  startedAtMs:     0,
  missedRolls:     0,
  targetRollTimer: 0,
  acceptedHoldMs:  0,
  cooldowns:       new Map(),
};

function _rollTimerMs() {
  return TARGET_ROLL_MIN_MS + Math.random() * (TARGET_ROLL_MAX_MS - TARGET_ROLL_MIN_MS);
}

function _now() { return performance.now(); }

function _inventoryList() {
  return buildItemSelectList().filter(e => e);  // drop null padding slots
}

export function isTradeOnCooldown(targetName) {
  const exp = tradeSt.cooldowns.get(targetName);
  return !!exp && exp > _now();
}

export function isTradingWith(target) {
  return tradeSt.state !== 'closed' && !!target && tradeSt.target === target;
}

export function isTradeActive() {
  return tradeSt.state === 'offering' || tradeSt.state === 'resolving';
}

export function isTradeOffering() {
  return tradeSt.state === 'offering';
}

export function isTradeResolving() {
  return tradeSt.state === 'resolving';
}

export function isTradePicking() {
  return tradeSt.state === 'item-pick';
}

export function getActiveTradeTargetName() {
  return tradeSt.target ? tradeSt.target.name : null;
}

// Accept chance formula: item value adds to base; clamped.
export function getAcceptChance(itemId) {
  const item = ITEMS.get(itemId);
  const price = (item && item.price) ? item.price : 0;
  const raw = BASE_ACCEPT + price / PRICE_DIVISOR;
  return Math.max(ACCEPT_MIN, Math.min(ACCEPT_MAX, raw));
}

// Open the item-pick panel for a target. Returns false if the user
// can't trade right now (already trading, target on cooldown, empty
// inventory).
export function openTradePick(target) {
  if (tradeSt.state !== 'closed') return 'busy';
  if (!target) return 'no-target';
  if (isTradeOnCooldown(target.name)) return 'cooldown';
  if (_inventoryList().length === 0) return 'empty';
  tradeSt.state = 'item-pick';
  tradeSt.target = target;
  tradeSt.itemId = -1;
  tradeSt.cursor = 0;
  tradeSt.scroll = 0;
  return 'ok';
}

function _endTrade(targetName) {
  tradeSt.state = 'closed';
  tradeSt.target = null;
  tradeSt.itemId = -1;
  tradeSt.cursor = 0;
  tradeSt.scroll = 0;
  tradeSt.missedRolls = 0;
  tradeSt.targetRollTimer = 0;
  if (targetName) {
    tradeSt.cooldowns.set(targetName, _now() + COOLDOWN_MS);
  }
}

export function cancelTrade(reason = 'user') {
  if (tradeSt.state === 'closed') return;
  const targetName = tradeSt.target && tradeSt.target.name;
  const wasOffering = tradeSt.state === 'offering' || tradeSt.state === 'resolving';
  _endTrade(targetName);
  if (reason === 'user') {
    if (wasOffering) showMsgBox(_nameToBytes('Cancelled'));
    playSFX(SFX.CONFIRM);
  } else if (reason === 'timeout' || reason === 'missed-cap') {
    showMsgBox(_nameToBytes('Declined'));
  } else if (reason === 'death') {
    // Silent — game-over flow owns the screen
  }
}

// Commit the selected item and transition into the offer/sim-timer
// phase. Caller (input-handler) drives this from the item-pick Z press.
export function commitOffer(itemId) {
  if (tradeSt.state !== 'item-pick') return false;
  if (!playerInventory[itemId]) return false;
  const target = tradeSt.target;
  if (!target) return false;
  tradeSt.itemId          = itemId;
  tradeSt.state           = 'offering';
  tradeSt.startedAtMs     = _now();
  tradeSt.missedRolls     = 0;
  tradeSt.targetRollTimer = _rollTimerMs();
  const itemName = getItemNameClean(itemId);
  const offerBytes = _nameToBytes('Offering ');
  const toBytes    = _nameToBytes(' to ' + target.name + '...');
  const msg = new Uint8Array(offerBytes.length + itemName.length + toBytes.length);
  msg.set(offerBytes, 0);
  msg.set(itemName, offerBytes.length);
  msg.set(toBytes, offerBytes.length + itemName.length);
  showMsgBox(msg);
  return true;
}

// Resolve gate — single-player adds-to-disappear is fine outside combat
// only. Mid-battle is jarring; counts as a missed roll.
function _canResolveOffer() {
  return battleSt.battleState === 'none';
}

function _runAcceptCheck() {
  if (!_canResolveOffer()) {
    tradeSt.missedRolls++;
    return;
  }
  const chance = getAcceptChance(tradeSt.itemId);
  if (Math.random() < chance) {
    _resolveAsAccept();
  } else {
    tradeSt.missedRolls++;
  }
}

function _resolveAsAccept() {
  const target = tradeSt.target;
  const itemId = tradeSt.itemId;
  tradeSt.state = 'resolving';
  tradeSt.acceptedHoldMs = ACCEPTED_HOLD_MS;
  replaceMsgBoxText(_nameToBytes('Accepted'), () => {
    // Item leaves inventory on accept. Single-player: just disappears —
    // fake players have no inventory. Multiplayer: server relays to the
    // target client which calls addItem on their side.
    removeItem(itemId, 1);
    _endTrade(target.name);
  });
}

export function tickTrade(dt) {
  if (tradeSt.state !== 'offering' && tradeSt.state !== 'resolving') return;
  if (tradeSt.state === 'resolving') {
    if (tradeSt.acceptedHoldMs > 0) {
      tradeSt.acceptedHoldMs -= dt;
      if (tradeSt.acceptedHoldMs <= 0) {
        tradeSt.acceptedHoldMs = 0;
        dismissMsgBox();
      }
    }
    return;
  }
  if (ps.hp <= 0) {
    cancelTrade('death');
    return;
  }
  if (_now() - tradeSt.startedAtMs > OFFER_TIMEOUT_MS) {
    cancelTrade('timeout');
    return;
  }
  if (tradeSt.missedRolls >= MAX_MISSED_ROLLS) {
    cancelTrade('missed-cap');
    return;
  }
  tradeSt.targetRollTimer -= dt;
  if (tradeSt.targetRollTimer <= 0) {
    _runAcceptCheck();
    tradeSt.targetRollTimer = _rollTimerMs();
  }
}

// ── Item-pick panel render + input ──────────────────────────────────────

export function drawTradePick() {
  if (tradeSt.state !== 'item-pick') return;
  const ctx = ui.ctx;
  const list = _inventoryList();
  const visible = Math.min(VISIBLE_ROWS, Math.max(1, list.length));
  const boxW = HUD_VIEW_W;
  const boxH = 16 + visible * ROW_H;
  const boxX = HUD_VIEW_X;
  const boxY = HUD_VIEW_Y;
  clipToViewport();
  drawBorderedBox(boxX, boxY, boxW, boxH, true);

  const listY0 = boxY + 10;
  const nameX  = boxX + 24;
  const countX = boxX + boxW - 16;

  if (list.length === 0) {
    drawText(ctx, nameX, listY0, _nameToBytes('Empty'), TEXT_WHITE);
    ctx.restore();
    return;
  }

  const start = tradeSt.scroll;
  for (let i = 0; i < visible; i++) {
    const idx = start + i;
    if (idx >= list.length) break;
    const entry = list[idx];
    const y = listY0 + i * ROW_H;
    drawText(ctx, nameX, y, getItemNameClean(entry.id), TEXT_WHITE);
    const cNum = _nameToBytes(String(entry.count));
    drawText(ctx, countX - measureText(cNum), y, cNum, TEXT_WHITE);
  }
  const cursorRow = tradeSt.cursor - tradeSt.scroll;
  drawCursorFaded(boxX + 8, listY0 + cursorRow * ROW_H - 4, 0);
  ctx.restore();
}

export function handleTradePickInput(keys) {
  if (tradeSt.state !== 'item-pick') return false;
  const list = _inventoryList();
  if (list.length === 0) {
    if (keys['x'] || keys['X'] || keys['z'] || keys['Z']) {
      keys['x'] = false; keys['X'] = false; keys['z'] = false; keys['Z'] = false;
      cancelTrade('user');
      playSFX(SFX.CONFIRM);
    }
    return true;
  }
  if (keys['ArrowDown']) {
    keys['ArrowDown'] = false;
    tradeSt.cursor = (tradeSt.cursor + 1) % list.length;
    if (tradeSt.cursor - tradeSt.scroll >= VISIBLE_ROWS) tradeSt.scroll = tradeSt.cursor - VISIBLE_ROWS + 1;
    else if (tradeSt.cursor < tradeSt.scroll) tradeSt.scroll = tradeSt.cursor;
    playSFX(SFX.CURSOR);
  }
  if (keys['ArrowUp']) {
    keys['ArrowUp'] = false;
    tradeSt.cursor = (tradeSt.cursor + list.length - 1) % list.length;
    if (tradeSt.cursor - tradeSt.scroll >= VISIBLE_ROWS) tradeSt.scroll = tradeSt.cursor - VISIBLE_ROWS + 1;
    else if (tradeSt.cursor < tradeSt.scroll) tradeSt.scroll = tradeSt.cursor;
    playSFX(SFX.CURSOR);
  }
  if (keys['z'] || keys['Z']) {
    keys['z'] = false; keys['Z'] = false;
    const picked = list[tradeSt.cursor];
    if (picked) {
      playSFX(SFX.CONFIRM);
      commitOffer(picked.id);
    }
  }
  if (keys['x'] || keys['X']) {
    keys['x'] = false; keys['X'] = false;
    cancelTrade('user');
  }
  return true;
}
