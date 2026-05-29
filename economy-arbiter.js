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
