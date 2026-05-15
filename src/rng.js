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

let _state = 1;

export function seed(n) {
  // mulberry32 needs a non-zero state. Fold any 32-bit input.
  _state = ((n | 0) || 1) >>> 0;
}

export function reseedFromEntropy() {
  // Local-only entropy. Replace this call with `seed(serverSeed)` on
  // the websocket cutover; the rest of the engine doesn't change.
  seed((Date.now() ^ (Math.random() * 0x7fffffff | 0)) >>> 0);
}

export function rand() {
  let t = (_state = (_state + 0x6D2B79F5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
