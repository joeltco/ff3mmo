import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { _stepPalFade } from './palette.js';

// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A backdrop is FOUR fields — TILES, PALETTE, TILEMAP ID, METATILES — plus the
// map lookup that selects it, which is TWO tables, not one. Reading the palette
// table and calling the backdrop "pulled" is the same failure as decoding the
// NPC flags byte and then shipping ten townsfolk frozen in place.
//
// Every constant below was checked against a LIVE PPU, not against a comment:
// `tools/monscan/battle-bg-sweep.cjs` hex-patches the map->backdrop byte, boots
// the real cartridge into a real encounter, and compares the tiles, the palette,
// the tilemap and the metatiles the console actually drew. All 24 ids agree.
// If you change a number in this file, re-run that sweep. "It still renders" is
// not a check — the backdrop rendered fine when it was reading the wrong table.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── HOW THE CARTRIDGE PICKS A BACKDROP (bank $39 at $A000, code at $C533) ──
//
//     LDA #$39 / JSR $FF09      ; page bank $39 into the $A000 window
//     LDX $48                   ; $48 = map id, LOW byte
//     LDA $78 / BEQ +           ; $78 = map id HIGH bit (which 256-map bank)
//     LDA $BD00,X               ;   maps 256-511
//     LDA $BC00,X               ; + maps 0-255
//     STA $53 / STA $6B         ; the RAW byte, high bits and all
//
// MEASURED, not read off a disassembly: booting the game and watching zero page
// shows `$48` become 181 at frame 2937 (map load) and `$6B` become
// `table[181] & 0x1F` at frame 3609. Patching table[181] changes the backdrop on
// screen; patching all 255 OTHER entries changes nothing.
//
// ⛔ THE BUG THIS FILE SHIPPED WITH: only `$BC00` was wired. FF3 has maps above
// 255 — `loadMap` reaches 511 — and the SECOND table is where backdrops 17-23
// live. Every map above 255 was silently drawing map-mod-256's backdrop.
//
// ── THE BYTE'S OTHER BITS ────────────────────────────────────────────────────
// Bits 0-4 are the backdrop id. Bits 5 and 6 are set on 79 of the 512 entries
// (bit 7: never). They are NOT backdrop data and this file does not pretend to
// know what they are: bytes $08 / $28 / $48 were run on hardware and the
// backdrop came back pixel-identical every time — same palette, same four
// nametable rows. The enemy count wobbled between those runs, but it wobbles for
// $09 and $0a too, so that is the RNG, not bits 5-6. UNDECODED, and named here
// rather than quietly masked away.
export const BATTLE_BG_TILES_ROM   = 0x018010;  // + bgId * 0x100 -> 16 tiles of 16 bytes
export const BATTLE_BG_MAP_LOOKUP  = 0x073C10;  // bank $39/$BC00 - maps   0-255
export const BATTLE_BG_MAP_LOOKUP_HI = 0x073D10; // bank $39/$BD00 - maps 256-511
export const BATTLE_BG_PAL_C1      = 0x001110;  // bank 00/$9100, colour 1 per bgId
export const BATTLE_BG_PAL_C2      = 0x001210;  // bank 00/$9200, colour 2 per bgId
export const BATTLE_BG_PAL_C3      = 0x001310;  // bank 00/$9300, colour 3 per bgId
const BATTLE_BG_TMID_TABLE  = 0x05E512;  // bank $2F/$A502, tilemap id per bgId
const BATTLE_BG_META_TILES  = 0x05E52A;  // bank $2F/$A51A, 4 metatiles x 4 tile ids
const BATTLE_BG_TILEMAPS    = 0x05E53A;  // bank $2F/$A52A, 3 tilemaps x 32 bytes

// 24 backdrops, ids 0-23. Not a guess and not "the table looks about this long":
// the TMID table runs out at 24 (entry 24 onward IS the metatile table, which is
// why BATTLE_BG_META_TILES sits at TMID + 24), and the highest low-5 value in
// either map lookup table is 0x17 = 23. All 24 render; none is unused.
export const BATTLE_BG_COUNT = 24;

// The backdrop band is 16 metatiles wide by 2 tall = 256x32 px, and it sits at
// nametable rows 1-4 (y = 8..39) with the rest of the field black. Measured off
// the PPU, not inferred from the tilemap being 32 bytes long.
export const BATTLE_BG_W = 256, BATTLE_BG_H = 32;
export const BATTLE_BG_SCREEN_Y = 8;

/**
 * Which backdrop does a map fight on? `mapId` is the full 0-511 id, the same one
 * `loadMap` takes — the high half picks the SECOND table exactly as `$78` does
 * on the cartridge. Returns 0-23.
 */
export function battleBgIdForMap(romData, mapId) {
  const base = mapId >= 256 ? BATTLE_BG_MAP_LOOKUP_HI : BATTLE_BG_MAP_LOOKUP;
  return romData[base + (mapId & 0xFF)] & 0x1F;
}

function _blitTile(ctx, px, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; }
    else {
      const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
      img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
      img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, x, y);
}

export function _loadBattlePalette(romData, bgId) {
  return [0x0F, romData[BATTLE_BG_PAL_C1 + bgId], romData[BATTLE_BG_PAL_C2 + bgId], romData[BATTLE_BG_PAL_C3 + bgId]];
}

function _loadBattleMetaTiles(romData) {
  const metaTiles = [];
  for (let m = 0; m < 4; m++) {
    const ids = [];
    for (let j = 0; j < 4; j++) ids.push(romData[BATTLE_BG_META_TILES + m * 4 + j] - 0x60);
    metaTiles.push(ids);
  }
  return metaTiles;
}

function _loadBattleTilemap(romData, bgId) {
  const tilemapIdx = romData[BATTLE_BG_TMID_TABLE + bgId];
  const tmBase = BATTLE_BG_TILEMAPS + tilemapIdx * 32;
  const tilemap = [];
  for (let i = 0; i < 32; i++) tilemap.push(romData[tmBase + i]);
  return tilemap;
}

export function renderBattleBgWithPalette(romData, bgId, palette, tiles, metaTiles, tilemap) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const bctx = c.getContext('2d');
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 16; col++) {
      const metaIdx = tilemap[row * 16 + col];
      const [tl, tr, bl, br] = metaTiles[metaIdx];
      const px = col * 16, py = row * 16;
      for (const [tIdx, sx, sy] of [[tl,px,py],[tr,px+8,py],[bl,px,py+8],[br,px+8,py+8]])
        _blitTile(bctx, tiles[tIdx], palette, sx, sy);
    }
  }
  return c;
}

export function _loadOceanTileData(romData, bgId) {
  const tileBase = BATTLE_BG_TILES_ROM + bgId * 0x100;
  const tiles = [];
  for (let i = 0; i < 16; i++) tiles.push(decodeTile(romData, tileBase + i * 16));
  const metaTiles = _loadBattleMetaTiles(romData);
  const tilemap = _loadBattleTilemap(romData, bgId);
  return { tiles, metaTiles, tilemap };
}

// Returns { bgCanvas, fadeFrames }
export function renderBattleBg(romData, bgId) {
  const palette = _loadBattlePalette(romData, bgId);
  const { tiles, metaTiles, tilemap } = _loadOceanTileData(romData, bgId);
  const frames = [];
  const fadePal = [...palette];
  while (true) {
    frames.push(renderBattleBgWithPalette(romData, bgId, fadePal, tiles, metaTiles, tilemap));
    if (fadePal[1] === 0x0F && fadePal[2] === 0x0F && fadePal[3] === 0x0F) break;
    _stepPalFade(fadePal);
  }
  return { bgCanvas: frames[0], fadeFrames: frames };
}

// ── The OVERWORLD path ──────────────────────────────────────────────────────
//
// ⛔ The map lookup is indexed by map id and the overworld is NOT a map id, so
// `setupTopBox` fell back to `table[0]` — grassland, everywhere, forever. The
// tell that something was missing: SEVEN of the 24 backdrops (desert, forest,
// marsh, rock, ocean, sky, undersea) are reached by no map in either lookup
// table. A backdrop the cartridge ships and no code can reach is a dropped
// field, not a spare.
//
// On the overworld the backdrop comes from the TILE THE PARTY IS STANDING ON —
// byte 2 of its entry in the world tile-property table, the same 128 x 2 table
// `world-map-loader.js` already parses for passability and entrances.
//
// MEASURED, not inferred: forcing byte 2 of every world tile to 0x0C and
// walking until a random encounter fired put backdrop 12's palette
// (0f 26 14 04) on screen and 0x0C in $6B. Stock, the same walk gives 0.
//   node tools/monscan/world-bg-probe.cjs        # stock
//   node tools/monscan/world-bg-probe.cjs 0x0c   # forced
//
// World 0's non-entrance tiles use exactly ids 0-5 — grass, desert, forest,
// marsh, rock, ocean — which is why those six appear in no map table.
//
// ⛔ ENTRANCE TILES DO NOT CARRY A BACKDROP. When byte 1 bit 7 is set the tile
// is a warp and byte 2 is its destination id instead — ids that run to 0x19,
// past the 24 real backdrops. You cannot fight standing on one (the warp fires
// first), but this masks and range-checks anyway rather than trusting that.
export function battleBgIdForWorldProps(props) {
  if (!props) return 0;
  if (props.byte1 & 0x80) return 0;              // warp tile: byte2 is a destination
  const id = props.byte2 & 0x1F;
  return id < BATTLE_BG_COUNT ? id : 0;
}

// Other worlds' tile-property tables sit at the same 256-byte stride as every
// other per-world table: world 0 at 0x000510, world 1 at 0x000610, world 2 at
// 0x000710. World 1 adds backdrop 7, world 2 is the one that uses 18 (undersea).
// ⛔ STRIDE-DERIVED, NOT MEASURED — this game loads world 0 and the headless
// world harness only reaches world 0, so no probe has ever stood on world 1 or
// 2. Do not present these as verified; verify them if a world ever ships.
export const WORLD_TILE_PROPS = [0x000510, 0x000610, 0x000710];

// ── Render cache ────────────────────────────────────────────────────────────
// `renderBattleBg` builds a whole NES fade ramp (one canvas per palette step),
// which is far too much to redo per frame. Battles only ever need a handful of
// ids, so they are memoised by id.
const _bgCache = new Map();
export function getBattleBg(romData, bgId) {
  const id = bgId | 0;
  if (!_bgCache.has(id)) _bgCache.set(id, renderBattleBg(romData, id));
  return _bgCache.get(id);
}
