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
         setNetEncounterActionHandler, setNetEncounterEndHandler,
         sendNetAtbSync, setNetAtbSyncHandler } from './net.js';
import { markFilling } from './atb.js';

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

setNetEncounterEndHandler((msg) => {
  // Peer reported their local FSM finished the battle. Drain stale wire
  // actions. Two cases need different handling:
  //   1. Peer ran or quit while we were still fighting → force our FSM
  //      to encounter-box-close so we exit too (otherwise we'd be solo
  //      vs monsters balanced for a party, possibly stalled waiting on
  //      a wire-driven ally that's no longer coming).
  //   2. We've already converged on victory / defeat / our own close →
  //      no-op. The local close path runs endWireEncounter itself.
  // v1.7.419.
  _wireEncounterActions.length = 0;
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
  if (wrappingUp) return;
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
// Slice 4b (v1.7.439) — receive partner's ATB gauge reset. Find the
// matching local unit ref (the peer's player appears as one of our
// `battleAllies`; monsters are by index) and call markFilling with the
// sender's wall-clock atMs. Both clients now anchor their gauges to the
// same timestamp instead of independent local clocks.
setNetAtbSyncHandler((msg) => {
  if (!msg || !battleSt.isWireEncounter) return;
  const atMs = Number(msg.atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) return;
  let ref = null;
  if (msg.unitKind === 'player') {
    const senderUid = msg.userId | 0;
    for (const a of battleSt.battleAllies) {
      if (a && a.userId === senderUid) { ref = a; break; }
    }
  } else if (msg.unitKind === 'monster') {
    if (battleSt.encounterMonsters) {
      ref = battleSt.encounterMonsters[msg.monsterIdx | 0] || null;
    }
  }
  if (!ref || !ref._atb) return;
  markFilling(ref, atMs);
});

// Emit a markFilling sync event for a locally-owned unit. Caller decides
// ownership via `kind` ('player' for ps; 'monster' if encounterIsHost).
// No-op outside co-op encounters or when wire isn't ready.
export function emitAtbFillingSync(unitKind, monsterIdx, atMs) {
  if (!battleSt.isWireEncounter) return;
  sendNetAtbSync({ unitKind, monsterIdx: monsterIdx | 0, atMs: Number(atMs) });
}

export function clearWireEncounterQueue() {
  _wireEncounterActions.length = 0;
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
