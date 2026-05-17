// ATB (Active Time Battle) — FF4-style per-unit gauges.
//
// Slice 4a (v1.7.438): wall-clock derivation. Each unit tracks
// `startedFillingAtMs` (the moment they last entered 'filling' state);
// elapsedMs is a derived view of `min(target, now - startedFillingAtMs)`.
// This replaces the dt-accumulation model and is the foundation for
// cross-client lockstep in slice 4b (wire sync events on markActing /
// markFilling so partner clients reset gauges at the same atMs).
//
// Model (per FF4 / Hiroyuki Ito):
//   RA[X]  = floor(5 * anchorAgi / X.agi), clamped to [RA_MIN, RA_MAX]
//   anchor = highest-priority slot at battle start (local player)
//   target = ra * TICK_MS * speedMod (total fill time in ms)
//
// State flow:
//   filling → ready → acting → (action animates) → filling (markFilling)
//
// Wait mode (v1.7.428→4a): now automatic — 'ready' state doesn't tick, so
// the player's gauge naturally holds at target while menu is open. Other
// units still in 'filling' continue advancing toward ready.
//
// speedMod is 1.0 by default. Haste/Slow wire to it without touching RA —
// matches FF4's "RA does not change in battle" invariant.

export const TICK_MS  = 333;   // BS3 equivalent at 60fps (~20 frames/tick)
export const FILL_MAX = 1000;  // gauge resolution; renderer normalizes to 0..1

// RA clamp keeps gauges in a playable range regardless of agi differential.
// Min 2  → fastest fill = 2*333 = 666ms (no instant-acting bosses).
// Max 10 → slowest fill = 10*333 = 3.3s (no monsters that never act in a
//          short fight). v1.7.432.
const RA_MIN = 2;
const RA_MAX = 10;

// Clock seam — production reads Date.now(); tests can override via _setNow.
let _now = () => Date.now();

// Slice 4d (v1.7.441) — server-authoritative ready flips. When true, the
// local tick does NOT promote `filling → ready` on its own. The ready
// transition comes from a server-broadcast `atb-ready` wire event that
// calls `markReady(ref, atMs)`. Used for co-op random battles so both
// clients dispatch from the same authoritative timeline.
let _serverAuth = false;
export function setServerAuthoritative(yes) { _serverAuth = !!yes; }
export function isServerAuthoritative() { return _serverAuth; }

// Module-level state. Cleared per battle.
let _units = [];           // [{ ref, kind, agiSource }]
let _anchorAgi = 0;

// ── Public API ─────────────────────────────────────────────────────────────

// Register a fresh battle's combatants. `entries` = [{ ref, kind, agi }].
// Anchor = first entry (caller passes player first).
export function initATB(entries) {
  clearATB();
  if (!entries || entries.length === 0) return;
  _anchorAgi = entries[0].agi | 0;
  for (const e of entries) addATBUnit(e);
}

// Append a unit mid-battle (e.g. ally-join). Uses the cached anchor agility
// so newcomers slot into the existing rhythm.
export function addATBUnit({ ref, kind, agi }) {
  if (!ref) return;
  const myAgi = agi | 0;
  let ra = RA_MIN;
  if (_anchorAgi > 0 && myAgi > 0) {
    ra = Math.floor(5 * _anchorAgi / myAgi);
    if (ra < RA_MIN) ra = RA_MIN;
    if (ra > RA_MAX) ra = RA_MAX;
  }
  // Wall-clock derivation:
  //   elapsedMs (cached) = min(target, _now() - startedFillingAtMs)
  //   readyAtMs = wall time when state flipped to 'ready' (FIFO dispatch key)
  ref._atb = {
    ra, speedMod: 1.0,
    elapsedMs: 0, state: 'filling',
    startedFillingAtMs: _now(),
    readyAtMs: 0,
  };
  _units.push({ ref, kind, agiSource: myAgi });
}

function _fillTargetMs(atb) {
  return atb.ra * TICK_MS * atb.speedMod;
}

export function clearATB() {
  for (const u of _units) {
    if (u.ref) u.ref._atb = null;
  }
  _units = [];
  _anchorAgi = 0;
  _serverAuth = false;
}

// Advance all gauges based on wall clock. `dt` is retained in the signature
// for caller compatibility but no longer used internally — the gauge math
// is now a pure function of (state, startedFillingAtMs, _now()).
//
// Only 'filling' units advance; 'ready' holds at target (Wait mode), 'acting'
// freezes at the value cached at markActing time.
export function tickGauges(_dt, _opts = {}) {
  if (_units.length === 0) return;
  const now = _now();
  for (const u of _units) {
    const atb = u.ref && u.ref._atb;
    if (!atb) continue;
    if (atb.state !== 'filling') continue;
    if (u.ref.hp != null && u.ref.hp <= 0) continue;
    const target = _fillTargetMs(atb);
    if (target <= 0) continue;
    // max(0, ...) handles wire-sync atMs that's slightly ahead of local
    // clock (clock skew between co-op peers — slice 4b). Gauge holds at 0
    // until receiver's clock catches up to sender's anchor.
    atb.elapsedMs = Math.max(0, Math.min(target, now - atb.startedFillingAtMs));
    // Slice 4d — in server-auth mode the ready flip comes from `markReady`
    // (called by the atb-ready wire handler). Local tick still advances
    // elapsedMs for display continuity but doesn't change state.
    if (atb.elapsedMs >= target && !_serverAuth) {
      atb.state = 'ready';
      atb.readyAtMs = now;
    }
  }
}

// Pick the next ready unit for dispatch. FIFO — whoever hit 'ready' first
// goes first.
//
// `opts.skipPlayer` skips the player. Used by the dispatch hub during
// menu-open: the player is already at full + showing the menu; if THEY
// were the FIFO-first ready, the hub would short-circuit and never see
// the next-ready monster waiting behind them. Setting skipPlayer lets
// monsters/allies interrupt during the player's menu.
export function pickReadyActor(opts = {}) {
  const skipPlayer = !!opts.skipPlayer;
  let pick = null;
  let bestT = Infinity;
  for (const u of _units) {
    if (skipPlayer && u.kind === 'player') continue;
    const atb = u.ref && u.ref._atb;
    if (!atb || atb.state !== 'ready') continue;
    if (u.ref.hp != null && u.ref.hp <= 0) continue;
    if (atb.readyAtMs < bestT) { pick = u; bestT = atb.readyAtMs; }
  }
  return pick;
}

// 0..1 for renderer. Re-derives elapsedMs from wall clock if filling
// so partial-fill reads after a tick gap are still accurate.
export function getGaugePct(ref) {
  if (!ref || !ref._atb) return 0;
  const atb = ref._atb;
  const target = _fillTargetMs(atb);
  if (target <= 0) return 1;
  const e = atb.state === 'filling'
    ? Math.max(0, Math.min(target, _now() - atb.startedFillingAtMs))
    : atb.elapsedMs;
  return Math.min(1, Math.max(0, e / target));
}

export function isReady(ref) {
  return !!(ref && ref._atb && ref._atb.state === 'ready');
}

export function markActing(ref) {
  if (!ref || !ref._atb) return;
  // Freeze elapsedMs at its current derived value so reads in 'acting'
  // return the stable cached value (target, typically).
  const atb = ref._atb;
  if (atb.state === 'filling') {
    const target = _fillTargetMs(atb);
    atb.elapsedMs = Math.min(target, _now() - atb.startedFillingAtMs);
  }
  atb.state = 'acting';
}

// Slice 4d — flip a unit from 'filling' to 'ready'. Called by the
// atb-ready wire handler when the server's authoritative tick says this
// unit's gauge has filled. Snaps elapsedMs to target so the gauge bar
// reads as full immediately even if the local wall clock lagged.
// No-op if the unit is already in 'ready' or 'acting' (avoid resurrecting
// a stale wire event after the player already dispatched).
export function markReady(ref, atMs) {
  if (!ref || !ref._atb) return;
  const atb = ref._atb;
  if (atb.state !== 'filling') return;
  const target = _fillTargetMs(atb);
  atb.elapsedMs = target;
  atb.state = 'ready';
  atb.readyAtMs = (typeof atMs === 'number') ? atMs : _now();
}

// Reset a unit to filling from zero. Slice 4b will accept an `atMs`
// argument so wire-sync events can anchor the reset to a partner's
// timestamp; for now it defaults to local _now().
export function markFilling(ref, atMs) {
  if (!ref || !ref._atb) return;
  const t = (typeof atMs === 'number') ? atMs : _now();
  ref._atb.startedFillingAtMs = t;
  ref._atb.elapsedMs = 0;
  ref._atb.readyAtMs = 0;
  ref._atb.state = 'filling';
}

// Set speed modifier — Haste/Slow will call this. >1.0 slows (longer fill
// time), <1.0 hastes. Keeps RA invariant per FF4 canon.
export function setSpeedMod(ref, mod) {
  if (ref && ref._atb && mod > 0) ref._atb.speedMod = mod;
}

// Iterate registered units (renderer uses this).
export function getATBUnits() {
  return _units.slice();
}

// Debug / test hook.
export function _atbDebugState() {
  return _units.map(u => ({
    kind: u.kind,
    agi: u.agiSource,
    ra: u.ref && u.ref._atb ? u.ref._atb.ra : null,
    elapsedMs: u.ref && u.ref._atb ? u.ref._atb.elapsedMs : null,
    state: u.ref && u.ref._atb ? u.ref._atb.state : null,
  }));
}

// Test-only clock override. Pass a function returning ms, or null to reset
// to Date.now(). Used by atb-sim to drive deterministic gauge math.
export function _setNow(fn) {
  _now = (typeof fn === 'function') ? fn : (() => Date.now());
}

// Monsters in src/data/monsters.js have no `agi` field. Derive one
// keyed to the player's typical agi scale.
export function deriveMonsterAgi(monster) {
  if (!monster) return 5;
  const lv = monster.level | 0;
  if (lv === 0) return 5;
  const ev = monster.evade | 0;
  return Math.max(5, Math.floor(lv / 2) + 5 + (ev >> 4));
}
