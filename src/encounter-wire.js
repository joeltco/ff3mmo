// Co-op random encounter wire (v1.7.418+). Standalone module so
// `battle-update.js` and `battle-turn.js` can both reach the queue
// without circular imports.
//
// Mirror of the PvP `_wireOpponentActions` queue (`pvp.js`). Each entry
// is a peer's action keyed by `userId` (the actor who took it). When a
// wire-driven `battleAlly` whose `userId` matches the head-of-queue
// takes its turn, the ally-turn handler in
// `battle-turn.js#processNextTurn` splices the matching entry out and
// replays the action; absent the matching entry it stalls in the
// `ally-wire-wait` state until the wire delivers.

import { battleSt } from './battle-state.js';
import { sendNetEncounterAction, sendNetEncounterEnd,
         setNetEncounterActionHandler, setNetEncounterEndHandler } from './net.js';
import { isHealSpell } from './spell-cast.js';
import { COOP_HOST_ARB, isCoopGuest, resolveEncounterEnd } from './coop-resolver.js';

// Side-effect import — wires `encounter-resolution` + `encounter-snapshot`
// handlers at module load. Flag-gated internally by `COOP_HOST_ARB`, so
// flag-off (Phases 1-5) keeps the handlers installed but no-op'd.
import './coop-applier.js';

// Re-export the host-arb flag here for backward-compat — actual owner is
// `coop-resolver.js` so Node-side tooling can read it without dragging in
// browser-only modules through this file. See docs/COOP-REWRITE-PLAN.md.
export { COOP_HOST_ARB };

const _wireEncounterActions = [];

setNetEncounterActionHandler((msg) => {
  if (!msg) return;
  if (msg.kind === 'disconnect') {
    if (msg.userId) {
      const droppedUid = msg.userId | 0;
      // Legacy fallback: clear isWireDriven on the dropped peer's ally entry
      // so the ally-turn handler falls back to local AI (defend). Battle
      // proceeds single-player-style for the rest of the round.
      for (const a of battleSt.battleAllies) {
        if (a && a.userId === droppedUid) { a.isWireDriven = false; }
      }
      // v1.7.475 — host-arb host-disconnect rescue. Under flag-on (host-arb
      // model), guests have every local HP/status apply short-circuited by
      // isCoopGuest() and rely on host's resolution packets. If the host
      // drops, those packets stop and the guest would freeze in-battle
      // forever. Force-close so the guest can escape. v2 work: host
      // promotion / state handoff. Today: clean exit, lost progress.
      if (isCoopGuest() && droppedUid === (battleSt.encounterHostUserId | 0)) {
        const bs = battleSt.battleState;
        const wrappingUp = (
          bs === 'none' ||
          bs === 'encounter-box-close' ||
          bs === 'enemy-box-close' ||
          bs === 'victory-name-out' ||
          bs === 'victory-celebrate' ||
          bs.startsWith('exp-') ||
          bs.startsWith('gil-') ||
          bs.startsWith('cp-') ||
          bs.startsWith('item-text') || bs.startsWith('item-hold') || bs.startsWith('item-fade') ||
          bs.startsWith('levelup-') ||
          bs.startsWith('joblv-') ||
          bs === 'victory-text-out' ||
          bs === 'victory-menu-fade' ||
          bs === 'victory-box-close'
        );
        if (!wrappingUp) {
          battleSt.battleState = 'encounter-box-close';
          battleSt.battleTimer = 0;
        }
      }
    }
    return;
  }
  if (!battleSt.isWireEncounter) return;
  _wireEncounterActions.push(msg);
});

setNetEncounterEndHandler((msg) => {
  // Peer reported their local FSM finished the battle. Two cases need
  // different handling:
  //   1. Peer ran or quit while we were still fighting → force our FSM
  //      to encounter-box-close so we exit too (otherwise we'd be solo
  //      vs monsters balanced for a party, possibly stalled waiting on
  //      a wire-driven ally that's no longer coming).
  //   2. We've already converged on victory / defeat / our own close →
  //      keep our victory flow alive; just remove the peer from our ally
  //      panel so their portrait disappears when they leave on their end.
  //      Previously this was a full no-op + queue wipe, which made the
  //      peer's portrait linger on our screen until our own box-close
  //      fired. User wants the ally roster to mirror who is actually
  //      still here. v1.7.459.
  const peerUid = (msg && msg.userId) | 0;
  // Drain wire actions specific to the peer who ended (not the whole
  // queue — other co-op allies may still be queued).
  if (peerUid) {
    for (let i = _wireEncounterActions.length - 1; i >= 0; i--) {
      if ((_wireEncounterActions[i].userId | 0) === peerUid) {
        _wireEncounterActions.splice(i, 1);
      }
    }
  }
  if (!battleSt.isWireEncounter) return;
  const bs = battleSt.battleState;
  // States that already mean "battle is wrapping up locally" — let them
  // complete instead of jumping them ahead. Anything else → force close.
  const wrappingUp = (
    bs === 'none' ||
    bs === 'encounter-box-close' ||
    bs === 'enemy-box-close' ||
    bs === 'victory-name-out' ||
    bs === 'victory-celebrate' ||
    bs.startsWith('exp-') ||
    bs.startsWith('gil-') ||
    bs.startsWith('cp-') ||
    bs.startsWith('item-text') || bs.startsWith('item-hold') || bs.startsWith('item-fade') ||
    bs.startsWith('levelup-') ||
    bs.startsWith('joblv-') ||
    bs === 'victory-text-out' ||
    bs === 'victory-menu-fade' ||
    bs === 'victory-box-close'
  );
  if (wrappingUp) {
    // Remove the departing peer from our ally panel so the roster reflects
    // who is actually still here. Their portrait disappears immediately;
    // remaining allies (if any) stay through the rest of our victory flow.
    if (peerUid) {
      const idx = battleSt.battleAllies.findIndex(a => a && (a.userId | 0) === peerUid);
      if (idx >= 0) battleSt.battleAllies.splice(idx, 1);
    }
    return;
  }
  if (msg && msg.outcome) {/* observed for future divergence telemetry */}
  battleSt.battleState = 'encounter-box-close';
  battleSt.battleTimer = 0;
});

export function dequeueWireEncounterAction(userId) {
  if (!userId) return null;
  const idx = _wireEncounterActions.findIndex(a => (a.userId | 0) === (userId | 0));
  if (idx < 0) return null;
  return _wireEncounterActions.splice(idx, 1)[0];
}

export function hasWireEncounterAction(userId) {
  if (!userId) return false;
  return _wireEncounterActions.some(a => (a.userId | 0) === (userId | 0));
}

// Defensive drain — called from `resetBattleVars` so a stale action
// queue from a half-open prior connection doesn't replay against a new
// battle's same-userId peer. Normal close path already clears via
// `endWireEncounter`. v1.7.424.

export function clearWireEncounterQueue() {
  _wireEncounterActions.length = 0;
}

// Called by the local end-of-battle paths (victory / defeat / run) to
// notify peers that our FSM finished + wipe co-op state. Safe to call
// when not in co-op (no-ops via flag check).
export function endWireEncounter(outcome) {
  if (!battleSt.isWireEncounter) return;
  // Phase 6 — host-arb encounter-end emit. Captures the outcome before
  // the local cleanup zeroes `encounterIsHost`. Guests with the flag on
  // transition to encounter-box-close via the applier's meta.encounterEnd
  // hook. Flag-gated; default off (legacy `encounter-end` wire still
  // ships via sendNetEncounterEnd below for the flag-off path).
  if (COOP_HOST_ARB && battleSt.encounterIsHost) {
    resolveEncounterEnd({ outcome: outcome || 'ended' });
  }
  sendNetEncounterEnd(outcome || 'ended');
  battleSt.isWireEncounter = false;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = 0;
  battleSt.encounterSeed = 0;
  _wireEncounterActions.length = 0;
}

// Translate the local player's `inputSt.playerActionPending` into the
// encounter wire action shape and emit. Wire shape:
//   { kind: 'attack' | 'defend' | 'run' | 'skip' | 'magic' | 'item',
//     target: { kind: 'monster'|'self'|'ally', idx? | userId? },
//     spellId?, itemId?, hitResults?, damageRoll?, healAmount? }
// Receiver enriches with `userId` (sender's userId) on relay.
export function emitWireEncounterAction(pending) {
  const cmd = pending && pending.command;
  if (cmd === 'defend') { sendNetEncounterAction({ kind: 'defend' }); return; }
  if (cmd === 'run')    { sendNetEncounterAction({ kind: 'run'    }); return; }
  if (cmd === 'skip')   { sendNetEncounterAction({ kind: 'skip'   }); return; }
  if (cmd === 'fight') {
    sendNetEncounterAction({
      kind:       'attack',
      target:     { kind: 'monster', idx: typeof pending.target === 'number' ? pending.target : 0 },
      hitResults: pending.hitResults || null,
    });
    return;
  }
  if (cmd === 'magic' || cmd === 'item') {
    let target;
    if (pending.target === 'player') {
      if (pending.allyIndex == null || pending.allyIndex < 0) {
        target = { kind: 'self' };
      } else {
        const ally = battleSt.battleAllies[pending.allyIndex];
        target = { kind: 'ally', userId: ally?.userId || 0 };
      }
    } else {
      target = { kind: 'monster', idx: typeof pending.target === 'number' ? pending.target : 0 };
    }
    if (cmd === 'magic') {
      // Damage/heal pre-rolled at confirm-pause (battle-update.js#
      // _updateBattleMenuConfirm) so receivers apply real values instead
      // of 0. Heal-class spells (Cure family, Poisona, Raise) ride
      // `healAmount`; everything else rides `damageRoll`.
      const amt = pending.preRolledAmount | 0;
      const healKey = isHealSpell(pending.spellId);
      const extra = (amt > 0)
        ? (healKey ? { healAmount: amt } : { damageRoll: amt })
        : {};
      sendNetEncounterAction({ kind: 'magic', spellId: pending.spellId, target, ...extra });
    } else {
      sendNetEncounterAction({ kind: 'item',  itemId:  pending.itemId,  target });
    }
  }
}
