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
// ⛔ NAMES ARE DESCRIPTIONS OF A RENDER, NOT ROM DATA. The cartridge does not
// name its backdrops. Every row below carries the evidence its name rests on —
// for the overworld six that is the set of world tiles which SELECT it (read out
// of the tile-property table), which is a measured fact; for the rest it is the
// maps that select it plus what the strip draws when rendered. Do not tighten a
// name into a claim the evidence does not support.
//
// `biome` is set only where a WORLD TILE selects the strip. A backdrop with no
// biome is an interior/dungeon strip and is chosen by map id, never by terrain.
export const BACKDROPS = [
  { id: 0,  name: 'grassland', biome: 'grass',
    evidence: 'world 0: selected by most walkable land tiles; renders green grass under white sky' },
  { id: 1,  name: 'desert', biome: 'desert',
    evidence: 'world 0 tiles $02 $12 $13 $22 $23; renders tan dunes under pale sky' },
  { id: 2,  name: 'forest', biome: 'forest',
    evidence: 'world 0 tiles $0a-$0c $1a-$1c $2a-$2c; renders dark trees' },
  { id: 3,  name: 'marsh', biome: 'marsh',
    evidence: 'world 0 tiles $28 $29 $38 $39; renders reeds over water. ⚠ NO world-0 map tile uses these — the props entry exists, the terrain does not appear on this world' },
  { id: 4,  name: 'mountain', biome: 'rock',
    evidence: 'world 0 tiles $08 $09 $18 $19 $3a $3b; renders grey rock under blue sky' },
  { id: 5,  name: 'ocean', biome: 'ocean',
    evidence: 'world 0 tiles $0d-$0f $1d-$1f $2e; renders water and cloud' },
  { id: 6,  name: 'sky', biome: null,
    evidence: '⛔ ORPHAN — selected by no map and no world tile in this cartridge. Renders blue sky with cloud. Pinned as the only orphan by check-battle-bg' },
  { id: 7,  name: 'hills', biome: null, evidence: 'maps 92, 94; renders green hills under blue sky' },
  { id: 8,  name: 'cave', biome: null, evidence: '23 maps incl. Altar Cave 111 and Cave of Seals 103; renders brown rock' },
  { id: 9,  name: 'red cave', biome: null, evidence: '12 maps from 107; renders red rock' },
  { id: 10, name: 'dark cavern', biome: null, evidence: '19 maps from 116; renders dark pillars over blue' },
  { id: 11, name: 'green ruin', biome: null, evidence: '34 maps from 152; renders green latticework' },
  { id: 12, name: 'crystal cave', biome: null, evidence: 'maps 393-403; renders magenta crystal' },
  { id: 13, name: 'pillared hall', biome: null, evidence: '26 maps incl. Sasune 19-21; renders blue and gold columns' },
  { id: 14, name: 'jungle', biome: null, evidence: 'maps 135-146; renders yellow-green fronds' },
  { id: 15, name: 'ice', biome: null, evidence: '28 maps from 147; renders blue ice. Altar Cave crystal boss chamber (skin donor 148)' },
  { id: 16, name: 'stone keep', biome: null, evidence: '30 maps from 124; renders teal stonework' },
  { id: 17, name: 'brick water', biome: null, evidence: 'maps 340-346; renders teal brick over water' },
  { id: 18, name: 'undersea', biome: null,
    evidence: 'reached by no world-0 tile and no map; world 2 tile props (0x000710) hold it. ⚠ world 2 is STRIDE-DERIVED and never measured' },
  { id: 19, name: 'gold temple', biome: null, evidence: 'maps 347-355; renders gold blocks' },
  { id: 20, name: 'ornate hall', biome: null, evidence: '13 maps from 333; renders gold rosettes over red' },
  { id: 21, name: 'stone tower', biome: null, evidence: 'maps 487-497; renders grey masonry' },
  { id: 22, name: 'deep water', biome: null, evidence: 'maps 461-472; renders bright blue water' },
  { id: 23, name: 'crystal shrine', biome: null, evidence: 'map 473; renders blue orbs over water' },
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
