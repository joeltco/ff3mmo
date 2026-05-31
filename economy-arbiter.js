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
import { mirrorReadFullState, consumedTileConsumedAt } from './api.js';
import { LOOT_POOLS, DEFAULT_LOOT, UR_CHEST_MAPS } from './src/data/loot-pools.js';

const INV_CAP = 16;       // mirrors src/inventory.js#INV_CAP

// v1.7.787 replay-block cooldowns. Both share 24h today for a single
// bounded policy; chest can be promoted to permanent if dungeon-regen
// re-grind isn't worth preserving. Vase 24h matches the client v1.7.618
// design.
const CHEST_TTL_SEC = 24 * 3600;
const VASE_TTL_SEC  = 24 * 3600;
function _nowSec() { return Math.floor(Date.now() / 1000); }

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

// Validate a chest-open claim. v1.7.780 P-10b switched from server-roll
// to validate-only: client rolls locally (UX-clean — "Found X" message
// matches actual outcome) and submits the rolled item/gil. Server checks
// the claim is plausibly in the chest's loot pool, then applies via
// mirror. Cheater can claim any item *in the pool* but not items outside
// it. Re-opening the same chest is still possible (consumedTiles is
// client-side for v1); the cheat surface there is bounded by the pool
// contents.
//
// Payload: { mapId, x, y, claim: { type: 'item'|'gil'|'monster', itemId?, amount? } }
export function validateChestOpen(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const mapId = payload.mapId | 0;
  const x     = payload.x     | 0;
  const y     = payload.y     | 0;
  const claim = payload.claim || {};
  const pool = _resolvedChestPool(mapId);
  if (!pool) return { ok: false, reason: 'no-pool-for-map' };

  // v1.7.787 — server-side replay block. Pre-fix, `consumedTiles` was
  // client-side only and a scripted client could re-claim the same chest
  // indefinitely.
  const lastAt = consumedTileConsumedAt(userId, slot, mapId, x, y, 'chest');
  if (lastAt != null && (_nowSec() - lastAt) < CHEST_TTL_SEC) {
    return { ok: false, reason: 'already-opened' };
  }

  if (claim.type === 'item') {
    const itemId = claim.itemId | 0;
    if (!pool.items.has(itemId)) {
      return { ok: false, reason: 'item-not-in-pool item=0x' + itemId.toString(16) };
    }
    const mirror = mirrorReadFullState(userId, slot);
    const inv = mirror.inventory || {};
    const have = (inv[itemId] | 0) > 0;
    if (!have && Object.keys(inv).length >= INV_CAP) {
      return { ok: false, reason: 'inv-full' };
    }
    return { ok: true, mark: true, events: [{ kind: 'add', itemId, qty: 1, source: 'chest' }] };
  }

  if (claim.type === 'gil') {
    const amount = claim.amount | 0;
    if (amount <= 0) return { ok: false, reason: 'bad-gil' };
    if (amount > pool.gilMax) {
      return { ok: false, reason: 'gil-too-high claim=' + amount + ' max=' + pool.gilMax };
    }
    return { ok: true, mark: true, events: [{ kind: 'gil-delta', qty: amount, source: 'chest' }] };
  }

  if (claim.type === 'monster') {
    // Mimic — no events. Client starts the battle locally; PvE arbiter
    // takes over. Validate the pool actually has a mimic tier so a
    // cheater can't fake "no battle" on cave chests. Mark consumed so a
    // cheater can't re-trigger the mimic fight either.
    if (!pool.hasMonster) return { ok: false, reason: 'no-mimic-in-pool' };
    return { ok: true, mark: true, events: [] };
  }

  return { ok: false, reason: 'bad-claim-type' };
}

// Validate a vase-search claim. Same pattern as chest but mimics excluded
// (vase pool). v1.7.780 P-10b. Misses always pass with no events.
export function validateVaseSearch(userId, slot, payload) {
  if (!payload) return { ok: false, reason: 'no-payload' };
  const mapId = payload.mapId | 0;
  const x     = payload.x     | 0;
  const y     = payload.y     | 0;
  const claim = payload.claim || {};

  // Miss is silent + no cooldown (matches client v1.7.618 design — players
  // can keep searching until they hit). The replay block guards the HIT
  // path below; miss spam doesn't grant anything.
  if (claim.type === 'miss') return { ok: true, mark: false, events: [] };

  const pool = _resolvedVasePool(mapId);
  if (!pool) return { ok: false, reason: 'no-pool-for-map' };

  // v1.7.787 — server-side 24h cooldown. Matches the client design from
  // v1.7.618 but enforced authoritatively.
  const lastAt = consumedTileConsumedAt(userId, slot, mapId, x, y, 'vase');
  if (lastAt != null && (_nowSec() - lastAt) < VASE_TTL_SEC) {
    return { ok: false, reason: 'on-cooldown' };
  }

  if (claim.type === 'item') {
    const itemId = claim.itemId | 0;
    if (!pool.items.has(itemId)) {
      return { ok: false, reason: 'item-not-in-pool item=0x' + itemId.toString(16) };
    }
    const mirror = mirrorReadFullState(userId, slot);
    const inv = mirror.inventory || {};
    const have = (inv[itemId] | 0) > 0;
    if (!have && Object.keys(inv).length >= INV_CAP) {
      return { ok: false, reason: 'inv-full' };
    }
    return { ok: true, mark: true, events: [{ kind: 'add', itemId, qty: 1, source: 'vase' }] };
  }

  if (claim.type === 'gil') {
    const amount = claim.amount | 0;
    if (amount <= 0) return { ok: false, reason: 'bad-gil' };
    if (amount > pool.gilMax) {
      return { ok: false, reason: 'gil-too-high claim=' + amount + ' max=' + pool.gilMax };
    }
    return { ok: true, mark: true, events: [{ kind: 'gil-delta', qty: amount, source: 'vase' }] };
  }

  return { ok: false, reason: 'bad-claim-type' };
}

// Resolve the chest pool for a mapId: union of all tier items + max gil +
// whether a mimic tier is present. Mirrors src/map-triggers.js#rollLootEntry
// fallback chain (Ur interior → 114; unknown → DEFAULT_LOOT). Locked-room
// (mapId 1010) draws from any altar floor — union of all four.
function _resolvedChestPool(mapId) {
  let tiers;
  if (mapId === 1010) {
    tiers = [];
    for (const id of [1000, 1001, 1002, 1003]) {
      const t = LOOT_POOLS[id];
      if (t) tiers = tiers.concat(t);
    }
  } else {
    tiers = LOOT_POOLS[mapId];
    if (!tiers && UR_CHEST_MAPS.has(mapId)) tiers = LOOT_POOLS[114];
    if (!tiers) tiers = DEFAULT_LOOT;
  }
  if (!tiers || !tiers.length) return null;
  const items = new Set();
  let gilMax = 0;
  let hasMonster = false;
  for (const t of tiers) {
    if (t.monster) { hasMonster = true; continue; }
    for (const entry of t.pool) {
      if (typeof entry === 'number') items.add(entry);
      else if (entry && entry.gil) gilMax = Math.max(gilMax, entry.gil[1] | 0);
    }
  }
  return { items, gilMax, hasMonster };
}

function _resolvedVasePool(mapId) {
  let tiers = LOOT_POOLS[mapId];
  if (!tiers && UR_CHEST_MAPS.has(mapId)) tiers = LOOT_POOLS[114];
  if (!tiers) tiers = DEFAULT_LOOT;
  if (!tiers || !tiers.length) return null;
  const items = new Set();
  let gilMax = 0;
  for (const t of tiers) {
    if (t.monster) continue;
    for (const entry of t.pool) {
      if (typeof entry === 'number') items.add(entry);
      else if (entry && entry.gil) gilMax = Math.max(gilMax, entry.gil[1] | 0);
    }
  }
  return { items, gilMax };
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
