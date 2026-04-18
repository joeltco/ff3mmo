// Player inventory state — { itemId: count } map of held items.

export const INV_SLOTS = 3; // visible inventory rows per page

export const playerInventory = {};

export function addItem(id, count) {
  playerInventory[id] = (playerInventory[id] || 0) + count;
}

export function removeItem(id) {
  if (playerInventory[id] > 0) playerInventory[id]--;
  if (playerInventory[id] <= 0) delete playerInventory[id];
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
