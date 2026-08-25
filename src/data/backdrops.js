// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// The BACKDROP REGISTRY — which of FF3's 24 backdrop strips a place uses.
//
// `battle-bg.js` is the ROM DECODER: it turns a backdrop id into pixels. This
// file is the other half — WHERE each id is used. Keeping them apart is the
// point: a new place to show a backdrop adds a row here and touches no decoder,
// and a correction to the decoding touches no placement.
//
// ⛔ A REGISTRY KEYED BY DATA, NEVER A TERNARY. `setupTopBox` used to be three
// hand-written branches, each with its own copy of the lookup arithmetic — and
// one of them (the overworld) just gave up and hardcoded 0. That is exactly the
// shape that lets a case go unhandled while looking finished.
// ═══════════════════════════════════════════════════════════════════════════
import { battleBgIdForMap, battleBgIdForWorldProps, BATTLE_BG_COUNT } from '../battle-bg.js';
import { dungeonForMapId, floorIndexForMapId, isDungeonMapId } from './dungeons.js';
import { resolveDungeonDonor } from '../dungeon/boss-chamber.js';

export { BATTLE_BG_COUNT };

// ── The 24 strips ───────────────────────────────────────────────────────────
//
// ⛔ THE CARTRIDGE DOES NOT NAME ITS BACKDROPS, so every row carries the
// evidence its name rests on, and the evidence is ranked:
//
//   ⭐ ROM-NAMED     a map that selects this strip carries a name banner
//                    (map property byte 2 -> string 0x100+b2)
//      TILE-MEASURED the world tiles that select it, with their passability
//   ⚠ FROM THE RENDER  nothing corroborates it — I looked at the strip
//
// ⛔ FIVE NAMES CAME OFF THE ART AND WERE WRONG: `hills` was the MOUNTAIN strip,
// `ice` was the CRYSTAL CHAMBER, `mountain` was a LAKE (foot-blocked,
// canoe-passable), `brick water` was the SEWERS and `deep water` was the DARK
// WORLD. Joel caught four of them by eye. Ask the ROM for a name before
// describing a picture.
//
// ⛔⛔ AND THE REASON THE LAST TWO SURVIVED: `tools/map-names.mjs` swept only
// maps 0-255, so every strip used by the back half of the game came back "no
// named maps" and got a description instead. FF3 has maps to 511. A sweep that
// stops early does not report a gap — it reports a clean result. Eight strips
// were labelled "⚠ from the render"; seven of them had ROM names all along.
// Only backdrop 23 really has none.
//
// `biome` is set only where a WORLD TILE selects the strip. A backdrop with no
// biome is an interior/dungeon strip and is chosen by map id, never by terrain.
export const BACKDROPS = [
  // ── Overworld terrain. `biome` is set ONLY where a world tile selects it. ──
  //
  // ⛔ AN IMPASSABLE TILE'S BYTE 2 IS NEVER SEEN. You cannot start a fight
  // standing on a tile you cannot stand on, so the byte is dead there — the same
  // way byte 2 on a warp tile is a destination, not a backdrop. World 0's
  // MOUNTAIN tiles ($05 $06 $07 $15 $16 $17, byte1 $1f, 855 tiles on the map)
  // carry byte 2 = 0 and it means nothing. Do not read them as evidence that
  // mountains fight on grassland.
  { id: 0,  name: 'grassland', biome: 'grass',
    evidence: 'world tiles byte1 $46 (foot-walkable), 2410+ on the map; also the fallback for 268 map slots incl. Ur, Kazus, Canaan' },
  { id: 1,  name: 'desert', biome: 'desert',
    evidence: 'world tiles $02 $12 $13 $22 $23, byte1 $46 foot-walkable, 377 on the map; renders tan dunes' },
  { id: 2,  name: 'forest', biome: 'forest',
    evidence: 'world tiles $0a-$0c $1a-$1c $2a-$2c, byte1 $6e foot-walkable, 717 on the map; renders dark trees' },
  { id: 3,  name: 'marsh', biome: 'marsh',
    evidence: '⚠ NAME FROM THE RENDER ONLY (reeds over water). World tiles $28 $29 $38 $39 are foot-walkable but NONE appears on world 0\'s map, so this strip is unreachable and nothing corroborates the name' },
  { id: 4,  name: 'lake', biome: 'lake',
    evidence: '⭐ world tiles $08 $09 $18 $19 $3a — FOOT BLOCKED, canoe and ship pass. All 75 are one body of water at world 81-87,38-40, ringed by mountains with a cave mouth on its north shore (rendered: tools/world-shot.mjs 84,39). NOT a mountain strip — that was a guess off the art and Joel caught it' },
  { id: 5,  name: 'ocean', biome: 'ocean',
    evidence: 'world tiles $0d-$0f $1d-$1f $2e, byte1 $6b — foot AND canoe blocked, ship only. 4548 on the map' },
  { id: 6,  name: 'sky', biome: null,
    evidence: '⛔ ORPHAN — no map and no world tile in any of the three tables selects it. Renders blue sky with cloud. check-battle-bg pins the orphan set to exactly {6}' },

  // ── Interiors. Named from the ROM'S OWN MAP NAMES where any map that selects
  //    the strip carries one (map property byte 2 -> string 0x100+b2). A row
  //    whose maps are all unnamed says so and its name is a description. ──
  { id: 7,  name: 'mountain', biome: null,
    evidence: '⭐ ROM-NAMED: the only two maps that select it are 92 "Summit Road" and 94 "Bahamut\'s Nest" — both mountain-summit locations. Was called "hills" off the art' },
  { id: 8,  name: 'cave', biome: null,
    evidence: 'ROM-NAMED: 101 "Mythril Mines", 103 "Sealed Cave", 111 "Altar Cave", 120/123 "Tozus Tunnel", 356 "Cave of the Circle", 392 "Falgabard Cave"' },
  { id: 9,  name: 'molten cave', biome: null,
    evidence: 'ROM-NAMED: 107 "Molten Cave", 156 "Bahamut\'s Lair" (+10 more); renders red rock' },
  { id: 10, name: 'underground lake', biome: null,
    evidence: 'ROM-NAMED: 116 "Subterranean Lake", 151 "Lake Dohr", 323 "Cave of Tides", 389 "Sunken Cave" — every named one is a flooded cave' },
  { id: 11, name: 'ancient ruins', biome: null,
    evidence: 'ROM-NAMED: 361 "Doga\'s Grotto" (361-377) and 420 "Ancient Ruins" (420-435); renders green latticework' },
  { id: 12, name: 'Cave of Shadows', biome: null,
    evidence: 'ROM-NAMED: 393 "Cave of Shadows" and its floors B2F-B8F — all 11 maps that select it are that one dungeon' },
  { id: 13, name: 'temple hall', biome: null,
    evidence: 'ROM-NAMED: 96 "Nepto Temple", 378 "Temple of Time", 19 "Sasune:West Tower"; renders blue and gold columns' },
  { id: 14, name: 'Castle Hein', biome: null,
    evidence: 'ROM-NAMED: 135 "Castle Hein" and its floors 136/141/142/143; renders yellow-green vines, which is what that castle is' },
  { id: 15, name: 'crystal chamber', biome: null,
    evidence: '⭐ ROM-NAMED, ten times over: 148 "Wind Crystal", 149 "Fire Crystal", 474 "Water Crystal", 475 "Earth Crystal", 476-479 the four Dark Crystals, 412/443 "Crystal Tower". Was called "ice" off the art — it is the CRYSTAL ROOM, which is why Altar Cave\'s crystal boss floor takes it via skin donor 148' },
  { id: 16, name: 'tower', biome: null,
    evidence: 'ROM-NAMED: 124 "Tower of Owen" and its floors 1F-10F, plus 157; also 480 "Saronia Catacombs". Renders teal stonework' },
  { id: 17, name: 'Sewers', biome: null,
    evidence: '⭐ ROM-NAMED: 340 "Sewers" and its floors B2F-B4F — all 7 maps that select it. Was called "brick water" off the art; Joel called it as the sewer and the ROM agrees' },
  { id: 18, name: 'undersea', biome: null,
    evidence: 'reached by no world-0 tile and no map; world 2 tile props (0x000710) hold it. ⚠ world 2 is STRIDE-DERIVED and never measured' },
  { id: 19, name: 'Goldor Manor', biome: null,
    evidence: 'ROM-NAMED: 347 "Goldor Manor" and its 2F floors — all 9 maps that select it' },
  { id: 20, name: "Ancients' Maze", biome: null,
    evidence: 'ROM-NAMED: 437 "Ancients\' Maze" (437-442). The other six maps that select it (333, 404-409) carry no banner' },
  { id: 21, name: 'Eureka', biome: null,
    evidence: 'ROM-NAMED: 487 "Forbidden Land Eureka" and its floors B2F-B7F — all 11 maps that select it' },
  { id: 22, name: 'Dark World', biome: null,
    evidence: '⭐ ROM-NAMED: 461 "Dark World" — all 6 maps that select it are that area. Was called "deep water" off the art; Joel called it as the dark world and the ROM agrees' },
  { id: 23, name: 'crystal shrine', biome: null,
    evidence: '⚠ NAME FROM THE RENDER — the only backdrop left with no ROM name. Map 473 alone selects it, it carries no banner, and no other map in its area (bank 1, area $62) does either' },
];

if (BACKDROPS.length !== BATTLE_BG_COUNT) {
  throw new Error(`backdrop registry has ${BACKDROPS.length} rows, the ROM has ${BATTLE_BG_COUNT}`);
}

/** Human-readable name for a backdrop id — for tools, gates and the debug panel. */
export function backdropName(id) {
  const row = BACKDROPS[id];
  return row ? row.name : `bg ${id}`;
}

/** The biome a backdrop id stands for, or null if it is not terrain. */
export function backdropBiome(id) {
  const row = BACKDROPS[id];
  return row ? row.biome : null;
}

// ── The sources ─────────────────────────────────────────────────────────────
//
// One row per way a backdrop gets chosen. `when` decides whether the row
// applies, `resolve` produces the id. `resolveBackdrop` walks them IN ORDER and
// takes the first match, so a new place to show a backdrop is a new row — not
// another branch grafted onto whichever function noticed it first.
//
// ⛔ Order matters and the reason is not cosmetic: a dungeon floor's mapId is
// ff3mmo's OWN synthetic id (1000+), which would index the ROM's map lookup
// table meaninglessly. The dungeon row must come before the plain map row.
export const BACKDROP_SOURCES = [
  {
    id: 'world',
    // ⭐ THE OVERWORLD IS A BIOME LOOKUP, NOT A MAP LOOKUP. The map table is
    // indexed by map id and the overworld is not a map id; this reads the tile
    // the party is standing on. Measured: forcing world tile-prop byte 2 to
    // 0x0C and walking to a fight puts backdrop 12 on screen.
    when: (ctx) => ctx.onWorldMap,
    resolve: (ctx) => {
      const r = ctx.worldMapRenderer;
      if (!r || typeof r.battleBgIdAt !== 'function') return 0;
      return r.battleBgIdAt(ctx.tileX, ctx.tileY);
    },
  },
  {
    id: 'dungeon',
    // Per FLOOR, not per dungeon. `resolveDungeonDonor` already gives the boss
    // floor its skin's donor (Altar Cave's crystal chamber -> ice), and
    // `romFloorMaps` gives each walkable floor the cartridge map it was built
    // from. Both dungeons currently land on `cave` for every normal floor, which
    // is why nobody noticed the donor was standing in for all five — a dungeon
    // whose floors cross terrain would have shipped one strip for the lot.
    when: (ctx) => isDungeonMapId(ctx.mapId),
    resolve: (ctx, rom) => battleBgIdForMap(rom, dungeonRomMapFor(ctx.mapId)),
  },
  {
    id: 'map',
    when: () => true,
    resolve: (ctx, rom) => battleBgIdForMap(rom, ctx.mapId),
  },
];

/**
 * Which ROM map supplies a dungeon floor's backdrop.
 *
 * Boss floors take the boss skin's donor (that is what makes Altar Cave's
 * crystal chamber ICE rather than the cave brown of the four floors above it).
 * Walkable floors take their own entry in `romFloorMaps` — the same list the
 * encounter tables are keyed on, so the monsters and the strip come from the
 * same cartridge map. Side rooms and anything unlisted fall back to the
 * dungeon's donor.
 */
export function dungeonRomMapFor(mapId) {
  const dungeon = dungeonForMapId(mapId);
  if (!dungeon) return 0;
  const donor = resolveDungeonDonor(mapId);
  const floorIndex = floorIndexForMapId(mapId);
  // resolveDungeonDonor already returned the boss skin for a boss floor; only
  // override it for a walkable floor that names its own ROM map.
  if (floorIndex !== null && donor === dungeon.donorMap &&
      Array.isArray(dungeon.romFloorMaps) && dungeon.romFloorMaps[floorIndex] !== undefined) {
    return dungeon.romFloorMaps[floorIndex];
  }
  return donor === null ? 0 : donor;
}

/**
 * The one entry point. `ctx` is `{ onWorldMap, mapId, tileX, tileY,
 * worldMapRenderer }` — everything any source needs, so no source reaches into
 * module state and they can all be exercised from a tool.
 */
export function resolveBackdrop(rom, ctx) {
  if (!rom) return 0;
  for (const src of BACKDROP_SOURCES) {
    if (!src.when(ctx)) continue;
    const id = src.resolve(ctx, rom);
    return id >= 0 && id < BATTLE_BG_COUNT ? id : 0;
  }
  return 0;
}

/** Which source row a context resolves through — for gates and the debug panel. */
export function backdropSourceFor(ctx) {
  for (const src of BACKDROP_SOURCES) if (src.when(ctx)) return src.id;
  return null;
}

export { battleBgIdForWorldProps };
