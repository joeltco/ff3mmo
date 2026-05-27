// pvp-arb-viewer.js — client-side state mirror for server-arbitrated PvP.
//
// v1.7.752 P-6 — state-only landing. Consumes the wire frames from the
// arbiter (`pvp-battle-start`, `pvp-turn`, `pvp-state-resync`,
// `pvp-cancel`) and mutates an internal state bag (`arbViewSt`) by
// walking the delta list. The render layer + input rewire come in
// P-6b / P-7 respectively — for P-6 the bag is populated but no draw
// site reads from it yet.
//
// Architecture intent (see docs/PVP-REWRITE-PLAN.md):
//   - Server is sole authority for combat state. Viewer never rolls
//     gameplay RNG; only mutates from server deltas.
//   - All four sides share the same state shape — both clients hold
//     identical `arbViewSt.combatants` after each `pvp-turn` lands.
//   - When PVP_ARBITER flips on (P-9), drawing code reads from this
//     bag instead of the legacy `pvpSt.*`. Until then this module is
//     loaded but inert (no draw site queries it).
//
// Pairs with the arbiter on `pvp-arbiter.js` (server) and the wire
// shapes in `src/net.js` (`setNetPvpArbStartHandler`, etc.).

import {
  setNetPvpArbStartHandler,
  setNetPvpArbTurnHandler,
  setNetPvpArbCancelHandler,
  setNetPvpArbStateResyncHandler,
} from './net.js';

// ── State bag ──────────────────────────────────────────────────────────────

// Single source of viewer state. Populated on `pvp-battle-start`,
// mutated by each `pvp-turn`, cleared on `pvp-cancel` / end.
//
// `combatants` is an array indexed by cellId — every server-side cell
// has a slot here even when dead, so `combatants[cellId]` is stable
// for the battle's lifetime. cellId 0-3 = side A, 4-7 = side B (range
// reserved per the arbiter's convention).
export const arbViewSt = {
  inBattle:    false,
  battleId:    0,
  yourSide:    null,        // 'A' | 'B' | null
  yourCellId:  -1,          // your main player's cell — input prompt fires when nextActor matches
  rngSeed:     0,           // animation-only RNG seed; never roll gameplay with this
  turnIdx:     0,           // last resolved turn (0 = no turns resolved yet)
  combatants:  [],          // index = cellId; entry = { side, isHuman, userId?, hp, mp, maxHP, maxMP, statusMask, defending, ...rest of wire combatant shape }
  nextActor:   null,        // { cellId, isHuman, userId? } | null — server-decided next prompt
  // Most recent turn's delta list — render layer (P-6b) walks this to
  // drive animations, then clears it. Kept here so the state bag is
  // the single dispatch source.
  pendingDeltas: [],
  // Pending end-of-battle. Cleared on `pvp-cancel` / fresh start.
  victor:      null,        // 'A' | 'B' | 'draw' | null
  endReason:   null,        // 'opponent-disconnect' | 'timeout' | null (from pvp-cancel)
};

// ── Helpers ────────────────────────────────────────────────────────────────

function _clearState() {
  arbViewSt.inBattle = false;
  arbViewSt.battleId = 0;
  arbViewSt.yourSide = null;
  arbViewSt.yourCellId = -1;
  arbViewSt.rngSeed = 0;
  arbViewSt.turnIdx = 0;
  arbViewSt.combatants.length = 0;
  arbViewSt.nextActor = null;
  arbViewSt.pendingDeltas.length = 0;
  arbViewSt.victor = null;
  arbViewSt.endReason = null;
}

function _seedFromStart(msg) {
  _clearState();
  arbViewSt.inBattle = true;
  arbViewSt.battleId = msg.battleId | 0;
  arbViewSt.yourSide = msg.yourSide;
  arbViewSt.yourCellId = msg.yourCellId | 0;
  arbViewSt.rngSeed = msg.rngSeed >>> 0;
  // Sides arrive as {A: [...], B: [...]} — flatten into a cellId-indexed
  // array. Server reserves cellId 4 for side B's main even if A has
  // fewer combatants, so we may have gaps in the array (undefined slots
  // for vacant cellIds 1-3). All consumers use the cellId field on the
  // combatant rather than array iteration order, so the gaps are safe.
  arbViewSt.combatants.length = 0;
  for (const side of ['A', 'B']) {
    const list = msg.sides && msg.sides[side];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || c.cellId == null) continue;
      arbViewSt.combatants[c.cellId | 0] = {
        ...c,
        defending: false,
        asleep: false,
      };
    }
  }
}

// Walk a single delta and mutate state. Returns true if the delta was
// applied; false if it referenced a missing combatant (logged but
// not fatal — the render layer still sees the delta in pendingDeltas
// and can handle the cosmetic fallback).
function _applyDelta(d) {
  if (!d) return false;
  const c = (d.actorCellId != null) ? arbViewSt.combatants[d.actorCellId] : null;
  const t = (d.targetCellId != null) ? arbViewSt.combatants[d.targetCellId] : null;
  switch (d.kind) {
    case 'attack': {
      // Damage applied to target. `d.hit === false` (miss) → no HP change.
      if (!t) return false;
      if (d.hit !== false && d.damage > 0) {
        t.hp = Math.max(0, (t.hp | 0) - (d.damage | 0));
      }
      return true;
    }
    case 'magic': {
      // Multi-target spell. Each entry in d.targets has its own
      // {cellId, damage?, heal?, status?, miss?}. P-4c will exercise
      // this path — included here so P-6 doesn't need a follow-up
      // when magic intents land server-side.
      if (!Array.isArray(d.targets)) return false;
      for (const ent of d.targets) {
        const tt = arbViewSt.combatants[ent.cellId];
        if (!tt) continue;
        if (ent.miss) continue;
        if (ent.damage) tt.hp = Math.max(0, (tt.hp | 0) - (ent.damage | 0));
        if (ent.heal)   tt.hp = Math.min(tt.maxHP | 0, (tt.hp | 0) + (ent.heal | 0));
        if (ent.status) tt.statusMask = ((tt.statusMask | 0) | (ent.status | 0));
      }
      return true;
    }
    case 'item': {
      if (!t) return false;
      if (d.heal)   t.hp = Math.min(t.maxHP | 0, (t.hp | 0) + (d.heal | 0));
      if (d.status) t.statusMask = ((t.statusMask | 0) | (d.status | 0));
      return true;
    }
    case 'status-tick': {
      if (!c) return false;
      // Always damage in P-4 (poison only). Future statuses may heal/buff.
      if (d.damage > 0) c.hp = Math.max(0, (c.hp | 0) - (d.damage | 0));
      return true;
    }
    case 'death': {
      if (!c) return false;
      c.hp = 0;
      return true;
    }
    case 'state': {
      if (!c) return false;
      if (d.change === 'defend-on')  c.defending = true;
      if (d.change === 'defend-off') c.defending = false;
      if (d.change === 'sleep-skip') c.asleep = true;
      if (d.change === 'wake')       c.asleep = false;
      return true;
    }
    case 'end': {
      arbViewSt.victor = d.victor || 'draw';
      return true;
    }
    default: {
      console.warn('[pvp-arb-view] unknown delta kind=' + d.kind);
      return false;
    }
  }
}

// Walk every delta in a `pvp-turn` frame. Each delta mutates state
// in-order — order matters for the animation queue (e.g. attack then
// death must render in sequence) and for end-of-round status ticks.
function _applyTurn(msg) {
  if (msg.battleId !== arbViewSt.battleId) {
    console.warn('[pvp-arb-view] pvp-turn battleId mismatch claimed=' + msg.battleId +
      ' active=' + arbViewSt.battleId + ' — ignored');
    return;
  }
  arbViewSt.turnIdx = msg.turnIdx | 0;
  arbViewSt.nextActor = msg.nextActor || null;
  // Append (don't replace) — if the render layer hasn't drained the
  // previous turn's deltas yet, the new turn's deltas pile up.
  // P-6b's draw integration must walk and clear pendingDeltas; until
  // then this just accumulates (no visible effect since no draw site
  // reads it).
  for (const d of (msg.deltas || [])) {
    _applyDelta(d);
    arbViewSt.pendingDeltas.push(d);
  }
  // Battle-end housekeeping. Server already broadcasts the end delta;
  // we clear inBattle so input prompts stop firing. State stays
  // populated for the render layer to play out final animations.
  if (arbViewSt.victor) {
    arbViewSt.inBattle = false;
    arbViewSt.nextActor = null;
  }
}

// ── Wire handler registration ──────────────────────────────────────────────
// Called once at module load. Idempotent — last-set handler wins.

setNetPvpArbStartHandler((msg) => {
  _seedFromStart(msg);
});

setNetPvpArbTurnHandler((msg) => {
  _applyTurn(msg);
});

setNetPvpArbStateResyncHandler((msg) => {
  // Full wholesale snapshot — replace state. Sent by the server on
  // hello if the client was mid-battle when reconnecting, or after
  // an enforcement rejection (rare; P-9 may add resync triggers).
  _seedFromStart(msg);
  // The resync frame may also carry a turnIdx + in-flight deltas.
  // Server contract (PVP-REWRITE-PLAN.md "pvp-state-resync"): treat
  // as a fresh start frame, then optionally replay pending deltas.
  if (typeof msg.turnIdx === 'number') arbViewSt.turnIdx = msg.turnIdx | 0;
  if (Array.isArray(msg.deltas)) {
    for (const d of msg.deltas) {
      _applyDelta(d);
      arbViewSt.pendingDeltas.push(d);
    }
  }
});

setNetPvpArbCancelHandler((msg) => {
  arbViewSt.endReason = msg.reason || 'cancelled';
  arbViewSt.inBattle = false;
  // Don't clear combatants — render layer may want to draw the cancel
  // banner over the existing battle scene. Caller can call clearArbView()
  // when teardown is complete.
});

// ── Public API ────────────────────────────────────────────────────────────

// Caller (render layer in P-6b, input layer in P-7) calls this once
// the cancel/end UI is dismissed to fully reset state.
export function clearArbView() {
  _clearState();
}

// Convenience: drain pending deltas in order, returns the consumed array.
// The render layer will call this each frame to pull new animations to
// kick off. Pure pop — caller is responsible for serializing the
// animations across multiple frames.
export function drainPendingDeltas() {
  if (arbViewSt.pendingDeltas.length === 0) return [];
  const out = arbViewSt.pendingDeltas.slice();
  arbViewSt.pendingDeltas.length = 0;
  return out;
}

// Convenience: is it MY turn to submit an intent? P-7's input layer
// uses this to gate the action menu's "submit" key. False while the
// server is resolving or the battle has ended.
export function isMyTurn() {
  if (!arbViewSt.inBattle) return false;
  if (!arbViewSt.nextActor) return false;
  return arbViewSt.nextActor.cellId === arbViewSt.yourCellId;
}

// ── Test exports (wire-sim only) ───────────────────────────────────────
// Wire-sim doesn't run the live net.js dispatch — these direct-invoke
// helpers let it feed synthetic frames through the same handlers the
// production path uses. Naming convention matches the api.js test
// hooks (`_testMirrorSync` / `_testMirrorClear` etc.).
export function _testApplyStart(msg)         { _seedFromStart(msg); }
export function _testApplyTurn(msg)          { _applyTurn(msg); }
export function _testApplyCancel(msg) {
  arbViewSt.endReason = msg.reason || 'cancelled';
  arbViewSt.inBattle = false;
}
export function _testResetView()             { _clearState(); }
