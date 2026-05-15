// deltas.js — single interception seam for combat-state mutations.
//
// Every HP / status / death write that needs to stay in sync between clients
// in multiplayer goes through `dispatchDelta(d)`. In single-player mode
// (today) this is a passthrough that mutates local state directly. When the
// websocket layer lands, the cutover is:
//
//   1. Client emits action intent over the wire.
//   2. Server validates + computes the canonical delta.
//   3. Server broadcasts the delta to every client.
//   4. Each client calls `dispatchDelta(remoteDelta)` on echo, which routes
//      to the SAME apply path as the local-only case.
//
// `setDeltaApplier(fn)` lets the wire layer override the default applier
// (e.g., to buffer for rollback netcode, or to log every delta to the
// server). The default is `applyLocal` which mutates directly.
//
// Delta shapes:
//   { type: 'hp',          target, amount, source? }   — signed HP change.
//                                                          amount < 0 = damage,
//                                                          amount > 0 = heal.
//                                                          Clamps to [0, maxHP]
//                                                          when max is available.
//   { type: 'statusAdd',   target, flag, source? }     — apply status flag.
//   { type: 'statusRemove',target, flag, source? }     — clear status flag.
//   { type: 'death',       target, source? }           — force HP to 0 +
//                                                          set DEATH status.
//
// `target` is the combatant object (live reference). When the wire layer
// arrives, callers will pass a ref `{faction, idx}` and `dispatchDelta`
// will resolve to a combatant — that's a follow-up; for now the object-
// reference shape keeps the migration mechanical (no ref-resolver writing
// needed in step 6).
//
// `source` is optional, used by the wire layer to reconstruct intent on
// remote clients ("X cast Fire on Y" rather than just "Y took 45 damage").
// Single-player ignores it.

import { addStatus, removeStatus, STATUS } from './status-effects.js';

let _applier = applyLocal;

export function dispatchDelta(d) {
  _applier(d);
}

// Wire layer calls this once at connect time, passing its own intercepted
// applier. Falls back to local mode if called with null/undefined.
export function setDeltaApplier(fn) {
  _applier = typeof fn === 'function' ? fn : applyLocal;
}

export function resetDeltaApplier() {
  _applier = applyLocal;
}

function _maxHP(target) {
  return target.maxHP
    || (target.stats && target.stats.maxHP)
    || target.hp
    || 0;
}

export function applyLocal(d) {
  if (!d || !d.target) return;
  switch (d.type) {
    case 'hp': {
      const cur = d.target.hp || 0;
      const max = _maxHP(d.target);
      const next = Math.max(0, Math.min(max || Infinity, cur + d.amount));
      d.target.hp = next;
      return;
    }
    case 'statusAdd':
      if (d.target.status) addStatus(d.target.status, d.flag);
      return;
    case 'statusRemove':
      if (d.target.status) removeStatus(d.target.status, d.flag);
      return;
    case 'death':
      if (d.target.status) addStatus(d.target.status, STATUS.DEATH);
      d.target.hp = 0;
      return;
  }
}
