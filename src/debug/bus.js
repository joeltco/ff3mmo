// Debug event bus. Default emit is a no-op (V8 inlines it out). When the LOG
// tab opens, it installs a real subscriber that pushes into a ring buffer.
//
// Usage at call sites: `import { emit } from './debug/bus.js'; emit('battle:hit', {...})`

export let emit = () => {};

const RING_SIZE = 500;
let ring = null;
let ringHead = 0;
let listeners = new Set();

export function enable() {
  ring = new Array(RING_SIZE);
  ringHead = 0;
  emit = _emitReal;
}

export function disable() {
  emit = () => {};
  ring = null;
  listeners.clear();
}

export function isEnabled() {
  return ring !== null;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function snapshot() {
  if (!ring) return [];
  const out = [];
  for (let i = 0; i < RING_SIZE; i++) {
    const entry = ring[(ringHead + i) % RING_SIZE];
    if (entry) out.push(entry);
  }
  return out;
}

function _emitReal(type, payload) {
  const entry = { t: performance.now(), type, payload };
  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % RING_SIZE;
  for (const fn of listeners) fn(entry);
}
