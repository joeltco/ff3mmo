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
// map-bundles.cjs — which sprite bundles a map ACTUALLY loads, read off the PPU.
//
// `check-npc-placement.mjs` gates every NPC against a hand-maintained
// LOADED_BUNDLES table with the note "re-run it if a map's cast changes; do not
// edit by hand". The tool that produced it (`nes-run.mjs --newgame --warp`)
// cannot get past FF3's name entry any more — its blueness heuristic sticks at
// 0.354 forever — so the table has been unverifiable for a while, which is the
// same as unverified.
//
// This boots through the monscan choreography (the one that reliably reaches a
// battle, so it definitely reaches the overworld), warps with the ROM's own
// go-to-map path, then traces live sprite memory back to ROM offsets and groups
// the hits into 16-tile bundles.
//
//   node tools/monscan/map-bundles.cjs 7
//   MAPS=4,5,6,7,8,9,114 node tools/monscan/map-bundles.cjs
//
// FF3 is CHR-RAM: a bundle is DECOMPRESSED into sprite memory, so a ROM offset
// is not a PPU address and a contact sheet cannot answer this. Only the PPU can.

const { Nes, BTN } = require('./nes.cjs');
const { readFileSync } = require('fs');

const ROM_PATH = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const rom = readFileSync(ROM_PATH);
const MAPS = (process.env.MAPS || process.argv[2] || '7')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

// Index every 16-byte tile in the ROM so a PPU tile can be traced home. Tiles
// repeat (blank tiles especially), so a hit is only meaningful in bulk — that
// is why the result is reported as "n of 16 tiles of bundle X".
function buildIndex() {
  const idx = new Map();
  for (let off = 16; off + 16 <= rom.length; off += 16) {
    const key = rom.subarray(off, off + 16).toString('binary');
    if (!idx.has(key)) idx.set(key, []);
    const a = idx.get(key);
    if (a.length < 64) a.push(off);
  }
  return idx;
}
const INDEX = buildIndex();

function run(n, nes) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, hold = 8, after = 24) {
  nes.nes.buttonDown(1, BTN[b]); run(hold, nes);
  nes.nes.buttonUp(1, BTN[b]); run(after, nes);
}

function bootToWorld(nes) {
  // The monscan choreography: mash START through the title/intro, then A/down
  // blocks to clear name entry and the opening scene.
  run(300, nes);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let block = 0; block < 10; block++) {
    for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25);
    press(nes, 'down', 8, 40);
  }
  run(400, nes);

  // The monscan choreography exists to reach a BATTLE, and it does — warping
  // out of one pokes the engine into an invalid opcode ($9a59). Get back to the
  // field first: Run is the third command (Attack / Guard / Run / Item), so
  // down,down,a per character, repeated until the sprite count drops back to
  // field levels.
  for (let tries = 0; tries < 40 && inBattle(nes); tries++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(240, nes);
  }
  // Post-battle dialogue is open, and the engine rewrites $AB every frame it is
  // in a dialogue/menu state — the warp flag is eaten before the map-load poll
  // ever sees it. Clear the box, then take a few steps so the engine is idle on
  // the field.
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30);
  run(180, nes);
}

// A battle fills OAM; the field shows the party leader and a few NPCs.
function inBattle(nes) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++;
  return c > 12;
}

// The ROM's own "GO TO MAP": event opcode $FA writes the destination to $0700
// and raises $AB = $80; the engine clears $AB once it accepts the load. Hold
// both across a window — a single poke gets eaten while the engine is in a
// menu/dialogue state.
// POKE=0x609d holds the Kazus curse flag across the warp, so the map loads as
// the LIVING town. Diffing the bundle sets cursed-vs-living is what says
// whether ghosts have their own sprites or are a palette on the same ones —
// and that has to be measured, not assumed.
const POKE = (() => {
  if (!process.env.POKE) return null;
  const [a, v] = String(process.env.POKE).split(':');
  return { addr: parseInt(a, 16), value: v ? parseInt(v, 16) : 0xFF };
})();

function warp(nes, mapId, holdFrames = 300) {
  const cpu = nes.nes.cpu;
  if (POKE) {
    cpu.mem[POKE.addr] = POKE.value;
    if (cpu.load(POKE.addr) !== POKE.value) console.log('  !! poke did not land — result is meaningless');
  }
  for (let f = 0; f < holdFrames; f++) {
    if (POKE) cpu.mem[POKE.addr] = POKE.value;
    cpu.mem[0x0700] = mapId & 0xFF;
    cpu.mem[0x00AB] = 0x80;
    nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) {
      for (let k = 0; k < 90; k++) { if (POKE) cpu.mem[POKE.addr] = POKE.value; nes.nes.frame(); }
      return true;
    }
  }
  return false;
}

// PPU sprite memory is $1000-$1FFF: tiles 256..511 of the pattern space.
function bundlesInPpu(nes) {
  const vram = nes.nes.ppu.vramMem;
  const hits = new Map();      // bundle base -> count of its 16 tiles present
  let blank = 0, unknown = 0;
  for (let t = 256; t < 512; t++) {
    const base = t * 16;
    const tile = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) tile[i] = vram[base + i] & 0xFF;
    if (tile.every(v => v === 0)) { blank++; continue; }
    const offs = INDEX.get(tile.toString('binary'));
    if (!offs) { unknown++; continue; }
    // A tile can appear in several bundles; credit every candidate and let the
    // 16-tile totals separate a real load from a coincidence.
    const seen = new Set();
    for (const off of offs) {
      const bundle = off & ~0xFF;
      if (seen.has(bundle)) continue;
      seen.add(bundle);
      hits.set(bundle, (hits.get(bundle) || 0) + 1);
    }
  }
  return { hits, blank, unknown };
}

for (const mapId of MAPS) {
  const nes = new Nes(ROM_PATH);
  bootToWorld(nes);
  if (process.env.SHOT) nes.screenshot(process.env.SHOT + `/boot-${mapId}.png`);
  if (inBattle(nes)) { console.log(`map ${mapId}: still in a battle after fleeing — skipped`); continue; }
  let took = false;
  try { took = warp(nes, mapId); }
  catch (e) { console.log(`map ${mapId}: warp CRASHED the machine (${e.message})`); continue; }
  run(120, nes);
  // The post-warp frame is the visual confirmation that the warp landed where
  // it claims — a bundle list from the wrong map looks perfectly plausible.
  if (process.env.SHOT) nes.screenshot(process.env.SHOT + `/map-${mapId}.png`);
  const { hits, blank, unknown } = bundlesInPpu(nes);
  const complete = [...hits].filter(([, c]) => c >= 16).map(([b]) => b).sort((a, b) => a - b);
  const partial = [...hits].filter(([, c]) => c >= 8 && c < 16).sort((a, b) => b[1] - a[1]);
  console.log(`\nmap ${mapId}: warp ${took ? 'accepted' : 'NOT ACCEPTED — result is meaningless'}` +
    `  (${blank} blank, ${unknown} untraceable of 256 sprite tiles)`);
  console.log('  COMPLETE (16/16): ' +
    (complete.length ? complete.map(b => '0x' + b.toString(16).toUpperCase()).join(' ') : 'none'));
  if (partial.length) {
    console.log('  partial: ' + partial.slice(0, 8)
      .map(([b, c]) => `0x${b.toString(16).toUpperCase()}(${c}/16)`).join(' '));
  }
}
