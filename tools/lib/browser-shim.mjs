// browser-shim.mjs — DOM / audio / storage globals for Node-side tools.
//
// src modules touch `window`, `document`, `AudioContext` and `localStorage` at
// IMPORT time, so any tool that reaches into src has to install these before its
// first dynamic import. Extracted verbatim from tools/encounter-sim.js (which
// had itself cloned it from coop-viewer-sim.js) so a third hand-copy does not
// exist — two copies of a shim is exactly the kind of split that drifts until
// one tool sees a different game than the other.
//
// Import for side effects, BEFORE importing anything from ../src:
//
//   import './lib/browser-shim.mjs';
//   const { SPELLS } = await import('../src/data/spells.js');

const _stubEl = () => ({
  style:           {},
  classList:       { add: () => {}, remove: () => {}, toggle: () => {} },
  appendChild:     () => {}, removeChild: () => {},
  setAttribute:    () => {}, getAttribute: () => null,
  parentNode:      null,
  getContext:      () => ({
    fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, scale: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {}, stroke: () => {}, fill: () => {},
    arc: () => {}, moveTo: () => {}, lineTo: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray() }),
    putImageData: () => {}, getImageData: () => ({ data: new Uint8ClampedArray() }),
    measureText: () => ({ width: 0 }), fillText: () => {}, strokeText: () => {},
    clearRect: () => {}, clip: () => {}, setTransform: () => {},
    canvas: { width: 0, height: 0 },
  }),
});

globalThis.window = {
  addEventListener:    () => {},
  removeEventListener: () => {},
  location:            { href: '' },
  devicePixelRatio:    1,
  innerWidth:          800,
  innerHeight:         600,
};
globalThis.document = {
  createElement:    _stubEl,
  getElementById:   _stubEl,
  querySelector:    _stubEl,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body:             { appendChild: () => {}, querySelector: () => null },
  head:             { appendChild: () => {} },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame  = () => {};
globalThis.Image = class { constructor() { this.onload = null; } };
globalThis.Audio = class { constructor() {} play() {} pause() {} };
globalThis.AudioContext = class {
  constructor() {}
  createGain()         { return { gain: { value: 0 }, connect: () => {} }; }
  createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; }
  decodeAudioData()    { return Promise.resolve({}); }
  get destination()    { return {}; }
};
globalThis.Worker = class {
  constructor() {}
  postMessage()       {}
  addEventListener()  {}
  terminate()         {}
};
globalThis.localStorage = {
  _kv: new Map(),
  getItem(k)    { return this._kv.has(k) ? this._kv.get(k) : null; },
  setItem(k, v) { this._kv.set(k, String(v)); },
  removeItem(k) { this._kv.delete(k); },
  clear()       { this._kv.clear(); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; }
  send()              {}
  close()             {}
  addEventListener()  {}
  removeEventListener() {}
};
