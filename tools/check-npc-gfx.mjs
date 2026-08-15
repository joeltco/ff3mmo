#!/usr/bin/env node
// check-npc-gfx.mjs — the NPC id -> sprite lookup stays decoded.
//
// `src/data/npc-gfx.js` resolves an FF3 NPC id to the sprite it wears, through
// a byte table at ROM 0x1410. Before it was found, every town's cast was picked
// by hand off "which bundles does this map load", which is how Kazus shipped
// three shop keepers wearing the GHOST sprite and a townsman wearing CID.
//
//   node tools/check-npc-gfx.mjs
//
// Everything below is an INDEPENDENT measurement — a PPU capture or an OAM
// read that exists in the repo for its own reasons — so the table has to
// reproduce it. Nothing here is derived from the table itself.

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

const { loadMap } = await import('../src/map-loader.js');
const { JOB_NAMES } = await import('../src/data/jobs.js');
const G = await import('../src/data/npc-gfx.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);

const gfx = (id) => G.gfxForNpcId(rom, id);
const off = (g) => G.offsetForGfx(g);

// ── 1. the three pairs town-npcs.js recorded before the table was found ────
// "the known pairs ($14->32, $15->34, $19->38) are not a constant offset".
// They were OAM-measured. Exactly one 256-byte window in the ROM satisfies all
// three; if the constants drift, this stops holding.
{
  const PAIRS = [[0x14, 32], [0x15, 34], [0x19, 38]];
  let n = 0;
  for (const [id, want] of PAIRS) {
    if (gfx(id) !== want) bad(`id $${id.toString(16)} resolves to gfx ${gfx(id)}, measured ${want}`);
    else n++;
  }
  if (n === PAIRS.length) ok('the three pre-table OAM-measured pairs still resolve');
}

// ── 2. bundle sets read out of the real PPU ───────────────────────────────
// tools/monscan/map-bundles.cjs traces live sprite memory back to ROM offsets.
// These are its results. The table must predict each set EXACTLY — not a
// superset, not a subset.
{
  const MEASURED = [
    ['Ur', 114, [0x1DF10, 0x1E010, 0x1E210, 0x1E310, 0x1E510]],
    ['Castle Sasune', 18, [0x1E010, 0x1EE10]],
    // Kazus includes 0x1D910 — CID. Re-measured 2026-08-14: the PPU holds
    // Cid's LIVING sprite there, and 0x1ED10 ("ghost form") is NOT loaded by
    // map 10 at all. The older note claiming otherwise was wrong.
    ['Kazus', 10, [0x1D910, 0x1DF10, 0x1E010, 0x1E210]],
  ];
  for (const [name, mapId, want] of MEASURED) {
    const md = loadMap(rom, mapId);
    const got = [...new Set((md.npcs || []).map(n => gfx(n.id)))]
      .filter(g => G.kindForGfx(g) === 'person' || G.kindForGfx(g) === 'job')
      .map(off).sort((a, b) => a - b);
    const w = [...want].sort((a, b) => a - b);
    const hex = (a) => a.map(v => '0x' + v.toString(16).toUpperCase()).join(' ');
    if (hex(got) !== hex(w)) {
      bad(`${name} (map ${mapId}): table predicts [${hex(got)}], the PPU measured [${hex(w)}]`);
    }
  }
  if (!failed) ok('all three measured towns predict their PPU bundle set exactly');
}

// ── 3. the flames, measured by reading OAM ────────────────────────────────
// flame-sprites.js: the Kazus campfire (id 190) "draws the SAME graphics as
// the large torch" (id 193) — traced by standing next to it in the real game.
// The candle (id 194) is a different sprite. The table has to agree, and the
// offsets it produces have to be the ones that file already hard-codes.
{
  if (gfx(190) !== gfx(193)) {
    bad(`campfire id190 (gfx ${gfx(190)}) and torch id193 (gfx ${gfx(193)}) resolve differently — ` +
        'OAM measured them as the same graphics');
  } else if (gfx(194) === gfx(193)) {
    bad('candle id194 resolves to the same sprite as the torch — OAM measured them as different');
  } else if (off(gfx(193)) !== 0x14010 || off(gfx(194)) !== 0x14090) {
    bad(`torch/candle resolve to 0x${off(gfx(193)).toString(16)} / 0x${off(gfx(194)).toString(16)}, ` +
        'flame-sprites.js measured 0x14010 / 0x14090');
  } else ok('campfire = torch, candle separate, both at the offsets OAM measured');
}

// ── 4. the star ───────────────────────────────────────────────────────────
// flame-sprites.js carries STAR_FRAMES = [0x014790, 0x0147D0] — two frames,
// found independently. Some gfx index has to land on that pair.
{
  let found = null;
  for (let g = G.OBJECT_FIRST; g < G.UNDRAWN_FIRST; g++) if (off(g) === 0x14790) found = g;
  if (found === null) bad('no gfx index resolves to 0x14790, the star sprite flame-sprites.js already had');
  else ok(`gfx ${found} resolves to the star at 0x14790 (frames 0x14790 / 0x147D0)`);
}

// ── 5. the job range ──────────────────────────────────────────────────────
// Index 4 is the magic-shop keeper in BOTH Ur (map 3) and Kazus (map 15), and
// job 4 is the Black Mage — map-loading.js calls it `addBlackMageShopkeeper`.
// That is what ties the 0..21 range to JOB_NAMES rather than to guesswork.
{
  const blackMage = JOB_NAMES.indexOf('Black Mage');
  if (blackMage !== 4) bad(`Black Mage is job ${blackMage}, not 4 — the job-range mapping was anchored on 4`);
  for (const mapId of [3, 15]) {
    const md = loadMap(rom, mapId);
    const has = (md.npcs || []).some(n => gfx(n.id) === blackMage);
    if (!has) bad(`magic shop map ${mapId} has no NPC resolving to the Black Mage sprite`);
  }
  if (G.kindForGfx(4) !== 'job') bad('gfx 4 is not classified as a job sprite');
  if (!failed) ok('gfx 4 = Black Mage, and it is the keeper in both magic shops');
}

// ── 6. the arrays stay separate ───────────────────────────────────────────
// People are 16 tiles at 0x100 stride; objects are 8 tiles at 0x80 stride in a
// DIFFERENT array. Collapsing them into one linear range is the original bug
// ("0x1C010 + id*256"), so assert they cannot silently become one.
{
  if (off(G.OBJECT_FIRST - 1) !== G.PEOPLE_BASE + (G.OBJECT_FIRST - 1) * 0x100) bad('people array base/stride drifted');
  if (off(G.OBJECT_FIRST) !== G.OBJECT_BASE) bad('object array does not start at OBJECT_BASE');
  if (off(G.OBJECT_FIRST) > G.PEOPLE_BASE) bad('the object array is no longer below the people array — they have been merged');
  if (G.offsetForGfx(G.UNDRAWN_FIRST) !== null) bad('undrawn indices now resolve to an offset — they have no graphics');
  if (G.tileCountForGfx(30) !== 16 || G.tileCountForGfx(70) !== 8) bad('tile counts per kind drifted (people 16, objects 8)');
  if (!failed) ok('people and object arrays stay separate, undrawn stays undrawn');
}

// ── 7. the undrawn range stays undrawn ────────────────────────────────────
// Widening UNDRAWN_FIRST is silent: the indices above it start resolving into
// the object array, which past 87 is tilemap noise, and every invisible event
// marker in the game would begin drawing garbage.
//
// The anchor is the shop counters. Ur's and Kazus's weapon/armor shops each
// list an NPC sitting ON the counter tile beside the keeper — the entry that
// opens the shop. The player sees a counter there, not a person, so those MUST
// resolve to nothing. They are also the single most-used index in the game.
{
  const TRIGGERS = [231, 238, 232, 239];   // Ur weapon/armor, Kazus weapon/armor
  for (const id of TRIGGERS) {
    if (G.kindForGfx(gfx(id)) !== 'undrawn') {
      bad(`shop-counter trigger id ${id} resolves to gfx ${gfx(id)} (${G.kindForGfx(gfx(id))}) — ` +
          'it would draw a person standing on the shop counter');
    }
  }
  // ...and they all share one index, which is the most-placed in the game.
  const counts = new Map();
  for (let mapId = 0; mapId < 512; mapId++) {
    let md; try { md = loadMap(rom, mapId); } catch { continue; }
    for (const n of md.npcs || []) counts.set(gfx(n.id), (counts.get(gfx(n.id)) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (G.kindForGfx(top[0]) !== 'undrawn') {
    bad(`the most-placed gfx index is ${top[0]} (${top[1]} placements) and it is classified ` +
        `${G.kindForGfx(top[0])} — the invisible event marker must not be drawn`);
  }
  if (!failed) ok(`shop-counter triggers and the most-placed index (${top[0]}, ${top[1]} uses) stay undrawn`);

  // The boundary itself sits in a gap no NPC uses, so assert the GAP rather
  // than a precision that is not measurable: every drawn index in use must be
  // below UNDRAWN_FIRST, and every marker index in use at or above it.
  const usedIdx = [...counts.keys()].sort((a, b) => a - b);
  const lastDrawn = usedIdx.filter(g => g < G.UNDRAWN_FIRST).pop();
  const firstMarker = usedIdx.find(g => g >= G.UNDRAWN_FIRST);
  if (lastDrawn !== 87) bad(`the highest USED drawn index is ${lastDrawn}, expected 87`);
  if (firstMarker !== 97) bad(`the lowest USED marker index is ${firstMarker}, expected 97`);
  if (G.UNDRAWN_FIRST <= 87 || G.UNDRAWN_FIRST > 97) {
    bad(`UNDRAWN_FIRST=${G.UNDRAWN_FIRST} falls outside the unused gap 88..97 — it now ` +
        'reclassifies an index some NPC actually uses');
  }
  if (!failed) ok('the drawn/undrawn boundary stays inside the 88..96 gap no NPC uses');
}

// ── 7b. the job range lines up with the job list ──────────────────────────
// gfx 0..JOB_LAST are labelled from JOB_NAMES. If JOB_LAST runs past the end
// of that list the catalog prints "undefined (job)" for real NPC sprites, and
// gfx 22/23 (58 placements between them) stop being townsfolk.
{
  if (G.JOB_LAST + 1 !== JOB_NAMES.length) {
    bad(`JOB_LAST=${G.JOB_LAST} but JOB_NAMES has ${JOB_NAMES.length} entries — ` +
        'the job range and the job list disagree');
  } else ok(`job range 0..${G.JOB_LAST} matches JOB_NAMES exactly (${JOB_NAMES.length} jobs)`);
}

// ── 8. every placed NPC resolves ──────────────────────────────────────────
{
  let people = 0, objects = 0, undrawn = 0, total = 0;
  for (let mapId = 0; mapId < 512; mapId++) {
    let md; try { md = loadMap(rom, mapId); } catch { continue; }
    for (const n of md.npcs || []) {
      total++;
      const k = G.kindForGfx(gfx(n.id));
      if (k === 'undrawn') undrawn++;
      else if (k === 'object') objects++;
      else people++;
      const o = off(gfx(n.id));
      if (o !== null && (o < 0 || o + 16 > rom.length)) bad(`id ${n.id} on map ${mapId} resolves outside the ROM`);
    }
  }
  if (total < 1000) bad(`only ${total} NPC placements read — the map NPC table stopped decoding`);
  else ok(`${total} placements resolve: ${people} people/job, ${objects} object, ${undrawn} undrawn markers`);
}

// ── the sprite palettes an NPC is drawn with ──────────────────────────────
//
// MEASURED off the PPU by `tools/ff3-npc-palette.mjs`: warp in, read
// $3F10-$3F1F, and read OAM. Every map NPC draws its TOP half on sprite palette
// 3 and its BOTTOM half on sprite palette 2 — there is NO per-NPC selection.
//
// ⛔ The three tables at 0x1110/0x1210/0x1310 are a shared palette LIBRARY, not
// per-NPC data. `src/map-loader.js` indexes them with bytes 8 and 9 of the map's
// own properties (spritePalette6 -> PPU 2, spritePalette7 -> PPU 3). Reading
// them by npcId gives numbers that match nothing on screen.
//
// The pairs below came off the PPU on 16 maps, 16/16 exact, 8 distinct values.
{
  const MEASURED = [
    [7,   [0x0F, 0x12, 0x36], [0x0F, 0x27, 0x30]],
    [114, [0x0F, 0x12, 0x36], [0x0F, 0x26, 0x36]],
    [10,  [0x0F, 0x15, 0x36], [0x0F, 0x29, 0x36]],
    [12,  [0x0F, 0x15, 0x36], [0x0F, 0x2A, 0x36]],
    [18,  [0x0F, 0x15, 0x36], [0x0F, 0x12, 0x36]],
    [6,   [0x0F, 0x15, 0x30], [0x0F, 0x27, 0x30]],
  ];
  const hx = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');
  let bad6 = 0;
  for (const [mapId, want6, want7] of MEASURED) {
    let md; try { md = loadMap(rom, mapId); } catch { bad(`map ${mapId} will not load`); continue; }
    const got6 = md.spritePalettes[0].slice(1), got7 = md.spritePalettes[1].slice(1);
    if (hx(got6) !== hx(want6)) { bad(`map ${mapId} spritePalette6 is ${hx(got6)}, the PPU measured ${hx(want6)}`); bad6++; }
    if (hx(got7) !== hx(want7)) { bad(`map ${mapId} spritePalette7 is ${hx(got7)}, the PPU measured ${hx(want7)}`); bad6++; }
  }
  // ⛔ and the variety must survive: if every map collapsed to one palette the
  // sheet would look "fine" while carrying no information at all.
  const seen = new Set();
  for (let m = 0; m < 512; m++) {
    let md; try { md = loadMap(rom, m); } catch { continue; }
    seen.add(md.spritePalettes[1].slice(1).join(','));
  }
  if (seen.size < 8) bad(`only ${seen.size} distinct sprite palette 7 values across all maps — expected 8+`);
  if (!bad6) ok(`FF3 sprite palettes: ${MEASURED.length} maps match the PPU, ${seen.size} distinct palette-7 values`);
}

if (failed) { console.error(`\ncheck-npc-gfx: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-npc-gfx: OK');
