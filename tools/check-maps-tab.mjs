#!/usr/bin/env node
// check-maps-tab.mjs — actually MOUNT the debug MAPS tab and drive it.
//
// `npm run lint` cannot see a tab that throws on mount: the failure is a
// runtime DOM error, and the whole panel just shows an empty pane. This mounts
// the tab against a minimal DOM shim (canvases are real, via @napi-rs/canvas),
// then exercises every control — map stepper, both views, every seed, the
// overlay toggles, zoom and click-to-move-camera — and fails on the first
// throw.
//
//   node tools/check-maps-tab.mjs

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

function el(tag) {
  if (tag === 'canvas') {
    const c = createCanvas(1, 1);
    c.style = { cssText: '' };
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 512, height: 512 });
    return c;
  }
  const node = {
    tagName: tag, children: [], dataset: {}, style: { cssText: '' },
    textContent: '', innerHTML: '', value: '', selectedIndex: 0,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 512, height: 512 }),
  };
  return node;
}

globalThis.document = { createElement: el };

// `ctx.getFF3Buffer()` returns the raw **ArrayBuffer** from the file/zip loader,
// NOT a Uint8Array — `main.js#loadROM` is what wraps it. Handing this shim a
// Uint8Array made the gate more forgiving than the browser: the tab shipped
// indexing an ArrayBuffer, every byte read came back undefined, and the panel
// died with "md.fillTile is undefined" while this check passed. Feed it exactly
// what the game feeds it.
const romArrayBuffer = rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength);

// The tab applies patches/ff3-awj.ips the way boot does. Serve it from disk if
// present so the patched path is the one under test; a miss must degrade to the
// raw ROM, not throw.
globalThis.fetch = async (url) => {
  const path = new URL('../' + String(url).replace(/^\.?\//, ''), import.meta.url).pathname;
  if (!fs.existsSync(path)) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  const buf = fs.readFileSync(path);
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

const { mount, unmount } = await import('../src/debug/tabs/maps.js');

// mount() now loads the ROM asynchronously (the IPS fetch), so the controls
// cannot be driven until that settles.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

const root = el('div');
let failures = 0;
const step = (what, fn) => {
  try { fn(); } catch (e) {
    console.error(`  ✗ ${what}: ${e.message}`);
    failures++;
  }
};

// Mount with no ROM first — must degrade, not throw.
step('mount without a ROM', () => mount(el('div'), { getFF3Buffer: () => null }));
await settle();

step('mount with the ROM', () => mount(root, { getFF3Buffer: () => romArrayBuffer }));
await settle();
await settle();

// Walk the control surface. Buttons live on the bar, which is the first child.
const find = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) find(c, pred, out);
  return out;
};
const buttons = find(root, n => n.tagName === 'button');
const selects = find(root, n => n.tagName === 'select');
const canvases = find(root, n => typeof n.getContext === 'function');

if (!buttons.length) { console.error('  ✗ no buttons rendered'); failures++; }
if (!selects.length) { console.error('  ✗ no seed selector rendered'); failures++; }
if (!canvases.length) { console.error('  ✗ no canvas rendered'); failures++; }

for (const b of buttons) {
  step(`button "${b.textContent}"`, () => b.onclick && b.onclick());
}
step('click the map to move the camera', () => {
  const c = canvases[0];
  if (c.onclick) c.onclick({ clientX: 200, clientY: 200 });
});

// Every map in the play area, in both views, through the real render path.
// Rebuilding a MapRenderer prerenders a 512x512 canvas and re-floods the room,
// so a full 69-map sweep across every seed costs ~3 minutes — too slow to sit
// in deploy.sh. The gate only has to catch a tab that throws, so the default is
// a spread that exercises every code path: towns, shared-tilemap interiors, a
// cave, an outdoor map with no clip, and the maps whose clips this arc changed.
// `--all` runs the full play area.
const SAMPLE = [10, 12, 13, 17, 20, 44, 101, 111, 114, 122, 164, 188, 191, 3, 15];
const FULL = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,26,27,28,29,30,
              44,45,46,47,50,52,53,54,101,102,111,112,113,114,115,122,123,147,148,160,163,164,
              165,166,168,170,174,175,176,177,178,179,182,183,186,187,188,189,190,191];
const PLAY = process.argv.includes('--all') ? FULL : SAMPLE;
const idInput = find(root, n => n.tagName === 'input')[0];
let swept = 0;
for (const id of PLAY) {
  step(`map ${id}`, () => {
    idInput.value = String(id);
    idInput.onchange();
    // and the player view, which uses a different draw path
    const pv = buttons.find(b => b.textContent === 'PLAYER VIEW');
    const fv = buttons.find(b => b.textContent === 'FULL MAP');
    pv && pv.onclick();
    fv && fv.onclick();
    // and each door seed, which rebuilds the clip from a different tile
    const sel = selects[0];
    for (const opt of sel.children) {
      sel.value = opt.value;
      sel.onchange();
    }
    swept++;
  });
}

// `--png <file> [--map N]` dumps what the tab actually draws, so the overlays
// can be looked at rather than assumed.
const pngArg = process.argv.indexOf('--png');
if (pngArg >= 0) {
  const mapArg = process.argv.indexOf('--map');
  const id = mapArg >= 0 ? parseInt(process.argv[mapArg + 1], 10) : 12;
  const seedArg = process.argv.indexOf('--seed');
  // The control sweep above clicked every toggle once, so put the overlays back
  // into a known state before dumping — otherwise the picture depends on how
  // many buttons happened to exist.
  const byLabel = (t) => buttons.find(b => b.textContent === t);
  if (!/#c8a832;color:#111/.test(byLabel('CLIP')?.style.cssText || '')) byLabel('CLIP')?.onclick();
  if (/#c8a832;color:#111/.test(byLabel('GRID')?.style.cssText || '')) byLabel('GRID')?.onclick();
  if (!/#c8a832;color:#111/.test(byLabel('DOORS')?.style.cssText || '')) byLabel('DOORS')?.onclick();
  idInput.value = String(id);
  idInput.onchange();
  if (seedArg >= 0) { selects[0].value = process.argv[seedArg + 1]; selects[0].onchange(); }
  if (process.argv.includes('--player')) {
    buttons.find(b => b.textContent === 'PLAYER VIEW')?.onclick();
  }
  fs.writeFileSync(process.argv[pngArg + 1], canvases[0].toBuffer('image/png'));
  console.log(`wrote ${process.argv[pngArg + 1]} (map ${id})`);
}

step('unmount', () => unmount());

if (failures) {
  console.error(`\ncheck-maps-tab: FAIL — ${failures} error(s)`);
  process.exit(1);
}
console.log(`check-maps-tab: OK — tab mounts, ${buttons.length} controls fire, ` +
            `${swept} maps render in both views across every seed` +
            (process.argv.includes("--all") ? " (full play area)" : " (sample; --all for all 69)"));
