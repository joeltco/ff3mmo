// Economy server-validator. v1.7.776 P-8/P-9.
//
// Server-side validation for shop / chest / vase / inn transactions.
// Pattern mirrors pve-arbiter.js: validate against canonical data
// (server-side imports of src/data/* + read user mirror state),
// apply via existing mirror helpers (single writer), reject + push
// corrective state on mismatch.
//
// Wire shapes: docs/PVE-REWRITE-PLAN.md "Shops / Chests + vases / Inn".

import { SHOPS, getShopType } from './src/data/shops.js';
import { ITEMS } from './src/data/items.js';
import { mirrorReadFullState } from './api.js';
import { rollLootEntry, rollVaseLoot } from './src/data/loot-pools.js';
import { createRng } from './src/rng.js';

const INV_CAP = 16;       // mirrors src/inventory.js#INV_CAP

// FF3 NES sell ratio — matches src/shop.js#sellPrice. Items without a
// price aren't sellable (returns 0 → reject).
function _sellPrice(item) {
  return (item && item.price > 0) ? Math.floor(item.price / 2) : 0;
}

// Validate a shop-transaction frame from the client. Pure — returns the
// decision + the mirror events to apply on accept. Caller (ws-presence.js)
// runs mirrorApplyInvEvent.
//
// Returns:
//   { ok: true,  events: [...mirror event objects] }
//   { ok: false, reason: 'string' }
export function validateShopTransaction(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const { shopId, action, itemId, qty } = payload;
  const n = qty | 0;
  if (n <= 0 || n > 99) return { ok: false, reason: 'bad-qty' };

  const shop = SHOPS.get(String(shopId || ''));
  if (!shop) return { ok: false, reason: 'unknown-shop' };

  const item = ITEMS.get(itemId | 0);
  if (!item) return { ok: false, reason: 'unknown-item' };

  if (action === 'buy') {
    if (!shop.items.includes(itemId | 0)) {
      return { ok: false, reason: 'item-not-in-shop' };
    }
    const price = (item.price | 0) * n;
    if (price <= 0) return { ok: false, reason: 'item-has-no-price' };
    const mirror = mirrorReadFullState(userId, slot);
    if ((mirror.gil | 0) < price) {
      return { ok: false, reason: 'insufficient-gil have=' + (mirror.gil|0) + ' need=' + price };
    }
    // Inventory-room check: stacking item slot exists OR a free slot.
    const inv = mirror.inventory || {};
    const slotCount = Object.keys(inv).length;
    const itemAlreadyHave = ((inv[itemId | 0]) | 0) > 0;
    if (!itemAlreadyHave && slotCount >= INV_CAP) {
      return { ok: false, reason: 'inv-full' };
    }
    return {
      ok: true,
      events: [
        { kind: 'gil-delta', qty: -price, source: 'shop-' + getShopType(String(shopId)) },
        { kind: 'add',       itemId: itemId | 0, qty: n, source: 'shop-' + getShopType(String(shopId)) },
      ],
      meta: { price },
    };
  }

  if (action === 'sell') {
    const unit = _sellPrice(item);
    if (unit <= 0) return { ok: false, reason: 'item-not-sellable' };
    const mirror = mirrorReadFullState(userId, slot);
    const have = ((mirror.inventory || {})[itemId | 0]) | 0;
    if (have < n) return { ok: false, reason: 'insufficient-qty have=' + have + ' need=' + n };
    const gross = unit * n;
    return {
      ok: true,
      events: [
        { kind: 'remove',    itemId: itemId | 0, qty: n, source: 'shop-' + getShopType(String(shopId)) },
        { kind: 'gil-delta', qty: gross, source: 'shop-' + getShopType(String(shopId)) },
      ],
      meta: { gross, unit },
    };
  }

  return { ok: false, reason: 'bad-action' };
}

// Roll a fresh chest at (mapId, x, y) and return the events to apply.
// v1.7.777 P-10. Server is the sole roller — cheater can't fabricate the
// drop. consumedTiles tracking stays client-side for v1 (re-opening an
// already-opened chest would re-roll loot, but the client's tile-mutation
// to OPENED_CHEST prevents this in the normal flow; a malicious client
// could re-send chest-open, P-10b adds server-side consumed tracking).
//
// Returns:
//   { ok: true, events: [...], rolled: { type: 'item'|'gil'|'monster', value } }
//   { ok: false, reason: 'string' }
export function validateChestOpen(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const mapId = payload.mapId | 0;
  // Per-open seed = client-suggested seed XOR coords XOR map. Server adds
  // its own entropy bit so a replay attacker can't predict the exact roll
  // by re-sending the same coords; same-coord re-open will get a different
  // server-seed but the consumed-tile check (client-side for now) blocks
  // legitimate re-opens. v1 acceptable.
  const seed = ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1;
  const rng = createRng(seed).rand;
  const entry = rollLootEntry(mapId, rng);
  if (entry && entry.monster) {
    return { ok: true, events: [], rolled: { type: 'monster' } };
  }
  if (entry && typeof entry === 'object' && 'gil' in entry) {
    const amount = entry.gil | 0;
    if (amount <= 0) return { ok: false, reason: 'bad-roll' };
    return {
      ok: true,
      events: [{ kind: 'gil-delta', qty: amount, source: 'chest' }],
      rolled: { type: 'gil', amount },
    };
  }
  if (typeof entry === 'number') {
    const mirror = mirrorReadFullState(userId, slot);
    const inv = mirror.inventory || {};
    const have = (inv[entry] | 0) > 0;
    if (!have && Object.keys(inv).length >= 16) {
      return { ok: false, reason: 'inv-full' };
    }
    return {
      ok: true,
      events: [{ kind: 'add', itemId: entry, qty: 1, source: 'chest' }],
      rolled: { type: 'item', itemId: entry },
    };
  }
  return { ok: false, reason: 'empty-roll' };
}

// Hidden-treasure (vase) search. 25% hit chance — same as client's
// HIDDEN_TREASURE_HIT_CHANCE in src/map-triggers.js. Server rolls.
const VASE_HIT_CHANCE = 0.25;
export function validateVaseSearch(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const mapId = payload.mapId | 0;
  const seed = ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1;
  const rng = createRng(seed).rand;
  if (rng() >= VASE_HIT_CHANCE) {
    return { ok: true, events: [], rolled: { type: 'miss' } };
  }
  const entry = rollVaseLoot(mapId, rng);
  if (!entry) return { ok: true, events: [], rolled: { type: 'miss' } };
  if (entry && typeof entry === 'object' && 'gil' in entry) {
    const amount = entry.gil | 0;
    if (amount <= 0) return { ok: true, events: [], rolled: { type: 'miss' } };
    return {
      ok: true,
      events: [{ kind: 'gil-delta', qty: amount, source: 'vase' }],
      rolled: { type: 'gil', amount },
    };
  }
  if (typeof entry === 'number') {
    const mirror = mirrorReadFullState(userId, slot);
    const inv = mirror.inventory || {};
    const have = (inv[entry] | 0) > 0;
    if (!have && Object.keys(inv).length >= 16) {
      return { ok: false, reason: 'inv-full' };
    }
    return {
      ok: true,
      events: [{ kind: 'add', itemId: entry, qty: 1, source: 'vase' }],
      rolled: { type: 'item', itemId: entry },
    };
  }
  return { ok: true, events: [], rolled: { type: 'miss' } };
}

// Inn: deduct gil, restore HP/MP. v1.7.777 P-11. Inn registry currently
// has just one entry; expandable via the table below. Server validates
// gil; HP/MP restore tracking stays client-side (save column).
const INN_REGISTRY = new Map([
  // mapId|counterX|counterY → price
  // Ur inn placeholder — adjust when actual inn lands. For now, no inns
  // are validated server-side.
]);
function _innKey(mapId, x, y) { return mapId + '|' + x + '|' + y; }

export function validateInnRest(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const mapId = payload.mapId | 0;
  const x = payload.counterX | 0;
  const y = payload.counterY | 0;
  const price = INN_REGISTRY.get(_innKey(mapId, x, y));
  if (price == null) return { ok: false, reason: 'unknown-inn' };
  const mirror = mirrorReadFullState(userId, slot);
  if ((mirror.gil | 0) < price) {
    return { ok: false, reason: 'insufficient-gil have=' + (mirror.gil|0) + ' need=' + price };
  }
  return {
    ok: true,
    events: [{ kind: 'gil-delta', qty: -price, source: 'inn' }],
    meta: { price },
  };
}
