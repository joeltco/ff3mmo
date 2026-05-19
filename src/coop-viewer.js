// Co-op viewer (P3+, docs/COOP-VIEWER-PLAN.md).
//
// Under `COOP_VIEWER_MODE` flag, a guest in a co-op encounter stops
// running the battle FSM and becomes a packet-driven animation player.
// This module owns the viewer state + tick.
//
// Wire path: host emits `encounter-resolution` packets that now carry a
// `viewEvent` field (built by `coop-deltas.js#wrapViewEventForWire`).
// The wire handler in `coop-applier.js` (P4) routes them here under
// flag-on. Until P4 lands the route, this module is dead code — flag
// is also `false` by default.
//
// State model:
//   - `coopViewSt.active`        — true while flag-on AND in a co-op encounter
//   - `coopViewSt.cueQueue`      — ViewEvent[] sorted by turnIdx
//   - `coopViewSt.currentAnim`   — { event, animState } | null
//   - `coopViewSt.lastAppliedTurnIdx` — monotonic dedup
//
// Viewer mutates `battleSt.battleAllies`, `encounterMonsters`, `ps`
// directly so the existing renderer keeps working unchanged. The
// `battleState` field is repurposed as a display-state cursor (slash /
// magic / damage-show / monster-death) driven by the current anim —
// NOT an FSM state.
//
// Each ViewEvent kind maps to one anim handler in `VIEW_ANIM_REGISTRY`.
// Handlers are short state machines: trigger overlay → wait animMs →
// write finalState → done. The dispatcher consumes the queue strictly
// in-order on `turnIdx`; out-of-order packets buffer.

import { battleSt } from './battle-state.js';
import { ps } from './player-stats.js';
import { COOP_VIEWER_MODE } from './coop-resolver.js';
import { getMyUserId } from './net.js';
import { playSFX, SFX } from './music.js';
import {
  setSwDmgNum,
  setPlayerDamageNum,
  setPlayerHealNum,
  getAllyDamageNums,
  MONSTER_DEATH_MS,
  tickElapsed,
} from './coop-view-anims.js';

// ── State ────────────────────────────────────────────────────────────────

export const coopViewSt = {
  active:              false,
  cueQueue:            [],
  currentAnim:         null,    // { event, animState: { elapsedMs, kind } }
  lastAppliedTurnIdx:  0,
  // Bookkeeping
  pendingResync:       false,
};

// Max queue depth before we start dropping oldest non-final-state
// events. finalState carried on every event means HP stays correct
// even with drops, but the visual stream gets choppy. 32 should be
// generous — a phone falling that far behind is a network problem,
// not a viewer one.
const MAX_QUEUE_DEPTH = 32;

// ── Lifecycle ────────────────────────────────────────────────────────────

// Called when a guest enters a co-op encounter under flag-on. Resets
// viewer state, hands control of `battleSt` to the viewer. The first
// `encounter-start` ViewEvent will populate monsters + combatants.
export function enterViewerMode() {
  if (!COOP_VIEWER_MODE) return;
  coopViewSt.active = true;
  coopViewSt.cueQueue.length = 0;
  coopViewSt.currentAnim = null;
  coopViewSt.lastAppliedTurnIdx = 0;
  coopViewSt.pendingResync = false;
}

// Called when the encounter ends (encounter-end ViewEvent completes) or
// when the encounter is force-closed (host dropped + no promotion).
export function exitViewerMode() {
  coopViewSt.active = false;
  coopViewSt.cueQueue.length = 0;
  coopViewSt.currentAnim = null;
  coopViewSt.lastAppliedTurnIdx = 0;
  coopViewSt.pendingResync = false;
}

// Called when this guest is promoted to host. Returns the viewer's
// last-known turnIdx so the resolver can initialize its counter
// monotonically. Caller (`encounter-wire.js` host-changed handler)
// is responsible for flipping `encounterIsHost` + setting up the FSM.
export function leaveViewerForPromotion() {
  const lastIdx = coopViewSt.lastAppliedTurnIdx;
  exitViewerMode();
  return lastIdx;
}

// ── Wire ingestion ───────────────────────────────────────────────────────

// Called from the wire handler (coop-applier.js under flag-on). Packet
// is the full `encounter-resolution` envelope; we read `viewEvent`
// and queue it sorted by turnIdx.
export function ingestViewEventPacket(packet) {
  if (!COOP_VIEWER_MODE || !coopViewSt.active) return;
  if (!packet || !packet.viewEvent) return;
  const event = packet.viewEvent;
  const turnIdx = packet.turnIdx | 0;
  event.turnIdx = turnIdx;  // mirror onto event for downstream
  // Drop dups + already-applied
  if (turnIdx <= coopViewSt.lastAppliedTurnIdx) return;
  // Cap queue depth
  if (coopViewSt.cueQueue.length >= MAX_QUEUE_DEPTH) {
    coopViewSt.cueQueue.shift();
  }
  // Insertion-sort by turnIdx so future packets land in order even if
  // wire delivers out of sequence (rare with TCP/WS but possible across
  // reconnects).
  let i = coopViewSt.cueQueue.length - 1;
  while (i >= 0 && (coopViewSt.cueQueue[i].turnIdx | 0) > turnIdx) i--;
  coopViewSt.cueQueue.splice(i + 1, 0, event);
}

// ── Animation registry ───────────────────────────────────────────────────

// Each handler: (event, animState, dt) → { done: bool }.
// animState is the per-anim scratch object the dispatcher owns.

function _animAttack(event, animState, dt) {
  // P3 stub — full slash + damage-num routing lands in P5 when host
  // emits the real ViewEvent. For now: trigger damage-num overlay on
  // target with authoritative dmg, wait animMs, advance.
  if (animState.elapsedMs === 0) {
    _triggerDamageNumForTarget(event.target, _summarizeAttackHits(event.hits));
    playSFX(SFX.ATTACK_HIT);
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animMagic(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    for (const t of (event.targets || [])) {
      if (t.result === 'miss') {
        _triggerDamageNumForTarget(t.ref, { value: 0, miss: true });
      } else if (t.dmg) {
        _triggerDamageNumForTarget(t.ref, { value: t.dmg | 0, miss: false });
      } else if (t.heal) {
        _triggerHealNumForTarget(t.ref, t.heal | 0);
      }
    }
    playSFX(SFX.CURE);
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animItem(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    if (event.heal > 0) _triggerHealNumForTarget(event.target, event.heal | 0);
    else if (event.dmg > 0) _triggerDamageNumForTarget(event.target, { value: event.dmg, miss: false });
    playSFX(SFX.CURE);
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animMonsterAttack(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    if (event.miss) {
      _triggerDamageNumForTarget(event.target, { value: 0, miss: true });
    } else {
      _triggerDamageNumForTarget(event.target, { value: event.dmg | 0, miss: false });
      // Battle shake — same primitive the FSM uses
      battleSt.battleShakeTimer = 200;
    }
    playSFX(SFX.ATTACK_HIT);
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animPoisonTick(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    for (const t of (event.ticks || [])) {
      _triggerDamageNumForTarget(t.ref, { value: t.dmg | 0, miss: false });
    }
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animMonsterDeath(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    if (!(battleSt.dyingMonsterIndices instanceof Map)) {
      battleSt.dyingMonsterIndices = new Map();
    }
    battleSt.dyingMonsterIndices.set(event.monsterIdx | 0, 0);
    playSFX(SFX.MONSTER_DEATH);
  }
  const done = tickElapsed(animState, dt, MONSTER_DEATH_MS);
  if (done && battleSt.dyingMonsterIndices instanceof Map) {
    battleSt.dyingMonsterIndices.delete(event.monsterIdx | 0);
    if (battleSt.dyingMonsterIndices.size === 0) {
      battleSt.dyingMonsterIndices = new Map();
    }
  }
  return { done };
}

function _animPlayerDeath(event, animState, dt) {
  // Portrait fade — finalState writes hp=0 + alive=false. Renderer
  // already darkens KO'd portraits via the existing status check.
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animTurnBegin(event, animState, dt) {
  if (animState.elapsedMs === 0 && event.prompt) {
    // Guest's turn — surface menu prompt. Existing input handler
    // looks at battleState === 'menu-open' as the gate; we set that.
    battleSt.battleState = 'menu-open';
    battleSt.battleTimer = 0;
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

function _animEncounterStart(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    // Bootstrap battle state from the event payload. This replaces
    // the legacy `setNetEncounterInviteHandler` spawn-from-invite
    // path for guests under viewer mode.
    _applyEncounterStartFinalState(event);
    battleSt.battleState = event.midBattle ? 'menu-open' : 'flash-strobe';
    battleSt.battleTimer = 0;
    playSFX(SFX.BATTLE_SWIPE);
  } else if (battleSt.battleState === 'flash-strobe') {
    // P9.1 — viewer must drive battleTimer manually since updateBattle
    // (which normally does this) isn't running on guests. The renderer
    // reads battleTimer to compute the strobe alpha; without this the
    // flash visual freezes at frame 0.
    battleSt.battleTimer += dt;
  }
  const done = tickElapsed(animState, dt, event.animMs);
  if (done) {
    // P9.1 — park at HUD-displaying state for the idle gap before the
    // host's first turn lands. menu-open is the legacy "battle HUD
    // shown, awaiting action" state; renderer treats it as a stable
    // resting state. Without this, the guest stays at flash-strobe
    // forever (v1.7.486 freeze bug).
    battleSt.battleState = 'menu-open';
    battleSt.battleTimer = 0;
  }
  return { done };
}

function _animEncounterEnd(event, animState, dt) {
  if (animState.elapsedMs === 0) {
    // Show victory / defeat / fled. For v1 we transition straight to
    // the existing post-battle states so XP/gil/drop screens still
    // render via the legacy renderer reading battleSt.encounterXxxGained.
    if (event.outcome === 'victory' && event.rewards) {
      battleSt.encounterExpGained = event.rewards.exp | 0;
      battleSt.encounterGilGained = event.rewards.gil | 0;
      if (Array.isArray(event.rewards.drops) && event.rewards.drops.length > 0) {
        battleSt.encounterDropItem = event.rewards.drops[0].itemId;
      }
      battleSt.battleState = 'victory-name-out';
    } else {
      battleSt.battleState = 'encounter-box-close';
    }
    battleSt.battleTimer = 0;
  }
  return { done: tickElapsed(animState, dt, event.animMs) };
}

const VIEW_ANIM_REGISTRY = {
  'attack':           _animAttack,
  'magic':            _animMagic,
  'item':             _animItem,
  'monster-attack':   _animMonsterAttack,
  'poison-tick':      _animPoisonTick,
  'monster-death':    _animMonsterDeath,
  'player-death':     _animPlayerDeath,
  'turn-begin':       _animTurnBegin,
  'encounter-start':  _animEncounterStart,
  'encounter-end':    _animEncounterEnd,
};

// ── Tick ─────────────────────────────────────────────────────────────────

// Called from the main loop under viewer mode. Replaces `updateBattle`
// for guests in co-op. Animations advance, finalState writes happen at
// anim end, next packet dequeues.
export function updateCoopView(dt) {
  if (!coopViewSt.active) return;
  // If no current anim, try to pick up the next packet.
  if (!coopViewSt.currentAnim && coopViewSt.cueQueue.length > 0) {
    _beginNextAnim();
  }
  if (!coopViewSt.currentAnim) return;  // idle — no queued events
  const { event, animState } = coopViewSt.currentAnim;
  const handler = VIEW_ANIM_REGISTRY[event.eventKind];
  if (!handler) {
    // Unknown kind — apply finalState immediately and skip animation.
    // Log once per kind for forward-compat visibility.
    if (!_unknownLogged.has(event.eventKind)) {
      _unknownLogged.add(event.eventKind);
      console.warn('[coop-viewer] unknown eventKind=' + event.eventKind);
    }
    _writeFinalState(event);
    coopViewSt.lastAppliedTurnIdx = event.turnIdx | 0;
    coopViewSt.currentAnim = null;
    return;
  }
  const { done } = handler(event, animState, dt);
  if (done) {
    _writeFinalState(event);
    coopViewSt.lastAppliedTurnIdx = event.turnIdx | 0;
    const wasEncounterEnd = event.eventKind === 'encounter-end';
    coopViewSt.currentAnim = null;
    // P6 — after the encounter-end anim completes, hand control back
    // to the legacy `updateBattle` FSM so it can progress the
    // `encounter-box-close` timer + restore overworld. Viewer can't
    // own the wrap-up itself because reward / inventory mutations live
    // in the legacy victory flow.
    if (wasEncounterEnd) {
      exitViewerMode();
      return;
    }
    // Chain immediately if queue has another item — keeps animation
    // train tight when host emits a multi-event burst.
    if (coopViewSt.cueQueue.length > 0) _beginNextAnim();
  }
}

const _unknownLogged = new Set();

function _beginNextAnim() {
  const event = coopViewSt.cueQueue.shift();
  coopViewSt.currentAnim = {
    event,
    animState: { elapsedMs: 0, kind: event.eventKind },
  };
}

// ── finalState writer ────────────────────────────────────────────────────

function _writeFinalState(event) {
  const fs = event.finalState;
  if (!fs) return;
  // Actors — find via userId in battleAllies, or `ps` if it's us.
  const myUid = getMyUserId() | 0;
  if (Array.isArray(fs.actors)) {
    for (const a of fs.actors) {
      if (!a || !a.ref) continue;
      const target = _resolveActorRefForWrite(a.ref, myUid);
      if (!target) continue;
      if (typeof a.hp === 'number') target.hp = a.hp | 0;
      if (typeof a.mp === 'number') target.mp = a.mp | 0;
      if (typeof a.statusMask === 'number' && target.status) {
        target.status.mask = a.statusMask | 0;
      }
    }
  }
  // Monsters
  if (Array.isArray(fs.monsters) && Array.isArray(battleSt.encounterMonsters)) {
    for (const m of fs.monsters) {
      const mon = battleSt.encounterMonsters[m.idx | 0];
      if (!mon) continue;
      if (typeof m.hp === 'number') mon.hp = m.hp | 0;
      if (typeof m.statusMask === 'number' && mon.status) {
        mon.status.mask = m.statusMask | 0;
      }
    }
  }
}

function _resolveActorRefForWrite(ref, myUid) {
  if (!ref) return null;
  if (ref.kind === 'player') {
    const uid = ref.userId | 0;
    if (!uid) return null;
    if (uid === myUid) return ps;
    if (!Array.isArray(battleSt.battleAllies)) return null;
    return battleSt.battleAllies.find(a => a && (a.userId | 0) === uid) || null;
  }
  if (ref.kind === 'monster') {
    if (!Array.isArray(battleSt.encounterMonsters)) return null;
    return battleSt.encounterMonsters[ref.idx | 0] || null;
  }
  return null;
}

// ── Damage / heal num routing ────────────────────────────────────────────
// Maps an ActorRef to the right damage-num slot. Same shape coop-applier
// already uses for fx cue dispatch — kept aligned so the visual feels
// identical between host-arb-only and viewer modes.

function _triggerDamageNumForTarget(ref, dmgObj) {
  if (!ref) return;
  const myUid = getMyUserId() | 0;
  if (ref.kind === 'monster') {
    setSwDmgNum(ref.idx | 0, dmgObj.value | 0, dmgObj);
    return;
  }
  if (ref.kind === 'player') {
    const uid = ref.userId | 0;
    if (!uid) return;
    if (uid === myUid) {
      if (dmgObj.miss) setPlayerDamageNum({ miss: true, timer: 0 });
      else setPlayerDamageNum({ value: dmgObj.value | 0, timer: 0 });
      return;
    }
    if (!Array.isArray(battleSt.battleAllies)) return;
    const idx = battleSt.battleAllies.findIndex(a => a && (a.userId | 0) === uid);
    if (idx >= 0) {
      const arr = getAllyDamageNums();
      arr[idx] = dmgObj.miss ? { miss: true, timer: 0 } : { value: dmgObj.value | 0, timer: 0 };
    }
  }
}

function _triggerHealNumForTarget(ref, healAmount) {
  if (!ref || !healAmount) return;
  const myUid = getMyUserId() | 0;
  if (ref.kind === 'player') {
    const uid = ref.userId | 0;
    if (uid === myUid) {
      setPlayerHealNum({ value: healAmount | 0, timer: 0 });
      return;
    }
    if (!Array.isArray(battleSt.battleAllies)) return;
    const idx = battleSt.battleAllies.findIndex(a => a && (a.userId | 0) === uid);
    if (idx >= 0) {
      const arr = getAllyDamageNums();
      arr[idx] = { value: healAmount | 0, timer: 0, heal: true };
    }
  }
}

// Multi-hit summary for damage-num display. Returns { value, miss }.
function _summarizeAttackHits(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return { value: 0, miss: true };
  let total = 0, anyHit = false;
  for (const h of hits) {
    if (!h) continue;
    if (h.miss || h.shieldBlock) continue;
    total += h.damage | 0;
    anyHit = true;
  }
  if (!anyHit) return { value: 0, miss: true };
  return { value: total, miss: false };
}

// Bootstrap battle state from an encounter-start event. Sets monsters,
// battleAllies, isWireEncounter, encounterIsHost=false.
function _applyEncounterStartFinalState(event) {
  battleSt.isWireEncounter = true;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = event.hostUserId | 0;
  battleSt.isRandomEncounter = true;
  // Monsters
  battleSt.encounterMonsters = (event.monsters || []).map(m => ({
    monsterId: m.monsterId | 0,
    hp:        m.hp | 0,
    maxHP:     m.maxHP | 0,
    status:    { mask: (m.statusMask | 0), poisonDmgTick: 0 },
  }));
  // Battle allies (combatants minus self) — realized stats baked in.
  const myUid = getMyUserId() | 0;
  battleSt.battleAllies = [];
  for (const c of (event.combatants || [])) {
    const uid = c.userId | 0;
    if (uid === myUid) continue;
    battleSt.battleAllies.push({
      userId:       uid,
      name:         c.name || '',
      hp:           c.hp | 0,
      mp:           c.mp | 0,
      maxHP:        c.maxHP | 0,
      maxMP:        c.maxMP | 0,
      jobIdx:       c.jobIdx | 0,
      level:        c.level | 0,
      palIdx:       c.palIdx | 0,
      atk:          c.atk | 0,
      def:          c.def | 0,
      agi:          c.agi | 0,
      isWireDriven: true,
      status:       { mask: 0, poisonDmgTick: 0 },
    });
  }
}

// ── Test surface ─────────────────────────────────────────────────────────
// Exposed for tools/coop-viewer-sim.js (P8). Not part of public API.

export const _testHooks = {
  state:                coopViewSt,
  enterViewerMode,
  exitViewerMode,
  ingestViewEventPacket,
  updateCoopView,
  // Direct anim invocation for unit tests
  invokeAnim: (kind, event, animState, dt) => {
    const handler = VIEW_ANIM_REGISTRY[kind];
    return handler ? handler(event, animState, dt) : null;
  },
  // Bypass the COOP_VIEWER_MODE flag for tests. Forces `active=true` and
  // pushes the packet directly into the queue. Used by
  // `tools/coop-viewer-sim.js` to exercise queue + dispatch without
  // requiring a flag-on build.
  forceActive: () => { coopViewSt.active = true; },
  forceInactive: () => { coopViewSt.active = false; coopViewSt.cueQueue.length = 0; coopViewSt.currentAnim = null; },
  injectEvent: (viewEvent, turnIdx) => {
    const tidx = turnIdx | 0;
    if (tidx <= coopViewSt.lastAppliedTurnIdx) return;
    if (coopViewSt.cueQueue.length >= 32) coopViewSt.cueQueue.shift();
    const ev = { ...viewEvent, turnIdx: tidx };
    let i = coopViewSt.cueQueue.length - 1;
    while (i >= 0 && (coopViewSt.cueQueue[i].turnIdx | 0) > tidx) i--;
    coopViewSt.cueQueue.splice(i + 1, 0, ev);
  },
};
