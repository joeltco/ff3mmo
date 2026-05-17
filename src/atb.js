// ATB (Active Time Battle) — FF4-style per-unit gauges.
// Slice 1 (v1.7.428): display-only. Legacy turn queue still drives dispatch;
// these gauges fill alongside as a visual layer. Subsequent slices replace
// the queue with gauge-driven dispatch.
//
// Model (per FF4 / Hiroyuki Ito):
//   RA[X]  = floor(5 * anchorAgi / X.agi), min 1, clamped to 1 if either is 0
//   anchor = highest-priority slot at battle start (we pick the local player)
//   tick   = base period in ms per RA unit; total fill time = RA * TICK_MS
//   gauge  = 0..FILL_MAX, fills at rate FILL_MAX / (RA * TICK_MS * speedMod)
//
// Wait mode (v1.7.428): when the player's menu is open and their gauge is
// already full, hold it at full while the rest of the field keeps ticking.
// Mirrors FF4 Wait setting. Active mode (gauges keep filling during menu)
// is not exposed in slice 1.
//
// speedMod is 1.0 by default. Haste/Slow wire to it in a later slice without
// touching RA — matches FF4's "RA does not change in battle" invariant.

export const TICK_MS  = 333;   // BS3 equivalent at 60fps (~20 frames/tick)
export const FILL_MAX = 1000;  // gauge resolution; renderer normalizes to 0..1

// Module-level state. Cleared per battle.
let _units = [];           // [{ ref, kind, agiSource }]  — kind in 'player'|'ally'|'monster'|'pvp-enemy'
let _anchorAgi = 0;

// ── Public API ─────────────────────────────────────────────────────────────

// Register a fresh battle's combatants. `entries` = [{ ref, kind, agi }].
// Mutates each ref to attach `_atb = { ra, speedMod, gauge, state }`.
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
  let ra = 1;
  if (_anchorAgi > 0 && myAgi > 0) {
    ra = Math.floor(5 * _anchorAgi / myAgi);
    if (ra < 1) ra = 1;
  }
  // Track elapsed-ms-since-empty instead of an accumulating float gauge —
  // makes the ready boundary land exactly at ra*TICK_MS*speedMod without
  // drift across many ticks. `gauge` (0..FILL_MAX) is a derived view.
  // readyAtMs = wall time when state flipped to 'ready'; used for FIFO
  // dispatch when multiple units fill simultaneously.
  ref._atb = { ra, speedMod: 1.0, elapsedMs: 0, state: 'filling', readyAtMs: 0 };
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
}

// Advance all gauges by `dt` ms. `opts.playerMenuOpen` enables Wait-mode
// pause for the player's gauge once full.
export function tickGauges(dt, opts = {}) {
  if (dt <= 0 || _units.length === 0) return;
  const playerMenuOpen = !!opts.playerMenuOpen;
  const now = Date.now();
  for (const u of _units) {
    const atb = u.ref && u.ref._atb;
    if (!atb) continue;
    if (atb.state === 'acting') continue;
    // Dead combatants don't tick. KO'd ally + dead monster + dead PvP
    // enemy + downed player all stop here. Their gauges resume only on
    // resurrection (life spell etc.); for now resurrection isn't wired,
    // so dead = out of ATB rotation for the rest of the battle.
    if (u.ref.hp != null && u.ref.hp <= 0) continue;
    const target = _fillTargetMs(atb);
    if (target <= 0) continue;
    const isFull = atb.elapsedMs >= target;
    if (playerMenuOpen && u.kind === 'player' && isFull) continue;  // Wait
    atb.elapsedMs = Math.min(target, atb.elapsedMs + dt);
    if (atb.elapsedMs >= target && atb.state === 'filling') {
      atb.state = 'ready';
      atb.readyAtMs = now;
    }
  }
}

// Pick the next ready unit for dispatch. FIFO — whoever hit 'ready' first
// goes first. Player wins ties (their `readyAtMs` may be slightly later
// due to Wait-mode pause). Returns the entry `{ref, kind}` or null.
export function pickReadyActor() {
  let pick = null;
  let bestT = Infinity;
  for (const u of _units) {
    const atb = u.ref && u.ref._atb;
    if (!atb || atb.state !== 'ready') continue;
    // Dead units don't dispatch (could have died after their gauge filled).
    if (u.ref.hp != null && u.ref.hp <= 0) continue;
    if (atb.readyAtMs < bestT) { pick = u; bestT = atb.readyAtMs; }
  }
  return pick;
}

// 0..1 for renderer. Returns 0 when no ATB state attached (out-of-battle).
export function getGaugePct(ref) {
  if (!ref || !ref._atb) return 0;
  const target = _fillTargetMs(ref._atb);
  if (target <= 0) return 1;
  return Math.min(1, ref._atb.elapsedMs / target);
}

export function isReady(ref) {
  return !!(ref && ref._atb && ref._atb.state === 'ready');
}

export function markActing(ref) {
  if (ref && ref._atb) { ref._atb.state = 'acting'; }
}

// Reset a unit to filling from zero (slice 2+ will call this after action
// resolves). In slice 1 the legacy queue handles dispatch, so this isn't
// wired into the action pipeline yet.
export function markFilling(ref) {
  if (!ref || !ref._atb) return;
  ref._atb.elapsedMs = 0;
  ref._atb.state = 'filling';
}

// Set speed modifier — Haste/Slow will call this in a later slice. >1.0
// slows (longer fill time), <1.0 hastes. Keeps RA invariant per FF4 canon.
export function setSpeedMod(ref, mod) {
  if (ref && ref._atb && mod > 0) ref._atb.speedMod = mod;
}

// Iterate registered units. Renderer reads kind for color + uses ref to
// compute getGaugePct / isReady. Order is insertion order (anchor first).
export function getATBUnits() {
  return _units.slice();
}

// Debug / test hook. Don't read from this in production render code —
// use getGaugePct + isReady instead.
export function _atbDebugState() {
  return _units.map(u => ({
    kind: u.kind,
    agi: u.agiSource,
    ra: u.ref && u.ref._atb ? u.ref._atb.ra : null,
    elapsedMs: u.ref && u.ref._atb ? u.ref._atb.elapsedMs : null,
    state: u.ref && u.ref._atb ? u.ref._atb.state : null,
  }));
}

// Monsters in src/data/monsters.js have no `agi` field (FF3 NES didn't use
// per-monster agility — round order was class/level based). Derive one
// from level + evade so faster, dodgier monsters tick faster. Tuneable.
// Missing or level-zero data falls back to 5 (mid-tier baseline).
export function deriveMonsterAgi(monster) {
  if (!monster) return 5;
  const lv = monster.level | 0;
  if (lv === 0) return 5;
  const ev = monster.evade | 0;
  return Math.max(1, lv + (ev >> 3));
}
