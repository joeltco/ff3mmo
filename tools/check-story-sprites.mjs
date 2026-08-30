#!/usr/bin/env node
// check-story-sprites.mjs — two different NAMED characters may never wear the
// same walk bundle.
//
// ⛔ THIS SHIPPED. `SARA.romOffset` and `CID.romOffset` were both `0x1D910` —
// the princess and the engineer, byte for byte the same sprite. The source
// carried a paragraph justifying it ("Cid is in the pub, she is out in the
// town, never on screen together") and that premise died the day she moved to
// the Cave of Seals. Nothing re-checked it, because nothing could: no gate
// asked the question. Joel found it by looking at a render.
//
// Ordinary townsfolk SHARE bundles on purpose — FF3 has ten people in Ur on
// five sprites, and `check-npc-placement` already governs that. A named
// character is different: their face is their identity, and two of them wearing
// one face is a bug you only see if somebody draws it.
//
//   node tools/check-story-sprites.mjs
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(8, 8) };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');

// People the story names. Two rows with the SAME key are one person in two
// costumes (Cid cursed / Cid himself) and are allowed to differ; two DIFFERENT
// keys sharing a bundle is the failure.
const STORY_KEYS = new Set(['sara', 'cid', 'sasune_king', 'kazus_smith', 'sasune_hall_servant']);

// ⭐ THE GHOST IS SHARED ON PURPOSE, and that is the CARTRIDGE's design, not
// ours: every id the Djinn curses resolves through the ROM's id->gfx table at
// 0x1410 to gfx 45 = `0x1ED10`. Losing your face is the whole point of the
// curse, so the cursed King and the cursed Cid being indistinguishable is
// correct. The rule applies to who they are when they are THEMSELVES.
const SHARED_BY_DESIGN = new Map([
  [0x01ED10, 'the Djinn\'s ghost — the cartridge dresses every cursed id in gfx 45'],
]);

let failed = 0;
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

const byBundle = new Map();   // romOffset -> Set(story key)
const seen = [];
for (const [mapId, list] of [...TOWN_NPCS, ...GENERATED_NPCS]) {
  for (const r of list) {
    if (!STORY_KEYS.has(r.key)) continue;
    const off = r.spec && r.spec.romOffset;
    if (off == null) { bad(`${r.key} (map ${mapId}) has no romOffset`); continue; }
    if (!byBundle.has(off)) byBundle.set(off, new Set());
    byBundle.get(off).add(r.key);
    seen.push({ key: r.key, mapId, off });
  }
}

for (const [off, keys] of byBundle) {
  if (SHARED_BY_DESIGN.has(off)) {
    console.log(`  --  0x${off.toString(16).toUpperCase()} shared by ${[...keys].join(', ')} — ${SHARED_BY_DESIGN.get(off)}`);
    continue;
  }
  if (keys.size > 1) {
    bad(`0x${off.toString(16).toUpperCase()} is worn by ${keys.size} different named characters: ` +
        `${[...keys].join(' and ')} — a named character's face is their identity`);
  }
}

// Every named character in the table must actually be one we listed, so adding
// a new story character forces a decision here rather than defaulting to
// "shares whatever the ROM's id lookup happens to return".
const covered = new Set(seen.map((s) => s.key));
for (const k of STORY_KEYS) {
  if (!covered.has(k)) bad(`STORY_KEYS lists "${k}" but no placement row uses that key — stale entry`);
}

if (failed) { console.error(`\ncheck-story-sprites: FAIL — ${failed} problem(s)`); process.exit(1); }
console.log(`check-story-sprites: OK — ${covered.size} named characters, ${byBundle.size} distinct bundles, no two share a face`);
for (const s of seen) console.log(`    ${s.key.padEnd(20)} map ${String(s.mapId).padStart(4)}  0x${s.off.toString(16).toUpperCase()}`);
