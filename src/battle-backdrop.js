// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// This file exists because the backdrop data was HALF pulled for a long time:
// `battle-bg.js` could render all 24 backdrops, `setupTopBox` used them for a
// HUD strip — and the BATTLE ITSELF never drew one. Fights happened over the
// frozen field map. The tiles were decoded, the palettes were decoded, and the
// one place the data is actually for was never wired.
//
// A field decoded but not wired is NOT done.
// ═══════════════════════════════════════════════════════════════════════════
//
// ── SINGLE SOURCE ───────────────────────────────────────────────────────────
// Every battle — random encounter, chest mimic, server-rolled PvE, boss, PvP —
// asks THIS function which backdrop it fights on. Resolution happens at draw
// time from `mapSt`, not at each battle-start site, precisely so a new kind of
// battle cannot be added that forgets to set it. There is nothing to forget.
//
// ── WHERE THE ID COMES FROM ─────────────────────────────────────────────────
//   overworld       tile the party stands on -> world tile-prop byte 2
//   dungeon         the floor's DONOR map -> map lookup table
//   town / interior the map id -> map lookup table
//
// All three are verified against a live PPU; see `battle-bg.js` for the exact
// probes and `tools/check-battle-bg.mjs` for the gate that keeps them honest.
import { mapSt } from './map-state.js';
import { isDungeonMapId } from './data/dungeons.js';
import { resolveDungeonDonor } from './dungeon/boss-chamber.js';
import { battleBgIdForMap, getBattleBg, BATTLE_BG_H, BATTLE_BG_SCREEN_Y } from './battle-bg.js';

// ⛔ The ROM is INJECTED, not imported from boot.js. boot.js pulls in the HUD,
// which pulls in the battle drawers, which pull in this file — importing
// `romRaw` from there closes that cycle and, worse, makes this module
// impossible to render headlessly. `map-loading.js` takes the same shape
// (`initMapLoading`); mirror it rather than inventing a third way.
let _rom = null;
export function initBattleBackdrop(rom) { _rom = rom; }

// Battle viewport — the same rectangle every other battle drawer uses.
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;

// ⛔ 16, and it must stay the field's tile size. `currentEncounterZoneKey` in
// battle-encounter.js derives the party's world tile the same way; if these two
// ever disagree, a fight rolls its monsters from one tile and paints the
// backdrop of another.
const TILE_SIZE = 16;

/**
 * Which backdrop id (0-23) does a battle starting right here use?
 *
 * Exported so a gate — and the debug panel — can ask the question without
 * rendering anything.
 */
export function currentBattleBgId() {
  if (!_rom) return 0;
  if (mapSt.onWorldMap) {
    const r = mapSt.worldMapRenderer;
    if (!r || typeof r.battleBgIdAt !== 'function') return 0;
    return r.battleBgIdAt(Math.floor(mapSt.worldX / TILE_SIZE), Math.floor(mapSt.worldY / TILE_SIZE));
  }
  const mapId = isDungeonMapId(mapSt.currentMapId)
    ? resolveDungeonDonor(mapSt.currentMapId)
    : mapSt.currentMapId;
  return battleBgIdForMap(_rom, mapId);
}

/**
 * Paint the battle field: the backdrop band across the top, black beneath it.
 *
 * ⛔ THE BLACK IS NOT DECORATION — it is what makes this a battle screen. The
 * field map used to keep rendering behind the monsters, so a fight in a town
 * happened on top of the shops. The cartridge blanks the whole field and draws
 * one 256x32 band at the top; this is that, cropped to our narrower viewport.
 *
 * The band's y offset is the console's own: nametable rows 1-4, i.e. 8 px down
 * from the top of the field. Measured off the PPU, not eyeballed.
 */
export function drawBattleBackdrop(ctx) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H);
  if (_rom) {
    const { bgCanvas } = getBattleBg(_rom, currentBattleBgId());
    // The strip is 256 wide and its metatile pattern repeats every 64 px, so a
    // 144-wide crop tiles seamlessly and keeps 1:1 pixels — no scaling.
    if (bgCanvas) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bgCanvas, 0, 0, HUD_VIEW_W, BATTLE_BG_H,
                    HUD_VIEW_X, HUD_VIEW_Y + BATTLE_BG_SCREEN_Y, HUD_VIEW_W, BATTLE_BG_H);
    }
  }
  ctx.restore();
}
