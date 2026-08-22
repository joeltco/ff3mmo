#!/usr/bin/env node
// check-boss-sprite.mjs — the boss NPC wears its OWN dungeon's art.
//
// ⛔ EVERY DUNGEON'S BOSS USED TO BE THE LAND TURTLE. `drawNpcs` read the single
// global `_landTurtleFrames`, which is an FF2 Adamantoise rip
// (`FF2_ADAMANTOISE_SPRITE = 0x0BF10`) — not FF3 art at all, and not per-dungeon.
// The Cave of Seals' boss is in the FF3 cartridge already: map 106 places npc id
// 62 on the dais, and that id resolves to a map object through NPC_GFX_TABLE.
//
// Chain, each link asserted below:
//   npc id 62 -> NPC_GFX_TABLE[0x1410 + 62] = gfx $4a
//   gfx $4a   -> map object offset $14510  (0x14010 + (203-193)*0x80)
//   $14510    -> 8 tiles = two 16x16 frames
//   flags $EE -> ((f>>2)&3) >= 2 -> sprite palette index 1
//   index 1   -> the FLOOR's spritePalettes[1], which comes from the donor map
//
//   node tools/check-boss-sprite.mjs

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(16, 16), getElementById: () => null, addEventListener() {} };

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || 'FF3-English.nes'));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS, isBossFloor, bossFloorMapId } = await import('../src/data/dungeons.js');
const { resolveBossSkin, BOSS_SKINS } = await import('../src/dungeon/boss-chamber.js');
const { initMapObjectFrames } = await import('../src/sprite-init.js');
const { loadMap } = await import('../src/map-loader.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

// ── the ROM chain ──────────────────────────────────────────────────────────
const NPC_GFX_TABLE = 0x1410, OBJ_BASE = 0x14010;
ok(rom[NPC_GFX_TABLE + 62] === 0x4a, `npc 62 gfx should be $4a, got $${rom[NPC_GFX_TABLE + 62].toString(16)}`);
const objId = 203;
ok(OBJ_BASE + (objId - 193) * 0x80 === 0x14510, 'object 203 should sit at $14510');
let users = 0;
for (let i = 0; i < 256; i++) if (rom[NPC_GFX_TABLE + i] === 0x4a) users++;
ok(users === 1, `gfx $4a should be used by exactly one npc id, found ${users}`);

// map 106 must actually place it, on the dais
const m106 = loadMap(rom, 106);
const djinn = (m106.npcs || []).find((n) => n.id === 62);
ok(!!djinn, 'map 106 no longer places npc 62');
if (djinn) {
  ok(djinn.x === 8 && djinn.y === 18, `npc 62 should stand at (8,18), ROM says (${djinn.x},${djinn.y})`);
  ok((((djinn.flags >> 2) & 3) >= 2 ? 1 : 0) === 1,
     `npc 62 flags $${djinn.flags.toString(16)} should select sprite palette 1`);
}

// ── generated floors carry sprite palettes ─────────────────────────────────
// ⛔ Without these a generated floor has NO sprite palettes and anything drawn
// on it must invent its colours — which is how the boss ended up with
// hand-mixed LAND_TURTLE_PAL constants in the first place.
const SEALS = {
  ...DUNGEONS[0], id: 'seals', base: 2000, floors: 4,
  donorMap: 103, tileset: 0, bossSkinId: 'seals',
  lockedRooms: [], secretRooms: [],
};
const seed = 1755000000000;
const sealsBoss = generateFloor(rom, 3, seed, SEALS);
const altarBoss = generateFloor(rom, 4, seed, DUNGEONS[0]);
ok(!!sealsBoss.spritePalettes, 'generated seals boss floor has no spritePalettes');
ok(!!altarBoss.spritePalettes, 'generated altar boss floor has no spritePalettes');

const donorSP = loadMap(rom, 103).spritePalettes;
ok(JSON.stringify(generateFloor(rom, 1, seed, SEALS).spritePalettes) === JSON.stringify(donorSP),
   'a seals floor\'s spritePalettes must equal its donor map 103\'s');

// ── the frames decode, and are a real two-frame idle ───────────────────────
const skin = resolveBossSkin('seals');
ok(skin.bossSpriteOffset === 0x14510, 'seals boss sprite offset drifted');
ok(skin.bossSpritePalIdx === 1, 'seals boss palette index drifted');
ok(!BOSS_SKINS.crystal.bossSpriteOffset,
   'the crystal skin must NOT name a map object — Altar Cave keeps the FF2 Adamantoise');

// ⛔ Bail with a MESSAGE rather than a TypeError. Dropping `spritePalettes` from
// the result builders is the exact regression this gate exists for, and it must
// read as a finding, not a stack trace.
if (!sealsBoss.spritePalettes) {
  console.error('FAIL:');
  for (const f of fails) console.error('  ' + f);
  console.error('  generated boss floor has no spritePalettes — the boss cannot be painted from the map');
  process.exit(1);
}
const pal = sealsBoss.spritePalettes[skin.bossSpritePalIdx];
const frames = initMapObjectFrames(rom, skin.bossSpriteOffset, pal);
ok(frames.length === 2, `expected 2 frames, got ${frames.length}`);
const pixels = (c) => { const d = c.getContext('2d').getImageData(0, 0, 16, 16).data; return d; };
const inkOf = (c) => { const d = pixels(c); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
const a = inkOf(frames[0]), b = inkOf(frames[1]);
ok(a > 20, `frame 0 is nearly empty (${a} opaque px) — wrong offset or palette`);
ok(b > 20, `frame 1 is nearly empty (${b} opaque px)`);

// ⛔ A SILHOUETTE IS NOT A SPRITE, AND "has opaque pixels" CANNOT TELL THEM
// APART. `_blitTile` indexes NES_SYSTEM_PALETTE itself, so handing it RGB
// triples instead of colour indices makes every lookup `undefined` -> black:
// the Djinn drew as a solid black shape, fully opaque, and passed both the ink
// and the frames-differ checks above. Only rendering it and looking caught it.
// So: count DISTINCT colours.
const coloursOf = (c) => {
  const d = pixels(c); const set = new Set();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) set.add(`${d[i]},${d[i+1]},${d[i+2]}`);
  return set;
};
const c0 = coloursOf(frames[0]);
ok(c0.size >= 2, `frame 0 uses ${c0.size} colour(s) — a one-colour sprite is a silhouette, not art`);
// and they must be the palette's colours, not black-by-accident
const wantRGB = new Set(pal.slice(1).map((ci) => {
  const [r, g, bl] = NES_SYSTEM_PALETTE[ci & 0x3F]; return `${r},${g},${bl}`;
}));
for (const col of c0) ok(wantRGB.has(col), `frame 0 paints ${col}, which is not in the map palette`);

// ⭐ The two frames must DIFFER, and not merely be mirror images. The Land
// Turtle's pair is [normal, hflipped]; the Djinn's is a genuine animation, and a
// decoder bug that read the same 4 tiles twice would pass a "frames differ"
// check only if it also passed this one.
const d0 = pixels(frames[0]), d1 = pixels(frames[1]);
let same = 0, mirror = 0;
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const i = (y * 16 + x) * 4, j = (y * 16 + (15 - x)) * 4;
  if (d0[i] === d1[i] && d0[i+1] === d1[i+1] && d0[i+2] === d1[i+2] && d0[i+3] === d1[i+3]) same++;
  if (d0[i] === d1[j] && d0[i+1] === d1[j+1] && d0[i+2] === d1[j+2] && d0[i+3] === d1[j+3]) mirror++;
}
ok(same < 256, 'the two Djinn frames are identical — the decoder read the same tiles twice');
ok(mirror < 256, 'frame 1 is just frame 0 mirrored — that is the Land Turtle pattern, not FF3 object art');

// ── the draw path must not reach for the global again ──────────────────────
// ⛔ A source check, because `drawNpcs` needs a canvas, a map and a live NPC
// list to exercise; the failure it guards is one identifier. `_landTurtleFrames`
// may still be READ by its getter (the loading screen uses it) but the boss
// draw must go through `getBossFrames()`.
const npcSrc = fs.readFileSync('src/npc.js', 'utf8');
ok(/const frames = getBossFrames\(\);/.test(npcSrc),
   'npc.js boss draw no longer calls getBossFrames() — it is back on the global');
ok(!/const frames = _landTurtleFrames;/.test(npcSrc),
   'npc.js boss draw reads _landTurtleFrames directly again — every dungeon gets the Land Turtle');

const loadSrc = fs.readFileSync('src/map-loading.js', 'utf8');
ok(/setBossFrames\(/.test(loadSrc), 'map-loading no longer sets per-dungeon boss frames');

if (fails.length) {
  console.error('FAIL:');
  for (const f of fails) console.error('  ' + f);
  process.exit(1);
}
console.log(`npc 62 -> gfx $4a -> object $14510, palette idx 1 of [${pal.map(v=>'$'+v.toString(16)).join(',')}]`);
console.log(`two frames decoded: ${a} and ${b} opaque px, ${same}/256 identical, ${mirror}/256 mirrored`);
console.log('the Cave of Seals boss wears its own ROM art');
