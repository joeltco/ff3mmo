// Seedable PRNG for combat. Single source for every gameplay-affecting
// roll (hit/miss, damage variance, crit, initiative, AI target pick,
// AI action pick). Cosmetic rolls (UI shimmer, idle timing) stay on
// Math.random — they don't need to agree across clients.
//
// Algorithm: mulberry32. Tiny (~10 lines), deterministic, well-tested.
// Returns floats in [0, 1) like Math.random(). Drop-in replacement.
//
// Why this exists: when websocket multiplayer lands, the server sends
// an authoritative seed at battle start and every client rolls the
// same sequence. Today the seed comes from Date.now() — same drop-in
// behavior as Math.random, but the call site is ready for the swap.
//
// v1.7.749 P-3 — `createRng(seed)` factory returns an independent RNG
// instance for the PvP arbiter (server holds N concurrent battles, each
// needs its own RNG state — can't share the module singleton). The
// singleton API (`seed`, `rand`, `randInt`, …) stays as the default
// drop-in for the existing client engine.

// Shared mulberry32 step. Pure on the state arg; pulls it out of `state`
// so both the singleton and factory instances can share the algorithm.
function _step(state) {
  let t = (state.s = (state.s + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Singleton state — clients (game-loop, battle UI) call `rand()` without
// thinking about RNG identity. mulberry32 needs a non-zero seed.
const _singleton = { s: 1 };

export function seed(n) {
  // mulberry32 needs a non-zero state. Fold any 32-bit input.
  _singleton.s = ((n | 0) || 1) >>> 0;
}

export function reseedFromEntropy() {
  // Local-only entropy. Replace this call with `seed(serverSeed)` on
  // the websocket cutover; the rest of the engine doesn't change.
  seed((Date.now() ^ (Math.random() * 0x7fffffff | 0)) >>> 0);
}

export function rand() {
  return _step(_singleton);
}

// Factory — returns an isolated RNG instance keyed off the given seed.
// Multiple instances are independent; rolling on one doesn't advance
// the others. Each returned object exports `rand` (same shape as the
// singleton — float in [0, 1)) plus `getState` / `setState` for state
// snapshotting (used by P-4's deterministic resync path).
//
// Pass the returned `rand` into battle-math via `opts.rand` to drive
// per-battle rolls without touching the singleton.
export function createRng(seedValue) {
  const state = { s: ((seedValue | 0) || 1) >>> 0 };
  return {
    rand: () => _step(state),
    getState: () => state.s,
    setState: (n) => { state.s = ((n | 0) || 1) >>> 0; },
  };
}

export function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

export function randIntExclusive(maxExclusive) {
  return Math.floor(rand() * maxExclusive);
}

export function pickOne(arr) {
  return arr[randIntExclusive(arr.length)];
}

export function chance(pct) {
  return rand() * 100 < pct;
}
