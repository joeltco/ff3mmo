#!/usr/bin/env node
// check-loading-screen.mjs — the dungeon loading screen must describe the
// dungeon being entered.
//
// ⛔ WHAT SHIPPED. Three of the screen's four elements were module-level
// constants with no dungeon parameter, so the Cave of Seals drew:
//
//     "Altar Cave"   (DUNGEON_NAME, a literal in data/strings.js)
//     "4 Levels"     (_FLOORS_BYTES, a literal in loading-screen.js)
//     "HP 120"       (the DEFAULT boss's HP, computed once at module load)
//
// over a correctly-resolved Djinn silhouette. Every one was a registry field
// away. Nothing caught it because "it renders" was true the whole time.
//
// ⭐ THE PIXEL TESTS MUTATE THE REGISTRY ROW AND RE-RENDER. Asserting text
// against `dungeonLabels` alone would pass a revert that hardcodes inside the
// DRAW path, so the gate changes `name` / `floors` / `bossId` on the row and
// requires the drawn frame to change with them — and to change in the right
// PART of the frame. No layout maths is copied here; the harness draws through
// the shipped modules.
//
//   node tools/check-loading-screen.mjs

import { renderLoadingFrame, framePixels, W } from './lib/loading-frame.mjs';

const BANNER_BAND = [0, 32];    // the top box — where the dungeon NAME is drawn
const VIEWPORT_BAND = [32, 176]; // the info box (levels + boss HP) lives here

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

const { DUNGEONS } = await import('../src/data/dungeons.js');
const { dungeonLabels } = await import('../src/dungeon/labels.js');
const { MONSTERS } = await import('../src/data/monsters.js');

const txt = (b) => [...b].map((c) => (c === 0xFF ? ' '
  : c >= 0x8A && c <= 0xA3 ? String.fromCharCode(65 + c - 0x8A)
  : c >= 0xA4 && c <= 0xBD ? String.fromCharCode(97 + c - 0xA4)
  : c >= 0x80 && c <= 0x89 ? String.fromCharCode(48 + c - 0x80) : '?')).join('');

// ── 1. The text every row produces ─────────────────────────────────────────
console.log('labels');
for (const d of DUNGEONS) {
  const L = dungeonLabels(d);
  const boss = MONSTERS.get(d.bossId);
  const want = { name: d.name, levels: `${d.floors - 1} Levels`, hp: `HP ${boss.hp}` };
  const got = { name: txt(L.nameBytes), levels: txt(L.levelsBytes), hp: txt(L.hpBytes) };
  for (const k of ['name', 'levels', 'hp']) {
    if (got[k] === want[k]) ok(`${d.id} ${k}: "${got[k]}"`);
    else bad(`${d.id} ${k}: "${got[k]}" — the row says "${want[k]}"`);
  }
}

// ⭐ NO-REGRESSION PIN. Altar Cave is what the screen drew before this existed;
// the fix must reproduce it exactly, not merely become per-dungeon.
{
  const altar = DUNGEONS.find((d) => d.id === 'altar');
  const L = dungeonLabels(altar);
  const shipped = ['Altar Cave', '4 Levels', 'HP 120'];
  const got = [txt(L.nameBytes), txt(L.levelsBytes), txt(L.hpBytes)];
  if (got.join('|') === shipped.join('|')) ok(`altar unchanged from what shipped: ${got.join(' / ')}`);
  else bad(`altar changed: ${got.join(' / ')} — was ${shipped.join(' / ')}`);
}

// ── 2. The DRAWN frame tracks the row ──────────────────────────────────────
console.log('drawn frame');
const bandDiff = (a, b, [y0, y1]) => {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
    }
  }
  return n;
};

const seals = DUNGEONS.find((d) => d.id === 'seals');
await renderLoadingFrame(seals);
const base = framePixels();

async function mutate(label, patch, expect) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = seals[k]; seals[k] = patch[k]; }
  await renderLoadingFrame(seals);
  const after = framePixels();
  for (const k of Object.keys(saved)) seals[k] = saved[k];
  const banner = bandDiff(base, after, BANNER_BAND);
  const view = bandDiff(base, after, VIEWPORT_BAND);
  const seen = { banner, view };
  for (const [where, want] of Object.entries(expect)) {
    if (want === 'changed' && seen[where] > 0) ok(`${label}: ${where} changed (${seen[where]} px)`);
    else if (want === 'same' && seen[where] === 0) ok(`${label}: ${where} unchanged`);
    else bad(`${label}: ${where} is ${seen[where]} px different — expected ${want}`);
  }
}

// A renamed dungeon must repaint the BANNER and nothing else.
await mutate('name -> "Test Cavern"', { name: 'Test Cavern' }, { banner: 'changed', view: 'same' });
// A different floor count must repaint the INFO BOX and leave the banner alone.
await mutate('floors 4 -> 7', { floors: 7 }, { banner: 'same', view: 'changed' });
// A different boss must repaint the HP row. 0x06 Berserker (30 HP) is two digits
// against the Djinn's three, so the box re-widths too — a same-width swap would
// still be caught by the pixel diff, this one just fails louder.
await mutate('bossId Djinn -> Berserker', { bossId: 0x06 }, { banner: 'same', view: 'changed' });

// ── 3. The frame is not shared between dungeons ────────────────────────────
const altar = DUNGEONS.find((d) => d.id === 'altar');
await renderLoadingFrame(altar);
const altarPx = framePixels();
const bannerDelta = bandDiff(base, altarPx, BANNER_BAND);
if (bannerDelta > 0) ok(`altar and seals draw different banners (${bannerDelta} px)`);
else bad('altar and seals draw the SAME banner — the name is not per-dungeon');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
