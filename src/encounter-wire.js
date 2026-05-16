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

const _wireEncounterActions = [];

setNetEncounterActionHandler((msg) => {
  if (!msg) return;
  if (msg.kind === 'disconnect') {
    // Peer dropped — clear wire-driven flag on their ally entry so the
    // ally-turn handler falls back to local AI (defend). Battle proceeds
    // single-player-style for the rest of the round.
    if (msg.userId) {
      for (const a of battleSt.battleAllies) {
        if (a && a.userId === (msg.userId | 0)) { a.isWireDriven = false; }
      }
    }
    return;
  }
  if (!battleSt.isWireEncounter) return;
  _wireEncounterActions.push(msg);
});

setNetEncounterEndHandler(() => {
  // Peer reported their local FSM finished the battle. Our local FSM is
  // converging on the same outcome via synced rand — this is a safety
  // signal for cleanup, not a forced state change. Just drain stale wire
  // actions; the local end-of-battle path resets `isWireEncounter`.
  _wireEncounterActions.length = 0;
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

// Called by the local end-of-battle paths (victory / defeat / run) to
// notify peers that our FSM finished + wipe co-op state. Safe to call
// when not in co-op (no-ops via flag check).
export function endWireEncounter(outcome) {
  if (!battleSt.isWireEncounter) return;
  sendNetEncounterEnd(outcome || 'ended');
  battleSt.isWireEncounter = false;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = 0;
  battleSt.encounterSeed = 0;
  battleSt.encounterTurnIndex = 0;
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
    if (cmd === 'magic') sendNetEncounterAction({ kind: 'magic', spellId: pending.spellId, target });
    else                 sendNetEncounterAction({ kind: 'item',  itemId:  pending.itemId,  target });
  }
}
