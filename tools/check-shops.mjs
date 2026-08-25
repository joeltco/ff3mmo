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
const { getSpellSchool, getSpellLevel } = await import('../src/data/spells.js');
const { keeperArtForShop, getShopSprite } = await import('../src/data/shop-sprites.js');
const { loadMap } = await import('../src/map-loader.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);

// The roster, pinned. Every town that has shipped shops is listed; a missing
// entry means content was dropped, which is exactly the failure this catches.
const EXPECTED = ['ur_weapon', 'ur_armor', 'ur_item', 'ur_magic',
                  // ⭐ kazus_item (v1.10.73) — the keeper standing behind the
                  // pub's bar, ROM record $2e @(9,23), had no counter wired, so
                  // facing him did nothing. Counter (9,24) is tile $1d, the
                  // same counter tile Ur's shops use.
                  'kazus_weapon', 'kazus_armor', 'kazus_magic', 'kazus_item'];

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

// ⛔ A MAGIC SHOP SELLS ONE SCHOOL, AND THE RIGHT ONE.
//
// Ur is the WHITE magic shop and Kazus the BLACK one. A magic catalog is a list
// of scroll item ids, and nothing connected a scroll to the school it teaches —
// Kazus shipped Fire + Ice (black) alongside Ice2, and Ur sold a single white
// Pure scroll, with no check that any of it was coherent. The school is not
// guessed here: each scroll carries `learnedSpell`, and `getSpellSchool()`
// owns the answer.
const SCHOOL_OF_SHOP = { ur_magic: 'white', kazus_magic: 'black' };
for (const [id, want] of Object.entries(SCHOOL_OF_SHOP)) {
  const shop = SHOPS.get(id);
  if (!shop) { bad(`${id} is missing`); continue; }
  const got = shop.items.map((i) => {
    const sc = ITEMS.get(i);
    return { i, spell: sc && sc.learnedSpell, school: sc && sc.learnedSpell != null ? getSpellSchool(sc.learnedSpell) : null };
  });
  const wrong = got.filter((g) => g.school !== want);
  if (wrong.length) {
    bad(`${id} should sell ${want} magic but stocks ` +
        wrong.map((g) => `0x${g.i.toString(16)} (spell ${g.spell}, ${g.school})`).join(', '));
  } else ok(`${id} sells ${got.length} ${want} spell(s), all of that school`);
  // All three of the school's level-1 spells, no more and no less.
  const lv = got.map((g) => getSpellLevel(g.spell));
  if (got.length === 3 && lv.every((l) => l === 1)) ok(`${id} carries all THREE level-1 ${want} spells`);
  else bad(`${id} carries ${got.length} spell(s) at level(s) ${lv.join(',')} — wanted three at level 1`);
}

// ⛔ THE SHOP-MENU KEEPER MUST MATCH WHAT THE SHOP SELLS.
//
// `FF3MMO_TO_FF1` mapped `magic` -> 'white-magic' unconditionally, so EVERY
// magic shop drew a White Mage in the menu — including one selling black magic
// — while the captured 'black-magic' keeper art sat in `SHOP_KEEPER_TILES`
// unreachable by any code path. Nothing noticed, because nothing compared the
// picture to the stock.
for (const [id, shop] of SHOPS) {
  const type = getShopType(id);
  const art = keeperArtForShop(type, shop.school);
  if (!getShopSprite(type, shop.school)) { bad(`${id}: no keeper art resolves for ${art}`); continue; }
  if (type === 'magic') {
    const want = shop.school === 'black' ? 'black-magic' : 'white-magic';
    if (!shop.school) bad(`${id} is a magic shop with no \`school\` — the menu cannot pick a keeper`);
    else if (art === want) ok(`${id} (${shop.school}) draws the ${art} keeper`);
    else bad(`${id} sells ${shop.school} magic but draws the ${art} keeper`);
  } else ok(`${id} draws the ${art} keeper`);
}

// ⛔ AND SO MUST THE PERSON STANDING IN THE ROOM. Ur's weapon and armor keepers
// wore a shop-keeper sprite while Kazus's wore the generic villager everyone
// else in town wears, so one town's shops read as shops and the other's read as
// houses. Same trade, same face.
{
  const KEEPERS = [
    ['weapon', [[5, 'weapon_keeper'], [16, 'kazus_weapon_keeper']]],
    ['armor',  [[4, 'armor_keeper'],  [17, 'kazus_armor_keeper']]],
  ];
  for (const [trade, list] of KEEPERS) {
    const offs = list.map(([map, key]) => {
      const e = (TOWN_NPCS.get(map) || []).find((n) => n.key === key);
      return e ? e.spec.romOffset : null;
    });
    if (offs.some((o) => o == null)) { bad(`${trade}: a keeper is missing from TOWN_NPCS`); continue; }
    if (new Set(offs).size === 1) ok(`every ${trade} keeper wears 0x${offs[0].toString(16).toUpperCase()}`);
    else bad(`${trade} keepers wear DIFFERENT sprites (${offs.map((o) => '0x' + o.toString(16).toUpperCase()).join(' vs ')}) — one town's shop reads as a house`);
  }
}

// ⛔ A COUNTER HAS TO BE A COUNTER, AND SOMEONE HAS TO BE BEHIND IT.
//
// The check above asks `findShopAtCounter` for the shop's OWN coordinates, so it
// agrees with itself no matter where the counter is pointed — moving Kazus's
// counter off the bar onto open floor passed it clean. That is deriving the
// expectation from the value under test. This asserts the tile is real:
//
//   * non-magic shops: the counter tile is SOLID (you serve ACROSS it, you do
//     not walk onto it) and a placed NPC stands orthogonally next to it
//   * magic shops: FF3 sells spells off orbs, so the keeper stands ON the tile
//     and `addMageShopkeeper` is what puts them there (checked above)
//
// This is what a keeper standing at an unwired bar looks like from a gate.
for (const [id, shop] of SHOPS) {
  if (getShopType(id) === 'magic') continue;
  const md = loadMap(rom, shop.mapId);
  const { x, y } = shop.counter;
  const mid = md.tilemap[y * 32 + x];
  const col = md.collision[mid < 128 ? mid : mid & 0x7F];
  const solid = (col & 0x07) === 3 || !!(col & 0x80);
  if (solid) ok(`${id}: counter (${x},${y}) is a solid tile $${mid.toString(16)}`);
  else bad(`${id}: counter (${x},${y}) is tile $${mid.toString(16)}, which the player can WALK ON — that is floor, not a counter`);
  const placed = TOWN_NPCS.get(shop.mapId) || [];
  const behind = placed.filter((e) => Math.abs(e.x - x) + Math.abs(e.y - y) === 1);
  if (behind.length) ok(`${id}: ${behind.map((e) => e.key).join(', ')} stands at the counter`);
  else bad(`${id}: NOBODY is placed next to counter (${x},${y}) — the shop opens onto an empty counter`);
}



// A magic shop's keeper is placed by map-loading.js, ON the counter tile,
// carrying the shopId — that is what opens the menu. A plain TOWN_NPCS villager
// beside the counter has no shopId and only says a line, which is how Kazus
// shipped a magic shop with no menu.
{
  const src = fs.readFileSync(new URL('../src/map-loading.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [id, shop] of SHOPS) {
    if (getShopType(id) !== 'magic') continue;
    // ⭐ The keeper's SCHOOL is part of the call now — `addMageShopkeeper(x, y,
    // id, 'white'|'black')` picks the job walk sprite, so a white-magic shop
    // cannot be staffed by a Black Mage. The old check only looked for
    // `addBlackMageShopkeeper`, which could not have caught that.
    const want = shop.school === 'black' ? 'black' : 'white';
    const re = new RegExp(
      `addMageShopkeeper\\(\\s*${shop.counter.x}\\s*,\\s*${shop.counter.y}\\s*,\\s*['"]${id}['"]\\s*,\\s*['"](white|black)['"]`);
    const hit = re.exec(src);
    if (!hit) {
      bad(`${id}: map-loading.js never calls addMageShopkeeper(${shop.counter.x}, ${shop.counter.y}, '${id}', ...) — ` +
          'the magic shop would have no keeper carrying its shopId, so no menu');
    } else if (hit[1] !== want) {
      bad(`${id} sells ${want} magic but map-loading.js staffs it with the ${hit[1]} mage`);
    }
  }
  if (!failed) ok('every magic shop is staffed by a mage of the school it sells');
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
