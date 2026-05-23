// Player inventory state — { itemId: count } map of held items.
//
// This is the single source for inventory mutation. Multiplayer-prep
// (v1.7.219): all reads and writes route through the helpers below so
// the future websocket layer has one place to hook delta emission.

export const INV_CAP = 8;   // max distinct item slots (v1.7.599)
export const INV_SLOTS = 8; // visible rows in pick panels — matches cap

export const playerInventory = {};

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
  if (!opts.bypass && !(id in playerInventory) &&
      Object.keys(playerInventory).length >= INV_CAP) {
    return 0;
  }
  playerInventory[id] = (playerInventory[id] || 0) + intN;
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
  if (playerInventory[id] <= 0) delete playerInventory[id];
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
// don't need a getter shim. Used when loading a save slot.
export function setPlayerInventory(inv) {
  for (const k of Object.keys(playerInventory)) delete playerInventory[k];
  Object.assign(playerInventory, inv);
}

export function buildItemSelectList() {
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const list = entries.map(([id, count]) => ({ id: Number(id), count }));
  while (list.length < INV_SLOTS) list.push(null);
  return list;
}
