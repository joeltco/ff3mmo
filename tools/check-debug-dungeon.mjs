#!/usr/bin/env node
// check-debug-dungeon.mjs — the DUNGEON debug tab must actually run.
//
// ⛔ A UI TAB THAT LINTS IS NOT A UI TAB THAT WORKS. Nothing else in the test
// suite executes debug-panel code: it only runs when a human opens the panel, on
// a phone, mid-session. A typo in a property name is invisible until then. This
// mounts the tab against a real canvas (`@napi-rs/canvas`) with a stub DOM,
// drives it, and checks what it produced.
//
//   node tools/check-debug-dungeon.mjs [out.png]
//   node tools/check-debug-dungeon.mjs out.png --skin SEALS --floor "F1 cave"
//
// The --skin / --floor pair renders the tab in a chosen state and writes the PNG,
// which is how you look at our floors wearing another cave's art without opening
// the panel (docs/CAVE-OF-SEALS-PLAN.md step 2).

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const argOf = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const WANT_SKIN = argOf('--skin');
const WANT_FLOOR = argOf('--floor');
const romPath = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const romBuf = new Uint8Array(fs.readFileSync(romPath));

// ── Minimal DOM, with REAL canvases ───────────────────────────────────────
const made = [];
function el(tag) {
  const node = {
    tagName: tag.toUpperCase(), children: [], style: { cssText: '' },
    dataset: {}, _text: '', innerHTML: '',
    appendChild(c) { this.children.push(c); return c; },
    // ⛔ RECORD handlers so the harness can DRIVE the tab, not just mount it.
    // A check that only mounts proves the first paint; every control after that
    // — floors, seeds, skins — is still untested code that runs on a phone.
    _on: {},
    addEventListener(ev, fn) { (this._on[ev] = this._on[ev] || []).push(fn); },
    click() { for (const fn of (this._on.click || [])) fn(); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
  };
  if (tag === 'canvas') {
    const cv = createCanvas(1, 1);
    node.getContext = (t) => {
      if (node._cv?.width !== node.width || node._cv?.height !== node.height) {
        node._cv = createCanvas(node.width || 1, node.height || 1);
      }
      return node._cv.getContext(t);
    };
    node.toBuffer = (...a) => node._cv.toBuffer(...a);
    node._raw = cv;
  }
  made.push(node);
  return node;
}
globalThis.document = { createElement: el, getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.fetch = async () => ({ ok: false });   // no IPS in this harness; raw ROM is fine

const fails = [];
const tab = await import('../src/debug/tabs/dungeon.js');
const { floorNames } = tab;
const { DUNGEONS } = await import('../src/data/dungeons.js');
if (typeof tab.mount !== 'function') fails.push('the tab exports no mount()');

const root = el('div');
tab.mount(root, { getFF3Buffer: () => romBuf });
await new Promise((r) => setTimeout(r, 200));   // let the ROM promise settle

const canvas = made.find((n) => n.tagName === 'CANVAS');
const pre = made.find((n) => n.tagName === 'PRE');
const buttons = made.filter((n) => n.tagName === 'BUTTON');

console.log(`mounted: ${buttons.length} buttons, canvas ${canvas?.width}x${canvas?.height}`);
if (!canvas) fails.push('no canvas was created');
if (buttons.length < 11) fails.push(`expected at least 11 controls (5 floors + 3 seed + 3 toggles), got ${buttons.length}`);

const text = pre?.textContent || '';
if (/loading ROM/.test(text)) fails.push('the tab never got past "loading ROM" — the ROM promise did not resolve');
if (/threw:/.test(text)) fails.push(`generateFloor threw inside the tab:\n${text.slice(0, 400)}`);
for (const want of ['seed ', 'walkable ', 'entrance ', 'exits:', 'secrets:', 'floor ']) {
  if (!text.includes(want)) fails.push(`the report is missing "${want}"`);
}
// ⛔ Check the NUMBERS, not just that the strings are present. A first version
// asserted only that the report contained "walkable " and "entrance " — so
// misspelling `md.entranceX` still passed: the flood seeded from `undefined`,
// reached nothing, and every walkable tile came back unreachable. The tab would
// have rendered a solid red square and the gate would have called it fine.
const m = text.match(/walkable (\d+)\s+unreachable (\d+)/);
if (!m) fails.push('the report has no "walkable N unreachable N" line to check');
else {
  const walk = +m[1], un = +m[2];
  console.log(`walkable ${walk}, unreachable ${un}`);
  if (walk < 20) fails.push(`only ${walk} walkable tiles — the floor did not generate`);
  if (un >= walk) fails.push(`ALL ${walk} walkable tiles read as unreachable — the reachability flood never seeded (a bad entrance reference does exactly this)`);
  if (un > walk * 0.25) fails.push(`${un} of ${walk} tiles unreachable — far past what any floor should strand`);
}

console.log('--- report ---');
console.log(text.split('\n').slice(0, 12).join('\n'));

// ── Drive every control ────────────────────────────────────────────────────
// ⛔ LOOK THE BUTTON UP LIVE, NOT IN A SNAPSHOT. `buttons` is captured once at
// mount, and the floor row is REBUILT when the cave changes — its floor count
// and labels come from the registry row — so a snapshot taken before the first
// cave switch cannot see the buttons that exist after it.
const press = (label) => {
  const b = made.filter((n) => n.tagName === 'BUTTON').find((n) => n.textContent === label);
  if (!b) { fails.push(`no control labelled "${label}"`); return false; }
  b.click(); return true;
};
const paintOf = () => {
  const c2 = canvas.getContext('2d');
  const px = c2.getImageData(0, 0, canvas.width, canvas.height).data;
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4 * 97) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  return seen;
};
// ⛔ THE CAVE BUTTONS ARE THE REGISTRY'S ROWS. This drove ['ALTAR','SEALS',
// 'CRYSTAL'] — but CRYSTAL was never a dungeon, it was a boss SKIN, back when
// this tab previewed repaints of Altar Cave instead of real rows.
const skinLooks = {};
for (const skin of DUNGEONS.map((d) => d.id.toUpperCase())) {
  if (!press(skin)) continue;
  skinLooks[skin] = paintOf();
  console.log(`skin ${skin.padEnd(8)} ${skinLooks[skin].size} distinct colours`);
  if (skinLooks[skin].size < 4) fails.push(`skin ${skin} painted almost nothing`);
}
// ⛔ A skin that does not CHANGE the picture is not a skin. If two donors render
// identically the switcher is wired to nothing, which a colour count alone would
// happily pass.
if (skinLooks.ALTAR && skinLooks.SEALS) {
  const same = [...skinLooks.ALTAR].filter((c) => skinLooks.SEALS.has(c)).length;
  const ratio = same / Math.max(1, skinLooks.ALTAR.size);
  console.log(`ALTAR vs SEALS palette overlap: ${Math.round(ratio * 100)}%`);
  if (ratio > 0.9) fails.push('the SEALS skin renders the same as ALTAR — the donor swap is not reaching paint()');
}
// ⛔ THE FLOOR LABELS COME FROM THE REGISTRY, NOT FROM A LIST HERE. They used to
// be the literals ['F1 cave','F2 traps','F3 puzzle','F4 rooms','F5 crystal'] —
// Altar Cave's floor names, hardcoded — so this gate asserted the preview showed
// ALTAR CAVE's floors no matter which dungeon was selected. That is exactly the
// bug the tab had: it previewed a repaint of Altar Cave rather than the real row.
//
// Driving them per dungeon also proves the floor row REBUILDS on a cave switch,
// which it must, because floor count is a property of the row.
for (const dg of DUNGEONS) {
  press(dg.id.toUpperCase());
  for (const name of floorNames(dg)) press(name);
}
// ⛔ AND THE TWO CAVES MUST NOT SHOW THE SAME FLOOR LIST. Both are five floors
// deep and share three layout names; if the labels came out identical the row is
// not being read per dungeon.
{
  const a = floorNames(DUNGEONS[0]).join('|');
  const b = floorNames(DUNGEONS[1]).join('|');
  console.log(`floor labels  ${DUNGEONS[0].id}: ${a}`);
  console.log(`floor labels  ${DUNGEONS[1].id}: ${b}`);
  if (a === b) fails.push('both dungeons show the same floor labels — the preview is not reading the registry row');
}
press('REROLL'); press('UNREACHED'); press('MARKS'); press('GRID');
console.log(`drove ${buttons.length} controls without throwing`);

// Leave the tab in the requested state, so the PNG below is the one asked for.
if (WANT_SKIN) press(WANT_SKIN);
if (WANT_FLOOR) press(WANT_FLOOR);

// The canvas must actually have paint on it, not be a blank square.
if (canvas) {
  const c2 = canvas.getContext('2d');
  const px = c2.getImageData(0, 0, canvas.width, canvas.height).data;
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4 * 97) seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  console.log(`canvas distinct colours sampled: ${seen.size}`);
  if (seen.size < 4) fails.push(`the canvas is nearly blank (${seen.size} colours) — paint() drew nothing`);
  if (OUT) { fs.writeFileSync(OUT, canvas.toBuffer('image/png')); console.log(`wrote ${OUT}`); }
}

if (fails.length) { console.log('\nFAIL:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nDUNGEON tab mounts, paints and reports');
