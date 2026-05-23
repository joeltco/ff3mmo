// Player inventory state — { itemId: count } map of held items.
//
// This is the single source for inventory mutation. Multiplayer-prep
// (v1.7.219): all reads and writes route through the helpers below so
// the future websocket layer has one place to hook delta emission.

export const INV_CAP = 8;   // max distinct item slots (v1.7.599)
export const INV_SLOTS = 8; // visible rows in pick panels — matches cap

export const playerInventory = {};
// Slot order — array of itemIds (numeric, NOT strings) at each visible
// position in the bag. The Object.entries() order can't express user-
// driven rearrangement (JS sorts integer-like keys ascending), so swap +
// move-to-empty go through this array. addItem appends a new id; removeItem
// drops it when depleted. v1.7.600.
export const playerInventoryOrder = [];

// True if there's room for `id` — either it's already in the bag (stack
// grows freely) or we're under the slot cap. Callers that need to abort
// (shop refund, trade decline) check this BEFORE issuing addItem.
export function canAddItem(id) {
  if (id in playerInventory) return true;
  return Object.keys(playerInventory).length < INV_CAP;
}

// Add `count` of item `id` to the inventory. Validates count: non-finite,
// non-positive, or non-numeric inputs are no-ops. Enforces the slot cap
// — new IDs are rejected when the bag is full unless `opts.bypass` is
// set (used by equip-swap flows so gear is never destroyed). Returns the
// actual amount added (0 if rejected). v1.7.599.
export function addItem(id, count, opts = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const intN = Math.floor(n);
  const isNew = !(id in playerInventory);
  if (!opts.bypass && isNew && playerInventoryOrder.length >= INV_CAP) {
    return 0;
  }
  playerInventory[id] = (playerInventory[id] || 0) + intN;
  if (isNew) playerInventoryOrder.push(Number(id));
  return intN;
}

// Remove up to `count` of item `id`. Clamps to current inventory count
// (no negatives). Deletes the entry when zeroed. Returns the actual
// amount removed. Pre-v1.7.219 this took no count arg and always
// removed exactly 1; the new signature is back-compat (default 1).
export function removeItem(id, count = 1) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const have = playerInventory[id] || 0;
  if (have <= 0) return 0;
  const removed = Math.min(Math.floor(n), have);
  playerInventory[id] = have - removed;
  if (playerInventory[id] <= 0) {
    delete playerInventory[id];
    const idx = playerInventoryOrder.indexOf(Number(id));
    if (idx >= 0) playerInventoryOrder.splice(idx, 1);
  }
  return removed;
}

// Read the current count of item `id`. Returns 0 (not undefined) when
// the item isn't held. Single seam for "how many do I have" lookups.
export function getItemCount(id) {
  return playerInventory[id] || 0;
}

// Convenience: does the player have at least one of this item?
export function hasItem(id) {
  return (playerInventory[id] || 0) > 0;
}

// Replace contents in place — keeps the const reference stable so importers
// don't need a getter shim. Used when loading a save slot. Optionally takes
// an `order` array; if missing or empty, order is rebuilt from the bag's
// keys (ID-ascending — matches pre-v1.7.600 display behavior).
export function setPlayerInventory(inv, order) {
  for (const k of Object.keys(playerInventory)) delete playerInventory[k];
  Object.assign(playerInventory, inv);
  playerInventoryOrder.length = 0;
  if (Array.isArray(order) && order.length > 0) {
    // Honor the persisted order, but drop any ids that don't exist or are
    // already in the list (defensive against stale/corrupted save data).
    const seen = new Set();
    for (const raw of order) {
      const id = Number(raw);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      if (!(id in playerInventory)) continue;
      playerInventoryOrder.push(id);
      seen.add(id);
    }
    // Backfill any inventory entries that weren't in the persisted order
    // (e.g. legacy saves missing the field).
    for (const k of Object.keys(playerInventory)) {
      const id = Number(k);
      if (!playerInventoryOrder.includes(id)) playerInventoryOrder.push(id);
    }
  } else {
    for (const k of Object.keys(playerInventory)) playerInventoryOrder.push(Number(k));
  }
}

// Position-ordered list of inventory entries. Empty slots come back as
// nulls up to INV_SLOTS so callers can render the bag as a fixed-size grid.
export function buildItemSelectList() {
  const list = [];
  for (const id of playerInventoryOrder) {
    const count = playerInventory[id] || 0;
    if (count > 0) list.push({ id, count });
  }
  while (list.length < INV_SLOTS) list.push(null);
  return list;
}

// Swap two slot positions. Either index may point at an empty slot (>=
// playerInventoryOrder.length but < INV_CAP) — that's treated as a move
// rather than a swap. Returns true on success. v1.7.600.
export function swapInventorySlots(srcIdx, dstIdx) {
  if (srcIdx === dstIdx) return false;
  if (srcIdx < 0 || dstIdx < 0 || srcIdx >= INV_CAP || dstIdx >= INV_CAP) return false;
  const len = playerInventoryOrder.length;
  if (srcIdx >= len) return false;   // can't drag from an empty slot
  if (dstIdx >= len) {
    // Move to an empty trailing slot — just rotate the id to the end.
    const id = playerInventoryOrder.splice(srcIdx, 1)[0];
    playerInventoryOrder.push(id);
    return true;
  }
  [playerInventoryOrder[srcIdx], playerInventoryOrder[dstIdx]] =
    [playerInventoryOrder[dstIdx], playerInventoryOrder[srcIdx]];
  return true;
}
