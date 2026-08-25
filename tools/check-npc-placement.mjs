#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// check-npc-placement.mjs — no town NPC may stand in tree canopy.
//
// A player filed bug #4, "person in tree": `ur_villager_red` was at (27,25) in
// Ur, which is solid forest. The placement had passed an "openArea (walkable +
// >=3 walkable neighbours)" review — and that review cannot catch this, because
// tree tiles ARE walkable in tileset 4. Walkability says nothing about what a
// tile depicts, so the check has to name the canopy tiles.
//
// CANOPY_TILES is visually derived: rendered with tools/map-png.mjs and read
// off the image. It is per-tileset because metatile ids mean different things
// in different tilesets — do not generalise it without looking at a render.
//
//   node tools/check-npc-placement.mjs

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { loadMap } = await import('../src/map-loader.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { bundleForNpcId } = await import('../src/data/npc-gfx.js');

// tileset -> metatile ids that draw as tree canopy.
const CANOPY_TILES = new Map([
  [4, new Set([0x20, 0x21, 0x22])],   // Ur overworld — verified from a render
]);

const W = 32;
let failed = 0, checked = 0;

for (const [mapId, list] of TOWN_NPCS) {
  let md;
  try { md = loadMap(rom, mapId); } catch (e) {
    console.error(`  ✗ map ${mapId}: failed to load (${e.message})`);
    failed++; continue;
  }
  const canopy = CANOPY_TILES.get(md.tileset);
  for (const npc of list) {
    checked++;
    const { x, y, key } = npc;
    if (x < 0 || x >= W || y < 0 || y >= W) {
      console.error(`  ✗ ${key} on map ${mapId} is off-map at (${x},${y})`);
      failed++; continue;
    }
    const raw = md.tilemap[y * W + x];
    const m = raw < 128 ? raw : raw & 0x7F;
    if (canopy && canopy.has(m)) {
      console.error(`  ✗ ${key} on map ${mapId} stands in tree canopy at (${x},${y}) — tile $${m.toString(16)}`);
      failed++; continue;
    }
    // Also reject a placement that is fully sealed in. The bar is 1, not 2:
    // shop keepers stand BEHIND counters and are enclosed on three sides by
    // design (see the DIR_DOWN counter rule in design-notes#town-keepers), so
    // requiring 2 flags correct placements like `weapon_keeper` on map 5.
    let open = 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W) continue;
      const nraw = md.tilemap[ny * W + nx];
      const nm = nraw < 128 ? nraw : nraw & 0x7F;
      if ((md.collision[nm] & 0x07) !== 3 && !(md.collision[nm] & 0x80)) open++;
    }
    if (open < 1) {
      console.error(`  ✗ ${key} on map ${mapId} at (${x},${y}) is sealed in — no open neighbours`);
      failed++; continue;
    }
    console.log(`  ✓ ${key} — map ${mapId} (${x},${y}) tile $${m.toString(16)}, ${open} open neighbours`);
  }
}

if (!checked) { console.error('check-npc-placement: no NPCs found — has TOWN_NPCS moved?'); process.exit(2); }

// ── every NPC must use a sprite bundle its MAP ACTUALLY LOADS ──────────────
// FF3 is CHR-RAM: a walk bundle only exists on screen if the map copied it into
// sprite memory. Picking a bundle that looks like a villager on a contact sheet
// puts a sprite in the town that the real game never loads there — v1.7.973
// dressed Ur in seven bundles from other towns' casts.
//
// The verified sets below come from the PPU itself. RE-VERIFIED 2026-08-14
// against live sprite memory on all seven Ur maps — every entry confirmed, no
// edits needed:
//   MAPS=4,5,6,7,8,9,114 node tools/monscan/map-bundles.cjs
//
// ⛔ Use that tool, NOT `nes-run.mjs --newgame --warp`, which produced this
// table originally and can no longer reach a map: its name-entry heuristic
// sticks at blueness 0.354 forever, so the warp fires from the title screen and
// reports whatever the boot logo left in the PPU. The monscan boot reaches the
// field reliably, but two things must happen before the warp or the result is
// garbage — leave the battle it lands in (warping out of one runs the CPU into
// an invalid opcode at $9a59), and clear the post-battle dialogue (the engine
// rewrites $AB every frame a box is open, eating the flag).
//
// Offsets here are header-INCLUSIVE (romRaw keeps the 16-byte iNES header); the
// PPU tool reports file offsets, so 0x1E000 there is 0x01E010 here.
// Re-run if a map's cast changes; do not edit by hand.
const LOADED_BUNDLES = new Map([
  [114, new Set([0x01DF10, 0x01E010, 0x01E210, 0x01E310, 0x01E510])],  // town
  [9,   new Set([0x01DF10, 0x01E010, 0x01E110, 0x01E610, 0x01E710])],  // tavern
  [8,   new Set([0x01E010, 0x01E210])],                                // inn
  [7,   new Set([0x01E010, 0x01E210, 0x01EC10])],                      // elder, upper
  [6,   new Set([0x01EC10])],                                          // elder, ground
  [5,   new Set([0x01E610])],                                          // weapon shop
  [4,   new Set([0x01E610])],                                          // armor shop
  [2,   new Set([0x01E210])],                                          // house

  // ⛔ KAZUS AND SASUNE WERE NEVER IN THIS TABLE. The bundle rule only ever
  // covered Ur, so every Kazus and Castle Sasune placement has been ungated
  // since it shipped — a wrong bundle there would have drawn a face the map
  // never loads and nothing would have said so. MEASURED 2026-08-23 with
  // `MAPS=10,11,12,13,14,16,17,18,25,26,27,29 node tools/monscan/map-bundles.cjs`
  // (that tool prints HEADER-LESS offsets; these carry the +0x10 the specs use,
  // which map 2 cross-checks — it was in this table already and the measurement
  // reproduced it).
  [10,  new Set([0x01DF10, 0x01E010, 0x01D910, 0x01E210])],            // Kazus town
  // ⭐ 0x01D910 is CID'S OWN SPRITE and is ff3mmo's addition, not a measurement.
  // The cartridge does not place Cid inside the pub, so map 12 never loads his
  // bundle — that is a fact about the ROM's cast, not a limit on the room. He
  // is a named character we place deliberately; the rest of this table stays
  // measured. Do not use this line as licence to hand-add ordinary townsfolk.
  [12,  new Set([0x01DF10, 0x01E010, 0x01ED10, 0x01E410, 0x01D910])],  // Kazus pub/inn
  [13,  new Set([0x01E010])],                                          // Kazus house
  [14,  new Set([0x01E210])],                                          // Kazus house
  // ⭐ 0x01E610 is UR'S SHOP-KEEPER sprite, added on purpose so Kazus's weapon
  // and armor shops read as shops instead of houses with a villager in them.
  // ff3mmo's addition, NOT a measurement — the rest of this table stays
  // measured off the PPU.
  [16,  new Set([0x01DF10, 0x01ED10, 0x01E610])],                      // Kazus weapon
  [17,  new Set([0x01DF10, 0x01ED10, 0x01E610])],                      // Kazus armor
  [18,  new Set([0x01E010, 0x01EE10])],                                // Sasune courtyard
  [25,  new Set([0x01ED10, 0x01EE10])],                                // Sasune inner hall
  [26,  new Set([0x01ED10, 0x01EE10])],                                // Sasune (shares 25's roster)
  [27,  new Set([0x01ED10, 0x01EE10])],                                // Sasune (shares 25's roster)
  [29,  new Set([0x01ED10, 0x01EE10, 0x01EF10])],                      // Sasune throne room
  // ⛔ Map 11 loads NO townsfolk bundle at all — an empty set is the measurement,
  // not a gap. Anyone placed there renders as tilemap noise.
  [11,  new Set()],
]);

{
  let bundleBad = 0;
  for (const [mapId, allowed] of LOADED_BUNDLES) {
    const list = TOWN_NPCS.get(mapId) || [];
    for (const e of list) {
      const off = e.spec && e.spec.romOffset;
      if (off == null || allowed.has(off)) continue;
      console.error(`  ✗ ${e.key} (map ${mapId}) uses bundle 0x${off.toString(16).toUpperCase()}, ` +
        `which map ${mapId} never loads into sprite memory`);
      bundleBad++;
    }
  }
  if (bundleBad) failed += bundleBad;
  else console.log(`  ✓ every NPC uses a bundle its map actually loads`);

  // Two NPCs may share a sprite bundle ONLY where the CARTRIDGE posts identical
  // people at fixed spots.
  //
  // The blanket "one person per bundle" rule this replaces came from a real
  // report — "SEEING DOUBLE NPCS" — but that was Ur's WANDERERS: two identical
  // faces strolling around the same town, which reads as a rendering bug. Four
  // identical guards standing at four gate posts does not; it is what Castle
  // Sasune looks like in FF3, where the ROM lists FOUR id60 records on one
  // bundle. The blanket rule was capping the castle at two people.
  //
  // So the exception is narrow and provable, never a judgement call:
  //   * every sharer stands still (`wander` off) — a duplicate that walks is
  //     the original bug
  //   * every sharer sits EXACTLY on a ROM record's coordinate, and that
  //     record's own id resolves to the same bundle — i.e. the cartridge puts
  //     this person, wearing this sprite, on this tile
  // Anything else is still a twin.
  let twins = 0;
  for (const [mapId, list] of TOWN_NPCS) {
    const byBundle = new Map();
    for (const e of list) {
      const off = e.spec && e.spec.romOffset;
      if (off == null) continue;
      if (!byBundle.has(off)) byBundle.set(off, []);
      byBundle.get(off).push(e);
    }
    let md = null;
    for (const [off, sharers] of byBundle) {
      if (sharers.length < 2) continue;
      md = md || loadMap(rom, mapId);
      for (const e of sharers) {
        const romHere = md.npcs.some((n) => n.x === e.x && n.y === e.y && bundleForNpcId(rom, n.id) === off);
        const still = !(e.spec && e.spec.wander);
        if (romHere && still) continue;
        console.error(`  ✗ map ${mapId}: ${e.key} shares bundle 0x${off.toString(16).toUpperCase()} with ` +
          `${sharers.filter((o) => o !== e).map((o) => o.key).join(', ')} but ` +
          (romHere ? 'WANDERS — a duplicate that walks is the "double NPC" bug'
                   : `is not on a ROM record for that bundle (${e.x},${e.y})`));
        twins++;
      }
    }
  }
  if (twins) failed += twins;
  else console.log(`  ✓ shared bundles only where the ROM posts identical people`);


  // Every NPC wears the palette of the MAP THEY STAND ON. This gate proved
  // rooms and bundles and said nothing about colour, which is how the elder's
  // house shipped with the inn's palette on everyone in it — a white-robed
  // attendant rendered pink, and the elder's kin pink-haired instead of blonde.
  // `data/town-npcs.js` hard-codes one pair for every interior under a comment
  // claiming Ur's buildings all share it; the ROM says maps 4, 6 and 7 do not.
  //
  // Compared through `npc.js#mapPalettesForSpec` — the function the game
  // actually places with — never a copy of the rule. Slot 0 is the transparent
  // index the renderer never paints, so only slots 1-3 are compared.
  // A WANDERER must start where it can actually move. npc.js only steps onto
  // tiles with >= MIN_OPEN_NEIGHBOURS open neighbours, so one placed on a
  // doorway (1 neighbour) is stuck there for the life of the save — which is
  // exactly what shipped in v1.8.13, a townsman standing in the inn's door.
  // Uses the game's OWN predicate, never a copy.
  // No NAMED STORY CHARACTER is placed as an ordinary NPC. Their bundles sit in
  // the walk range and maps load them like any other, so they look available on
  // the sprite-catalog sheet — Cid has been placed as a shop keeper, as an inn
  // ghost, and as a wandering townsman across three versions.
  {
    const { STORY_SPRITE_BUNDLES, RESERVED_BUNDLES } = await import('../src/data/town-npcs.js');
    let story = 0;
    for (const [mapId, list] of TOWN_NPCS) {
      for (const e of list) {
        // ⭐ RESERVED, not banned (v1.10.66). 0x01ED10 is the cursed-ghost sprite
        // and it is CID'S — he wears it in the Kazus inn until his quest is
        // handed in. Reserving it by npc key keeps every other villager off it
        // while letting the one character it belongs to use it.
        if (RESERVED_BUNDLES.get(e.spec && e.spec.romOffset) === e.key) continue;
        const who = e.spec && STORY_SPRITE_BUNDLES.get(e.spec.romOffset);
        if (!who) continue;
        console.error(`  ✗ map ${mapId}: ${e.key} uses 0x${e.spec.romOffset.toString(16).toUpperCase()}, ` +
          `which is ${who} — a named story character, not a villager`);
        story++;
      }
    }
    if (story) failed += story;
    else console.log('  ✓ no named story character is placed as an ordinary NPC');
  }

  // Nobody is FROZEN. `npc.js#addSceneNpc` resolves
  //   mode = wander ? 'pause' : (animate ? 'idle-march' : 'static')
  // so a spec with wandering off and animation unset is a statue of a person.
  // The campfire man shipped that way in v1.8.17 — `wander: false` was passed
  // and nothing set `animate`, which is why townNpc now defaults it on.
  // An intentional statue can opt out with `frozen: true`.
  let frozen = 0;
  for (const [mapId, list] of TOWN_NPCS) {
    for (const e of list) {
      if (!e.spec || e.spec.frozen) continue;
      if (e.spec.wander || e.spec.animate) continue;
      console.error(`  ✗ map ${mapId}: ${e.key} neither wanders nor animates — it stands ` +
        'perfectly still while every other NPC breathes (set animate, or frozen: true if deliberate)');
      frozen++;
    }
  }
  if (frozen) failed += frozen;
  else console.log('  ✓ no NPC is frozen — everyone wanders or marches in place');

  const { isOpenAreaTile, MIN_OPEN_NEIGHBOURS } = await import('../src/data/npc-walk-area.js');
  let stuck = 0;
  for (const [mapId, list] of TOWN_NPCS) {
    const md = loadMap(rom, mapId);
    for (const e of list) {
      if (!e.spec || !e.spec.wander) continue;      // keepers stand still on purpose
      if (isOpenAreaTile(md, e.x, e.y)) continue;
      console.error(`  ✗ map ${mapId}: ${e.key} WANDERS but starts at (${e.x},${e.y}), which has ` +
        `fewer than ${MIN_OPEN_NEIGHBOURS} open neighbours — it can never step off and will ` +
        `stand there forever (a doorway, usually)`);
      stuck++;
    }
  }
  if (stuck) failed += stuck;
  else console.log('  ✓ every wandering NPC starts somewhere it can actually walk');

  const { mapPalettesForSpec } = await import('../src/data/npc-palette.js');
  // ⛔ The DATA check below runs the rule itself, so it passes whether or not
  // the game applies it — reverting the fix left this gate green until this
  // wiring assertion was added. `placeTownNpcs` must hand every spec through
  // `mapPalettesForSpec` on its way to `addSceneNpc`; comments are stripped so
  // the sentence describing the call cannot satisfy the check.
  {
    const npcSrc = fs.readFileSync(new URL('../src/npc.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const place = (npcSrc.match(/export function placeTownNpcs[\s\S]*?\n}/) || [''])[0];
    if (!/addSceneNpc\([^)]*mapPalettesForSpec\(/.test(place)) {
      console.error('  ✗ placeTownNpcs does not run specs through mapPalettesForSpec — ' +
        'every interior NPC would wear the palette hard-coded in data/town-npcs.js ' +
        "instead of its own map's");
      failed++;
    } else console.log('  ✓ placeTownNpcs repaints every spec with the map\'s palettes');
  }
  let wrongPal = 0;
  for (const [mapId, list] of TOWN_NPCS) {
    const md = loadMap(rom, mapId);
    const pals = md && md.spritePalettes;
    if (!pals || !pals[0] || !pals[1]) continue;
    for (const e of list) {
      if (!e.spec || !e.spec.palTop || !e.spec.palBtm) continue;
      const placed = mapPalettesForSpec(e.spec, md);
      const badTop = [1, 2, 3].some(i => placed.palTop[i] !== pals[1][i]);
      const badBtm = [1, 2, 3].some(i => placed.palBtm[i] !== pals[0][i]);
      if (badTop || badBtm) {
        const hex = (a) => a.map(v => '0x' + (v | 0).toString(16).padStart(2, '0')).join(',');
        console.error(`  ✗ map ${mapId}: ${e.key} is placed with ` +
          `${badTop ? `head [${hex(placed.palTop)}] but the map says [${hex(pals[1])}]` : ''}` +
          `${badTop && badBtm ? ' and ' : ''}` +
          `${badBtm ? `body [${hex(placed.palBtm)}] but the map says [${hex(pals[0])}]` : ''}` +
          ` — wrong colours on screen`);
        wrongPal++;
      }
    }
  }
  if (wrongPal) failed += wrongPal;
  else console.log(`  ✓ every NPC wears its own map's sprite palettes`);
}

if (failed) { console.error(`\ncheck-npc-placement: FAIL (${failed} of ${checked})`); process.exit(1); }
console.log(`\ncheck-npc-placement: OK (${checked} NPCs)`);
