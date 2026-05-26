// trade.js — roster "Trade" → give-only offer flow.
//
// Lifecycle mirror of party-invite.js. Picking Trade on a roster target
// opens an inline item-pick panel; selecting an item builds a persistent
// "Offering [item] to X..." message box and sends a `trade-offer` to the
// server. The server relays to the target as `trade-offer-incoming`; the
// target's client prompts (Z/X) and emits `trade-response`; server relays
// back as `trade-result` to the offerer. On accept: sender removes, target
// adds. The "value-weighted accept chance" of the old sim path is gone —
// real players choose for themselves.
//
// Trust model: server doesn't track inventory. A malicious sender can
// claim an item they don't have and dup it on the recipient. Same gap as
// give-item; documented limitation for open beta. Fix later with a
// server-side inventory mirror if abuse surfaces. v1.7.598.

import { ITEMS } from './data/items.js';
import { playerInventory, removeItem, addItem, buildItemSelectList, canAddItem } from './inventory.js';
import { ps } from './player-stats.js';
import { battleSt } from './battle-state.js';
import { _nameToBytes, _nesNameToString } from './text-utils.js';
import { showMsgBox, showMsgBoxPrompt, yesNoLabels, replaceMsgBoxText, dismissMsgBox, msgState } from './message-box.js';
import { playSFX, SFX } from './music.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { getItemNameClean, getItemNameShrines } from './text-decoder.js';
import { drawBorderedBox, drawCursorFaded, clipToViewport } from './hud-drawing.js';
import { ui } from './ui-state.js';
import {
  sendNetTradeOffer, sendNetTradeResponse, sendNetTradeCancel,
  setNetTradeOfferHandler, setNetTradeResultHandler, setNetTradeCancelledHandler,
  sendNetInvEvent,    // v1.7.742 Phase 1c
} from './net.js';

// HUD viewport (duplicated where needed — canonical source in pvp-math.js)
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

const OFFER_TIMEOUT_MS  = 5 * 60 * 1000;
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
  acceptedHoldMs:  0,
  cooldowns:       new Map(),
  // Receiver-side state — set when a `trade-offer-incoming` is currently
  // prompting the player. Cleared on accept/decline/cancel. Tracks just
  // the sender's userId so an incoming `trade-cancelled` can dismiss the
  // prompt only if it matches.
  recvFromUserId:  null,
};

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
  if (targetName) {
    tradeSt.cooldowns.set(targetName, _now() + COOLDOWN_MS);
  }
}

export function cancelTrade(reason = 'user') {
  if (tradeSt.state === 'closed') return;
  const targetName = tradeSt.target && tradeSt.target.name;
  const wasOffering = tradeSt.state === 'offering' || tradeSt.state === 'resolving';
  _endTrade(targetName);
  // Notify the server so the target's prompt dismisses and its pending
  // entry clears. Skip when we ALREADY got a server result back (declined /
  // offline) — server state is already gone in those cases. Server is fine
  // with a no-op cancel if there's no pending offer (race) — drops silently.
  if (reason === 'user' || reason === 'timeout' || reason === 'death') sendNetTradeCancel();
  if (reason === 'user') {
    if (wasOffering) showMsgBox(_nameToBytes('Cancelled'));
    playSFX(SFX.CONFIRM);
  } else if (reason === 'timeout') {
    showMsgBox(_nameToBytes('No reply'));
  } else if (reason === 'declined') {
    showMsgBox(_nameToBytes('Declined'));
  } else if (reason === 'offline') {
    showMsgBox(_nameToBytes('Offline'));
  } else if (reason === 'blocked') {
    showMsgBox(_nameToBytes('Cannot trade'));
  } else if (reason === 'death') {
    // Silent — game-over flow owns the screen.
  }
}

// Commit the selected item, transition to the 'offering' phase, and send
// the offer over the wire. The target's client prompts; resolution comes
// back asynchronously via `trade-result`. Caller (input-handler) drives
// this from the item-pick Z press.
export function commitOffer(itemId) {
  if (tradeSt.state !== 'item-pick') return false;
  if (!playerInventory[itemId]) return false;
  const target = tradeSt.target;
  if (!target || !target.userId) return false;   // no real-player target → bail
  tradeSt.itemId          = itemId;
  tradeSt.state           = 'offering';
  tradeSt.startedAtMs     = _now();
  const itemName = getItemNameClean(itemId);
  const offerBytes = _nameToBytes('Offering ');
  const toBytes    = _nameToBytes(' to ' + target.name + '...');
  const msg = new Uint8Array(offerBytes.length + itemName.length + toBytes.length);
  msg.set(offerBytes, 0);
  msg.set(itemName, offerBytes.length);
  msg.set(toBytes, offerBytes.length + itemName.length);
  showMsgBox(msg);
  sendNetTradeOffer(target.userId, itemId);
  return true;
}

function _resolveAsAccept() {
  const target = tradeSt.target;
  const itemId = tradeSt.itemId;
  tradeSt.state = 'resolving';
  tradeSt.acceptedHoldMs = ACCEPTED_HOLD_MS;
  replaceMsgBoxText(_nameToBytes('Accepted'), () => {
    // Sender side of the inventory mutation. Receiver's client adds the
    // item via `applyTradeOfferIncoming`'s accept closure (addItem there).
    removeItem(itemId, 1);
    sendNetInvEvent('remove', itemId, 1, 'trade');   // v1.7.742 Phase 1c
    _endTrade(target ? target.name : null);
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
  // Offering phase just waits for `trade-result` from the server — no
  // local accept-roll. Receiver's prompt has the same 5-min ceiling on
  // their side; if they walk away the offer eventually times out here.
}

// ── Net handlers ────────────────────────────────────────────────────────

// Incoming offer FROM another player. Prompt the user with Z/X. Auto-decline
// if they're already in a battle / another message box / already trading,
// mirroring the party-invite "busy" guard.
setNetTradeOfferHandler((msg) => {
  if (!msg || !msg.fromUserId || !msg.itemId) return;
  if (battleSt.battleState !== 'none' || msgState.state !== 'none' || tradeSt.state !== 'closed') {
    sendNetTradeResponse(msg.fromUserId, false);
    return;
  }
  const fromUserId = msg.fromUserId | 0;
  const itemId = msg.itemId | 0;
  // Bag-full guard (v1.7.599) — auto-decline before prompting; receiver
  // can't accept what they couldn't hold anyway.
  if (!canAddItem(itemId)) {
    sendNetTradeResponse(fromUserId, false);
    return;
  }
  const fromName = String(msg.fromName || '');
  const itemName = _nesNameToString(getItemNameClean(itemId));
  tradeSt.recvFromUserId = fromUserId;
  showMsgBoxPrompt(
    _nameToBytes(fromName + ' offers ' + itemName + ' ' + yesNoLabels()),
    () => {
      tradeSt.recvFromUserId = null;
      addItem(itemId, 1);
      sendNetInvEvent('add', itemId, 1, 'trade');   // v1.7.742 Phase 1c
      sendNetTradeResponse(fromUserId, true);
      playSFX(SFX.CONFIRM);
    },
    () => {
      tradeSt.recvFromUserId = null;
      sendNetTradeResponse(fromUserId, false);
    },
  );
});

// Our outgoing offer was resolved. Accept → run the accept hold; otherwise
// surface a brief reason message and end the trade.
setNetTradeResultHandler((msg) => {
  if (!msg) return;
  if (tradeSt.state !== 'offering') return;   // stale or already resolved
  if (msg.accept) {
    _resolveAsAccept();
  } else if (msg.reason === 'offline') {
    cancelTrade('offline');
  } else if (msg.reason === 'blocked') {
    // Server type-whitelist rejection (key item, or unknown id). Sender
    // didn't have a chance to consume yet (offer never reached the
    // target), so just bail with a hint.
    cancelTrade('blocked');
  } else {
    cancelTrade('declined');
  }
});

// Offerer cancelled (or disconnected) before we responded. Dismiss our
// prompt only if it's currently for this offerer.
setNetTradeCancelledHandler((msg) => {
  if (!msg || !msg.fromUserId) return;
  if (tradeSt.recvFromUserId !== (msg.fromUserId | 0)) return;
  tradeSt.recvFromUserId = null;
  dismissMsgBox();
});

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
    drawText(ctx, nameX, y, getItemNameShrines(entry.id), TEXT_WHITE);
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
