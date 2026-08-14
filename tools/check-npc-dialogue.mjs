#!/usr/bin/env node
// check-npc-dialogue.mjs — FF3's script stays decoded, and NPCs keep their lines.
//
// Three things are pinned here, each anchored on something MEASURED rather than
// on the decoder agreeing with itself:
//
//   1. the DTE table at 0x75FA1 (two parallel 52-byte arrays) still expands
//   2. stringId = npcId + 0x202
//   3. the specific lines read off the PPU nametable in a running game
//
// For (3): warping to Ur's elder house (map 7) and walking to each of its three
// NPCs produced Topapa / Nina / Tomak at the ROM's own left/centre/right
// coordinates, and Kazus's inn (map 12) produced the Sealed-Cave line for the
// NPC standing at (8,28). Those four readings are the ground truth; if the
// decoder or the base drifts, they stop matching.
//
//   node tools/check-npc-dialogue.mjs

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), getElementById: () => null, addEventListener() {} };

import { loadRom, decodeString, buildDte, DTE_COUNT } from './lib/ff3-text.mjs';
const { loadMap } = await import('../src/map-loader.js');
const G = await import('../src/data/npc-gfx.js');

const rom = loadRom();
const BASE = 0x202;

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);

// ── 1. the DTE table ──────────────────────────────────────────────────────
// Stored as two parallel arrays, so an "adjacent pair" reading finds nothing.
// These entries are what make the script read as English at all.
{
  const dte = buildDte(rom);
  if (dte.length !== DTE_COUNT) bad(`DTE table has ${dte.length} entries, expected ${DTE_COUNT}`);
  const want = { 1: 'th', 2: 'he', 5: 'in', 8: 'an', 10: 're', 25: 'on', 30: 'ed', 50: 'it' };
  for (const [i, v] of Object.entries(want)) {
    if (dte[i] !== v) bad(`DTE entry ${i} is "${dte[i]}", expected "${v}"`);
  }
  const junk = dte.filter(p => p.includes('?')).length;
  if (junk > 2) bad(`${junk} DTE entries contain unreadable bytes — the table base has drifted`);
  if (!failed) ok(`DTE table decodes (${DTE_COUNT} entries, "th" "he" "in" "an" "re" "on" "ed" "it")`);
}

// ── 2. lines read off a RUNNING game ──────────────────────────────────────
// Measured by warping in and reading the message box off the PPU nametable.
{
  const MEASURED = [
    [19, /^Elder Topapa, the man who/, 'Ur elder house, centre NPC'],
    [17, /^Nina, the adoptive mother/, 'Ur elder house, left NPC'],
    [18, /^Tomak, a village Elder/, 'Ur elder house, right NPC'],
    [43, /Djinn that we had .*banished into the Sealed .*Cave/, 'Kazus inn, NPC at (8,28)'],
  ];
  for (const [npcId, re, where] of MEASURED) {
    const t = decodeString(rom, npcId + BASE);
    if (!re.test(t)) {
      bad(`NPC ${npcId} (${where}) decodes to "${t.slice(0, 60)}…" — ` +
          'that is not the line the running game displayed');
    }
  }
  if (!failed) ok(`all ${MEASURED.length} nametable-measured lines still resolve from npcId + 0x${BASE.toString(16)}`);
}

// ── 3. the base is the base ───────────────────────────────────────────────
// A shifted base still produces readable English for most ids, so assert the
// exact offset rather than "the text looks fine".
{
  if (decodeString(rom, 19 + BASE) === decodeString(rom, 19 + BASE + 1)) {
    bad('neighbouring dialogue ids are identical — the string table is not being read');
  }
  const off1 = decodeString(rom, 19 + BASE + 1);
  if (/^Elder Topapa/.test(off1)) bad('base+1 also yields Topapa — the base is not pinned');
  else ok('the +0x202 base is exact (a one-id shift changes the speaker)');
}

// ── 4. the Kazus ghosts ───────────────────────────────────────────────────
// gfx 45 (0x1ED10) is the GENERIC GHOST, not "Cid (ghost form)" as
// town-npcs.js labels it. Its users are the cursed townsfolk of Kazus, and
// their own dialogue says so. This is the evidence for that correction.
{
  const ids = new Set();
  for (let m = 0; m < 512; m++) {
    let md; try { md = loadMap(rom, m); } catch { continue; }
    for (const n of md.npcs || []) if (G.gfxForNpcId(rom, n.id) === 45) ids.add(n.id);
  }
  if (ids.size < 5) bad(`gfx 45 has only ${ids.size} users — expected the full Kazus cursed cast`);
  const cursed = [...ids].filter(id => /curse|ghost|Djinn/i.test(decodeString(rom, id + BASE)));
  if (!cursed.length) {
    bad('no NPC wearing gfx 45 mentions the curse, the Djinn or ghosts — ' +
        'the ghost identification rests on that');
  } else ok(`gfx 45 (0x1ED10) worn by ${ids.size} ids; ${cursed.length} of them speak of the curse/Djinn — it is the ghost`);
}

// ── 5. coverage ───────────────────────────────────────────────────────────
{
  let withText = 0, total = 0;
  for (let id = 1; id <= 255; id++) {
    const g = G.gfxForNpcId(rom, id);
    if (G.kindForGfx(g) === 'undrawn' || G.kindForGfx(g) === 'object') continue;
    total++;
    if (decodeString(rom, id + BASE)) withText++;
  }
  if (withText < total * 0.8) {
    bad(`only ${withText}/${total} drawn NPC ids decode to any text — the pointer table has drifted`);
  } else ok(`${withText}/${total} drawn NPC ids have dialogue`);
}

if (failed) { console.error(`\ncheck-npc-dialogue: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-npc-dialogue: OK');
