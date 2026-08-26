// Story-flag runtime — reading and setting world facts.
//
// The table is `data/flags.js` (import-free, shared with the server); this is
// the only place `ps.flags` is touched. NPC `when:` predicates and quest stages
// both go through here, so how a flag is stored stays one module's business —
// the same reason `npc.js#_questDone` exists for quest state.
//
// ⛔ SETTING A FLAG PERSISTS IMMEDIATELY. A flag is what a town's appearance is
// keyed to, so an unsaved one means the player walks back into Kazus after a
// reload and finds the curse still on. `quests.js` learned the same lesson the
// expensive way (v1.8.6): an unsaved `s: 'done'` was a repeatable payout.

import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { isFlag } from './data/flags.js';

function _bag() {
  if (!ps.flags || typeof ps.flags !== 'object' || Array.isArray(ps.flags)) ps.flags = {};
  return ps.flags;
}

/** Is this world fact true for the current save? */
export function hasFlag(id) {
  return !!_bag()[id];
}

/**
 * Make a world fact true. Returns false for an undeclared flag — a typo in a
 * quest stage must not quietly create a fact nothing can ever read.
 *
 * Idempotent: setting a flag that is already set is a no-op and does NOT
 * re-save, so a stage that is re-entered costs nothing.
 */
export function setFlag(id) {
  if (!isFlag(id)) {
    console.warn('[flags] refusing to set undeclared flag ' + id);
    return false;
  }
  const bag = _bag();
  if (bag[id]) return true;
  bag[id] = 1;
  try { saveSlotsToDB(); } catch (_) { /* pre-boot / headless harness */ }
  return true;
}

/**
 * Clear a world fact. Exists for the quest hand-in REVERT path: a stage that
 * set a flag and then had its server claim refused must not leave the world
 * changed while the quest goes back to waiting.
 */
export function clearFlag(id) {
  const bag = _bag();
  if (!bag[id]) return false;
  delete bag[id];
  try { saveSlotsToDB(); } catch (_) { /* pre-boot / headless harness */ }
  return true;
}

/** Every flag currently true, for debug panels and gates. */
export function activeFlags() {
  return Object.keys(_bag()).filter((k) => _bag()[k]);
}
