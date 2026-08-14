#!/usr/bin/env node
// check-shops.mjs — every shop still exists, and still opens.
//
// This gate exists because Kazus's three shops VANISHED and nothing noticed.
// Reverting v1.8.12 pulled them out of `data/shops.js`; the rebuild put the
// NPCs back and never restored the shop entries. For four versions the keepers
// stood at their counters saying a line with no shop behind them, and every
// other gate passed — placement, palettes, dialogue, room clip. Content that
// silently disappears in a refactor is invisible to a gate that only checks
// the content that is still there.
//
//   node tools/check-shops.mjs
//
// So: pin the roster. A shop being deleted is now a build failure, and adding
// one means saying so here on purpose.

import fs from 'node:fs';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null, addEventListener() {} };

const { SHOPS, findShopAtCounter, getShopType } = await import('../src/data/shops.js');
const { ITEMS } = await import('../src/data/items.js');
const { loadMap } = await import('../src/map-loader.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);

// The roster, pinned. Every town that has shipped shops is listed; a missing
// entry means content was dropped, which is exactly the failure this catches.
const EXPECTED = ['ur_weapon', 'ur_armor', 'ur_item', 'ur_magic',
                  'kazus_weapon', 'kazus_armor', 'kazus_magic'];

for (const id of EXPECTED) {
  if (!SHOPS.has(id)) bad(`shop "${id}" is GONE from data/shops.js — a town lost its shop`);
}
if (SHOPS.size !== EXPECTED.length) {
  const extra = [...SHOPS.keys()].filter(k => !EXPECTED.includes(k));
  if (extra.length) bad(`unlisted shop(s): ${extra.join(', ')} — add them to EXPECTED here on purpose`);
}
if (!failed) ok(`all ${EXPECTED.length} shops present`);

// Each one has to be REACHABLE: the counter lookup is what movement.js uses on
// a Z-press, so a shop whose counter does not resolve cannot be opened at all.
for (const [id, shop] of SHOPS) {
  const found = findShopAtCounter(shop.mapId, shop.counter.x, shop.counter.y);
  if (found !== id) {
    bad(`${id}: findShopAtCounter(${shop.mapId}, ${shop.counter.x}, ${shop.counter.y}) returned ` +
        `${found === null ? 'NOTHING' : found} — the player cannot open it`);
    continue;
  }
  if (!shop.items || !shop.items.length) { bad(`${id} stocks nothing`); continue; }
  const unknown = shop.items.filter(i => !ITEMS.get(i));
  if (unknown.length) {
    bad(`${id} stocks unknown item id(s) ${unknown.map(i => '0x' + i.toString(16)).join(', ')}`);
    continue;
  }
  if (!getShopType(id)) bad(`${id} has no resolvable type (drives the keeper sprite)`);
}
if (!failed) ok('every shop resolves at its counter and stocks known items');

// A magic shop's keeper is placed by map-loading.js, ON the counter tile,
// carrying the shopId — that is what opens the menu. A plain TOWN_NPCS villager
// beside the counter has no shopId and only says a line, which is how Kazus
// shipped a magic shop with no menu.
{
  const src = fs.readFileSync(new URL('../src/map-loading.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [id, shop] of SHOPS) {
    if (getShopType(id) !== 'magic') continue;
    const re = new RegExp(`addBlackMageShopkeeper\\(\\s*${shop.counter.x}\\s*,\\s*${shop.counter.y}\\s*,\\s*['"]${id}['"]`);
    if (!re.test(src)) {
      bad(`${id}: map-loading.js never calls addBlackMageShopkeeper(${shop.counter.x}, ${shop.counter.y}, '${id}') — ` +
          'the magic shop would have no keeper carrying its shopId, so no menu');
    }
  }
  if (!failed) ok('every magic shop has its keeper placed with the shopId that opens it');
}

// The counter tile should be the tile the ROM uses for a counter, so a typo in
// a coordinate lands somewhere obviously wrong rather than on a plausible floor.
{
  const counters = new Map();
  for (const [id, shop] of SHOPS) {
    const md = loadMap(rom, shop.mapId);
    const raw = md.tilemap[shop.counter.y * 32 + shop.counter.x];
    const m = raw < 128 ? raw : raw & 0x7F;
    if (!counters.has(m)) counters.set(m, []);
    counters.get(m).push(id);
  }
  const kinds = [...counters.keys()].map(m => '$' + m.toString(16));
  console.log(`  ·     counter tiles in use: ${kinds.join(' ')}`);
}

if (failed) { console.error(`\ncheck-shops: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-shops: OK');
