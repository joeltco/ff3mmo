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
// map-loading.js — map/dungeon/world loading functions extracted from game.js

import { buildSpritePalettes, parseMapProperties } from './map-loader.js';
import { loadMap } from './map-loader.js';
import { MapRenderer } from './map-renderer.js';
import { generateFloor, generateSecretRoomMap } from './dungeon-generator.js';
import { generateLockedRoomMap } from './dungeon-locked-room.js';
import { isCrystalChamber, isDungeonMapId, dungeonForMapId, floorIndexForMapId,
         sideRoomForMapId, isBossFloor } from './data/dungeons.js';
import { resolveDungeonDonor, bossFramesForDungeon } from './dungeon/boss-chamber.js';
import { initMapObjectFrames } from './sprite-init.js';
import { playTrack, stopMusic, playFF2Track, stopFF2Music, ff2MusicReady, TRACKS, FF2_TRACKS } from './music.js';
import { DIR_DOWN } from './sprite.js';
import { sprite } from './player-sprite.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { clearFlameSprites, rebuildFlameSprites } from './flame-sprites.js';
import { clearNpcs, placeMoogleAtCaveCenter, placeOpeningScene, placeTownNpcs, addBlackMageShopkeeper, addMageShopkeeper, addBossNpc, addCrystalNpc, getLandTurtleFrames, setBossFrames, getBossFrames } from './npc.js';
import { transSt, topBoxSt } from './transitions.js';
import { BATTLE_BG_MAP_LOOKUP, renderBattleBg } from './battle-bg.js';
import { dungeonLabels } from './dungeon/labels.js';
import { BANNER_FOR_MAP, TOWN_MAPS } from './data/areas.js';
import { mapEntryMusic } from './map-music.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { applyPassage, triggerWipe, expireResettableChests } from './map-triggers.js';
import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';

const TILE_SIZE = 16;

// Init-once ROM ref — set by game.js at boot
let romRaw = null;

export function initMapLoading(rom) { romRaw = rom; }

function _calcSpawnY(ex, ey) {
  const mapData = mapSt.mapData;
  const eMid = mapData.tilemap[ey * 32 + ex];
  const eM = eMid < 128 ? eMid : eMid & 0x7F;
  const eColl = mapData.collision[eM];
  if ((eColl & 0x07) === 3) {
    for (let dy = 1; dy < 32; dy++) {
      const ny = (ey - dy + 32) % 32;
      if (mapData.tilemap[ny * 32 + ex] === 0x44) return ny;
    }
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey + dy;
      if (ny >= 32) break;
      const mid = mapData.tilemap[ny * 32 + ex];
      if (mid === mapData.fillTile) break;
      const m = mid < 128 ? mid : mid & 0x7F;
      if ((mapData.collision[m] & 0x07) !== 3 && !(mapData.collision[m] & 0x80)) return ny;
    }
    for (let dy = 1; dy <= 16; dy++) {
      const ny = ey - dy;
      if (ny < 0) break;
      const mid = mapData.tilemap[ny * 32 + ex];
      if (mid === mapData.fillTile) break;
      const m = mid < 128 ? mid : mid & 0x7F;
      if ((mapData.collision[m] & 0x07) !== 3 && !(mapData.collision[m] & 0x80)) return ny;
    }
    return ey;
  }
  const entMid = mapData.tilemap[ey * 32 + ex];
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  const entColl = mapData.collision[entM];
  if (entMid === 0x44) return ey;
  if ((entColl & 0x80) && ((mapData.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let dy = 1; dy <= 8; dy++) {
      const ny = ey - dy;
      if (ny < 0) break;
      if (mapData.tilemap[ny * 32 + ex] === 0x44) return ny;
    }
  }
  return ey;
}

function _openReturnDoor(playerX, playerY) {
  mapSt.openDoor = null;
  const mapRenderer = mapSt.mapRenderer;
  const mapData = mapSt.mapData;
  const trig = mapRenderer.getTriggerAt(playerX, playerY);
  if (trig && trig.source === 'dynamic' && trig.type === 1) {
    const origTileId = mapData.tilemap[playerY * 32 + playerX];
    const origM = origTileId < 128 ? origTileId : origTileId & 0x7F;
    if (((mapData.collisionByte2[origM] >> 4) & 0x0F) === 5) {
      mapRenderer.updateTileAt(playerX, playerY, 0x7E);
      mapSt.openDoor = { x: playerX, y: playerY, tileId: origTileId };
    }
  }
}

// Replay persisted tile mutations (chests opened, secret walls revealed,
// rock puzzles solved) onto a freshly-generated tilemap. Stored at
// ps.consumedTiles[mapId][`${x},${y}`] = newTileId. See SAVE-STATE-AUDIT.md
// #1-3 (v1.7.215). Also tidies the relevant `secretWalls` set so a revealed
// wall doesn't keep its "still hidden" trigger.
function _replayConsumedTiles(mapId, mapData) {
  const consumed = ps.consumedTiles && ps.consumedTiles[mapId];
  if (!consumed) return;
  for (const key of Object.keys(consumed)) {
    const [x, y] = key.split(',').map(Number);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    mapData.tilemap[y * 32 + x] = consumed[key];
    if (mapSt.secretWalls && mapSt.secretWalls.has(key)) mapSt.secretWalls.delete(key);
    // Unlocked-door persistence: any door coord that was unlocked (and
    // therefore stamped into consumedTiles) gets removed from lockedDoors
    // so the chamber re-loads with it walkable. v1.7.672.
    if (mapSt.lockedDoors && mapSt.lockedDoors.has(key)) mapSt.lockedDoors.delete(key);
  }
}

// Single source of truth for per-map state defaults. Every loader (regular
// indoor, dungeon, worldmap) calls this before applying its own values, so
// adding a new per-map field on mapSt just means adding one line here — no
// risk of one loader carrying stale state from the previous map (e.g. v1.7.341
// shipped encounterPatch but only wired the clear into _loadRegularMap; entering
// Ur then descending into the altar cave kept the patch and spawned overworld
// monsters underground. Fixed in v1.7.350; centralized here in v1.7.351).
function _resetPerMapState() {
  mapSt.dungeonFloor = -1;
  mapSt.encounterSteps = 0;
  mapSt.dungeonDestinations = null;
  mapSt.secretWalls = null;
  mapSt.falseWalls = null;
  mapSt.hiddenTraps = null;
  mapSt.rockSwitch = null;
  mapSt.warpTile = null;
  mapSt.pondTiles = null;
  mapSt.bossSprite = null;
  mapSt.encounterPatch = null;
  mapSt.encounterPatchZone = null;
  mapSt.mapData = null;
  mapSt.mapRenderer = null;
  mapSt.disabledTrigger = null;
  mapSt.openDoor = null;
}

function _loadDungeonFloor(mapId, returnX, returnY) {
  // Capture the chamber-side `goLeft` for secret rooms BEFORE _resetPerMapState
  // wipes `mapSt.falseWalls`. Pre-v1.7.690 the lookup ran after the reset, so
  // `prevDest` was always null → secret rooms always rendered right-side even
  // when entered from the left corridor. (`placeSecretPath` stashes
  // `{mapId, goLeft}` in the chamber map's falseWalls; the data is correct,
  // we just have to read it before clearing.)
  let secretGoLeft = false;
  if (sideRoomForMapId(mapId)?.kind === 'secret' && mapSt.falseWalls) {
    const prevDest = [...mapSt.falseWalls.values()].find(d => d && d.mapId === mapId);
    if (prevDest) secretGoLeft = !!prevDest.goLeft;
  }
  _resetPerMapState();
  let result;
  // Inside a side-room map (locked / secret), keep `floorIndex` at whatever
  // the host chamber's floor was (don't reassign `mapSt.dungeonFloor` either)
  // so the boss / moogle / music checks below stay consistent. v1.7.665.
  let floorIndex;
  const _side = sideRoomForMapId(mapId);
  const _dungeon = dungeonForMapId(mapId);
  if (_side?.kind === 'locked') {
    // Standalone locked-room maps — 1010 from floor 0, 1011 from floor 2 (UI
    // 3). Seed XOR'd with mapId so each room has its own chest layout (but
    // deterministic per dungeonSeed so consumed-tile state lines up).
    floorIndex = mapSt.dungeonFloor;
    result = generateLockedRoomMap(romRaw, ((mapSt.dungeonSeed | 0) ^ mapId) | 0, _dungeon);
  } else if (_side?.kind === 'secret') {
    // Secret rooms — `secretGoLeft` was captured above. Re-loading without
    // chamber context (shouldn't happen — overworld-only saves + chamber is
    // always the parent) falls back to right-side.
    floorIndex = mapSt.dungeonFloor;
    result = generateSecretRoomMap(romRaw, secretGoLeft, _dungeon);
  } else {
    floorIndex = floorIndexForMapId(mapId);
    mapSt.dungeonFloor = floorIndex;
    result = generateFloor(romRaw, floorIndex, mapSt.dungeonSeed, _dungeon);
  }
  mapSt.mapData = result;
  mapSt.secretWalls = result.secretWalls;
  mapSt.falseWalls = result.falseWalls;
  mapSt.hiddenTraps = result.hiddenTraps;
  mapSt.lockedDoors = result.lockedDoors || null;
  mapSt.rockSwitch = result.rockSwitch || null;
  mapSt.warpTile = result.warpTile || null;
  mapSt.pondTiles = result.pondTiles || null;
  mapSt.dungeonDestinations = result.dungeonDestinations;
  mapSt.currentMapId = mapId;
  _replayConsumedTiles(mapId, result);
  const playerX = returnX !== undefined ? returnX : result.entranceX;
  const playerY = returnY !== undefined ? returnY : result.entranceY;
  mapSt.worldX = playerX * TILE_SIZE;
  mapSt.worldY = playerY * TILE_SIZE;
  mapSt.mapRenderer = new MapRenderer(result, playerX, playerY);
  resetIndoorWaterCache();
  clearFlameSprites();
  clearNpcs();
  if (floorIndex === 0) placeMoogleAtCaveCenter(result);
  // Boss is now an NPC rendered through `drawNpcs`. Keep `mapSt.bossSprite`
  // as a no-frames presence flag for the existing battle-trigger / collision
  // checks in movement.js + battle code.
  const _isBoss = _dungeon ? isBossFloor(_dungeon, floorIndex) : false;
  // Per-dungeon boss art. A skin naming a `bossSpriteOffset` gets that FF3 map
  // object, painted with the floor's OWN sprite palette (which comes from the
  // donor map) and the palette index measured off the object's ROM record.
  // A skin without one keeps the FF2 Adamantoise, which is Altar Cave's.
  if (_isBoss && _dungeon) {
    // Same resolver the loading screen uses, so its silhouette and the boss
    // standing in the room can never be different sprites.
    setBossFrames(bossFramesForDungeon(
      romRaw, _dungeon, initMapObjectFrames, buildSpritePalettes, parseMapProperties));
  }
  if (_isBoss && getBossFrames() && !battleSt.enemyDefeated) {
    mapSt.bossSprite = { px: 6 * TILE_SIZE, py: 8 * TILE_SIZE };
    addBossNpc(6, 8);
  } else if (_isBoss && battleSt.enemyDefeated && isCrystalChamber(mapId)) {
    // Turtle already beaten this dungeon run — the Wind Crystal stands in its
    // place (no blink; the live blink→crystal reveal only plays on the winning
    // turn). No bossSprite → walkable, no re-trigger. Turtle respawns once
    // enemyDefeated resets on world-map exit (map-loading gate above).
    //
    // ⛔ CRYSTAL CHAMBERS ONLY. In a regular dungeon (the Cave of Seals) the
    // boss is simply gone once it is beaten — no crystal stands in its place.
    // The boss NPC branch above is deliberately NOT gated: every boss chamber
    // has a boss.
    mapSt.bossSprite = null;
    addCrystalNpc(6, 8);
  } else {
    mapSt.bossSprite = null;
  }
  mapSt.disabledTrigger = { x: playerX, y: playerY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  if (_isBoss && _dungeon) playTrack(TRACKS[_dungeon.music.boss]);
  // Always fire — `_openReturnDoor` internally no-ops unless the spawn tile
  // is a type-1 trigger with door collision. For side-room maps (locked
  // room mapId 1010) the player spawns on the door but the trigger
  // transition doesn't pass returnX, so without this change the door
  // rendered closed. v1.7.668.
  _openReturnDoor(playerX, playerY);
}

// Flood-fill the tilemap from (sx, sy), matching the same tile ID 4-way.
// Returns a Set of y*32+x indices the player triggers encounters on. Used
// by town encounter-patch zones — see Ur (114) where the dark-tile patch
// (tile 0x2f at 22,8) runs `grasslands_wild`.
function _floodFillTilePatch(tilemap, sx, sy) {
  const targetId = tilemap[sy * 32 + sx];
  const out = new Set();
  const stack = [[sx, sy]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= 32 || y < 0 || y >= 32) continue;
    const idx = y * 32 + x;
    if (out.has(idx)) continue;
    if (tilemap[idx] !== targetId) continue;
    out.add(idx);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

function _loadRegularMap(mapId, returnX, returnY) {
  _resetPerMapState();
  const mapData = loadMap(romRaw, mapId);
  mapSt.mapData = mapData;
  mapSt.currentMapId = mapId;
  expireResettableChests(mapId);   // Ur chests respawn 24h after looting
  _replayConsumedTiles(mapId, mapData);
  if (TOWN_MAPS.has(mapId)) ps.lastTown = mapId;
  // ⭐ KAZUS'S MAGIC SIGN IS CORRECT AS SHIPPED. DO NOT "FIX" IT AGAIN.
  //
  // FF3 has ONE magic-shop sign per tileset and both schools use it:
  //   tileset 4 (every town): $17 pal2 — used by the BLACK shops (Ur, Kazus,
  //     31, 60) AND the WHITE shop (map 69) alike
  //   tileset 0 (the Invincible, map 180): $4e, that tileset's own magic sign
  // The school is shown by the KEEPER'S JOB SPRITE — gfx 3 White Mage vs gfx 4
  // Black Mage — which `addMageShopkeeper` has done since v1.10.75.
  // **FF1** is the game with separate white/black magic shops. Settled with
  // Joel 2026-08-25.
  //
  // ⛔ Two invented signs shipped before that was established, and both are
  // instructive:
  //   1. $67 — the star glyph on **pal1, the TREE/WOOD palette**. A gold star
  //      with GREEN CORNERS on a wooden wall. The glyph was picked and its
  //      ATTRIBUTE never looked at. **A metatile is not chosen until its
  //      PALETTE is chosen** — `map-renderer.js:549` -> `tileAttrs[m] & 3`.
  //   2. $67 on pal3 — a navy star. A colour I liked.
  //
  // ⛔ And the search that "proved" things twice was junk both ways: it assumed
  // a sign is the tile at (x, y-1) above a door. Signs sit at door-2 in some
  // layouts, so it read map 60's and map 69's INN sign ($1c) and compared those.
  // The same pass claimed every town exterior is tileset 4 — map 78 is tileset
  // 3, map 180 is tileset 0. Never infer a map feature from a position rule.
  // v1.7.950 — a closed passage nothing can open is just a wall.
  //
  // Tiles $5B/$5C are FF3's closed passage ($5B -> $5D doorframe, $5C -> $5E
  // walkable). The only opener in this build is the torch handler in
  // movement.js, and it is hardcoded to tile $32 at (8,16) — which exists on
  // exactly TWO maps (1 and 2). On every other map the passage can never open,
  // so it is a permanent wall that the ROM never intended.
  //
  // Measured over all 256 maps: 106 carry a closed passage, opening it adds
  // reachable area on 18, and it takes SEVEN from "no reachable exit" to
  // escapable — map 22 goes 75 tiles / 0-of-1 exits to 87 / 1-of-1. Maps 1 and
  // 2 keep their puzzle; everything else starts open.
  const _hasTorchOpener = mapData.tilemap[16 * 32 + 8] === 0x32;
  if (returnX !== undefined || !_hasTorchOpener) applyPassage(mapData.tilemap);
  const ex = mapData.entranceX;
  const ey = mapData.entranceY;
  // ⭐ NO PER-MAP SPAWN OVERRIDES. v1.10.7 added one for map 21 and documented
  // four more it dared not apply. All five were symptoms of the tilemap decode
  // bug fixed in v1.10.9 — with the map right, `_calcSpawnY` agrees with the
  // cartridge's landing tile on ALL 44 maps measured by `door-probe.cjs`, so the
  // override table was deleted rather than left sitting there doing nothing.
  const playerX = returnX !== undefined ? returnX : ex;
  const playerY = returnY !== undefined ? returnY : _calcSpawnY(ex, ey);
  mapSt.worldX = playerX * TILE_SIZE;
  mapSt.worldY = playerY * TILE_SIZE;
  const mapRenderer = new MapRenderer(mapData, playerX, playerY);
  mapSt.mapRenderer = mapRenderer;
  resetIndoorWaterCache();
  if (mapRenderer.hasRoomClip()) {
    const spawnMid = mapData.tilemap[playerY * 32 + playerX];
    mapSt.disabledTrigger = (spawnMid === 0x44 || playerY !== ey) ? { x: playerX, y: playerY } : null;
  } else { mapSt.disabledTrigger = null; }
  rebuildFlameSprites(mapSt.mapData, mapSt.mapRenderer, TILE_SIZE);
  clearNpcs();
  // ⭐ THE KEEPER'S JOB FOLLOWS THE SCHOOL (v1.10.75). FF3 tells its magic
  // shops apart this way — maps 75/76/79/80 put a White Mage (gfx 3) behind the
  // counter, Ur and Kazus a Black Mage (gfx 4). ff3mmo makes Ur the WHITE shop,
  // so Ur gets the White Mage and Kazus keeps the Black one. The walk palette
  // for job 3 is a PPU capture off map 75, not a hand-authored guess.
  if (mapId === 3) addMageShopkeeper(4, 4, 'ur_magic', 'white');
  // Kazus's magic shop, same mechanism. The keeper stands ON the counter tile
  // and carries the shopId, which is what `talkToNpc` reads to open the menu —
  // a plain TOWN_NPCS villager next to the counter has neither, which is how
  // v1.8.12 shipped a magic shop that only said a line.
  if (mapId === 15) addMageShopkeeper(4, 4, 'kazus_magic', 'black');
  if (mapId === 7) placeOpeningScene();
  // Ur (114) has a dark-tile patch in the town that spawns wild
  // grasslands encounters (Werewolves + Bees). Flood-fill from the seed
  // tile so adding/extending the patch in the ROM just works. Computed
  // BEFORE placeTownNpcs so the wanderer random-spawn pool can exclude it.
  if (mapId === 114) {
    mapSt.encounterPatch = _floodFillTilePatch(mapData.tilemap, 22, 8);
    mapSt.encounterPatchZone = 'grasslands_wild';
  }
  placeTownNpcs(mapId);
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  if (returnX !== undefined) _openReturnDoor(playerX, playerY);
  // Which track this map entry starts is decided by `mapEntryMusic` — a pure
  // function in src/map-music.js, so `tools/check-map-music.mjs` can exercise
  // the REAL choice instead of a restatement of it. This block only performs
  // the plan it returns.
  //
  // Elder house (maps 6 + 7) gets FF2's theme on the FF2 emulator while the FF3
  // track is stopped. Idempotent across the two floors (playFF2Track no-ops on
  // the same track), so it plays continuously 6<->7.
  const plan = mapEntryMusic(mapId, {
    ff2Ready: ff2MusicReady(),
    pendingTrack: transSt.pendingTrack,
    ff2ElderTrack: FF2_TRACKS.ELDER_HOUSE,
  });
  if (plan.kind === 'ff2') {
    // Clear any queued FF3 track so the entry transition won't start FF3 music
    // over the FF2 house theme.
    transSt.pendingTrack = null;
    stopMusic();
    playFF2Track(plan.track);
  } else {
    stopFF2Music();
    // 'deferred' means a transition already owns the start; 'none' means this
    // map slot was never measured.
    if (plan.kind === 'ff3') playTrack(plan.song);
  }
}

export function setupTopBox(mapId, isWorldMap) {
  if (isWorldMap) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.nameBytes = null;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = 4;
    return;
  }
  if (isDungeonMapId(mapId)) {
    const romMap = resolveDungeonDonor(mapId);
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + romMap] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.loadingBgFadeFrames = result.fadeFrames;
    // ⛔ WAS A LITERAL "Altar Cave" FOR EVERY DUNGEON. The Cave of Seals opened
    // under Altar Cave's banner; the registry row has carried the right name
    // the whole time. See `dungeon/labels.js`.
    topBoxSt.nameBytes = dungeonLabels(dungeonForMapId(mapId)).nameBytes;
    hudSt.topBoxMode = 'battle';
    topBoxSt.isTown = false;
    topBoxSt.state = 'none';
    topBoxSt.fadeStep = 4;
    return;
  }
  // ⭐ Keyed per map, not `mapId === 114`, and NOT latched on `topBoxSt.isTown`.
  //
  // The old test named exactly one map, so Kazus and Castle Sasune — both of
  // which the real ROM names on entry, measured off the PPU — opened with a
  // battle-scene strip. Ur's shops only kept the banner because the else-branch
  // below is skipped while `isTown` is still true from walking in; load a save
  // made inside a shop and `isTown` starts false, so even Ur's rooms lost it.
  //
  // `BANNER_FOR_MAP` covers head maps AND their interiors, so the name is right
  // however the map was reached. Per-map rather than per-town because map 29
  // names ITSELF ("Sasune Throne Room") from inside Castle Sasune's interior —
  // a latched banner could never repaint on the way in.
  const banner = BANNER_FOR_MAP.get(mapId);
  if (banner) {
    if (!topBoxSt.isTown) { topBoxSt.state = 'pending'; }
    topBoxSt.isTown = true;
    topBoxSt.nameBytes = banner;
    hudSt.topBoxMode = 'name';
  } else if (!topBoxSt.isTown) {
    const bgId = romRaw[BATTLE_BG_MAP_LOOKUP + mapId] & 0x1F;
    const result = renderBattleBg(romRaw, bgId);
    hudSt.topBoxBgCanvas = result.bgCanvas;
    hudSt.topBoxBgFadeFrames = result.fadeFrames;
    hudSt.topBoxMode = 'battle';
  }
}

export function loadMapById(mapId, returnX, returnY) {
  // Entering a town / dungeon FROM overworld? Capture the entrance tile
  // before flipping `mapSt.onWorldMap`, so:
  //   1. `ps.lastWorldExitX/Y` (death respawn point) updates to the
  //      entrance tile. Dying inside the Altar Cave then dumps the
  //      player back at the cave entrance on overworld, not at the
  //      last town gate they walked through.
  //   2. The `saveSlotsToDB` here fires while `onWorldMap` is still
  //      true, so the position getter (v1.7.268, overworld-only) accepts
  //      and writes the entrance into the slot. Logging out inside the
  //      dungeon then reloads at the same entrance.
  if (mapSt.onWorldMap) {
    ps.lastWorldExitX = Math.floor(mapSt.worldX / TILE_SIZE);
    ps.lastWorldExitY = Math.floor(mapSt.worldY / TILE_SIZE);
    saveSlotsToDB();
  }
  mapSt.onWorldMap = false;
  setupTopBox(mapId, false);
  if (isDungeonMapId(mapId)) { _loadDungeonFloor(mapId, returnX, returnY); }
  else {
    // Leaving dungeon → respawn the boss next time we re-enter.
    battleSt.enemyDefeated = false;
    _loadRegularMap(mapId, returnX, returnY);
  }
  // Secondary save for inventory / HP / etc. picked up between the
  // entrance and the new map load. Position is null (onWorldMap=false
  // now), so this won't touch the entrance coords we just wrote.
  saveSlotsToDB();
}

function _landOnWorldMap(tileX, tileY) {
  mapSt.worldX = tileX * TILE_SIZE;
  mapSt.worldY = tileY * TILE_SIZE;
  mapSt.disabledTrigger = { x: tileX, y: tileY };
  mapSt.moving = false;
  sprite.setDirection(DIR_DOWN);
  sprite.resetFrame();
  // Death-respawn point: any time the player lands on overworld (from a town
  // exit, dungeon exit, or warp), this is "the last place they exited" — used
  // as the respawn target if they die on overworld later.
  ps.lastWorldExitX = tileX;
  ps.lastWorldExitY = tileY;
  playTrack(TRACKS.WORLD_MAP);
}

export function loadWorldMapAt(trigId) {
  _resetPerMapState();
  mapSt.onWorldMap = true;
  battleSt.enemyDefeated = false; // boss respawns whenever player exits to the world map
  clearNpcs();
  setupTopBox(0, true);
  const pos = mapSt.worldMapData.triggerPositions.get(trigId);
  const tileX = pos ? pos.x : 0;
  const tileY = pos ? pos.y : 0;
  _landOnWorldMap(tileX, tileY);
  saveSlotsToDB();
}

export function loadWorldMapAtPosition(tileX, tileY) {
  _resetPerMapState();
  mapSt.onWorldMap = true;
  battleSt.enemyDefeated = false;
  clearNpcs();
  setupTopBox(0, true);
  _landOnWorldMap(tileX, tileY);
  saveSlotsToDB();
}

// Wipe-and-respawn after a player KO. Single chokepoint for the post-death
// load: battle-update calls this after resetting hp/mp/death timers.
//
// Rule: always respawn at the LAST OVERWORLD EXIT POINT (`ps.lastWorldExitX/Y`,
// set by `_landOnWorldMap` whenever the player lands on the world map from a
// town/dungeon exit or warp). This means:
//   - Die on overworld → respawn at the spot you most recently came out of a
//     structure (the meaningful "checkpoint").
//   - Die in a dungeon → respawn OUTSIDE the dungeon on the world map at its
//     overworld entrance tile. You lose dungeon progress; this matches the
//     user's expectation that "death dumps you outside the cave, not at floor
//     1's entrance tile inside it" (caught 2026-05-09 — Altar Cave death sent
//     player to the cave's interior entrance, which felt like progress retained
//     when really HP/MP got restored without leaving the dungeon).
//   - Die in a town → respawn outside on overworld, same rule.
//
// Fallback: if `lastWorldExitX/Y` is null (fresh save that died in its very
// first encounter before ever exiting Ur), fall back to `ps.lastTown` (default
// Ur, 114).
export function respawnAfterDeath() {
  // Death in Ur (the starting town) sends the player back to the
  // opening-scene spawn at map 7 (4, 4) — the "home/safe haven"
  // checkpoint. mapStack reseeds with the canonical Ur → elder house
  // ground floor (map 6) → upstairs (map 7) path so walking out drops
  // the player back at Ur via the natural door chain.
  //
  // Gate on `!onWorldMap`: `currentMapId` is *not* cleared when stepping
  // out onto the overworld, so without this gate dying on the world map
  // anywhere after having last exited Ur would also dump you at the
  // elder's house. The rule is "die *inside* Ur town" — overworld deaths
  // fall through to the lastWorldExitX/Y path below.
  if (!mapSt.onWorldMap && mapSt.currentMapId === 114) {
    triggerWipe(() => {
      mapSt.dungeonFloor = -1;
      mapSt.encounterSteps = 0;
      mapSt.mapStack = [
        { mapId: 114, x:  9 * TILE_SIZE, y: 26 * TILE_SIZE },
        { mapId:   6, x: 12 * TILE_SIZE, y: 13 * TILE_SIZE },
      ];
      loadMapById(7, 4, 4);
    }, 7);
    return;
  }
  const exitX = ps.lastWorldExitX;
  const exitY = ps.lastWorldExitY;
  const useExit = exitX != null && exitY != null;
  const fallbackMapId = ps.lastTown || 114;
  // Pass a concrete destMapId so `rosterLocChanged` computes correctly
  // (`triggerWipe` returns false when destMapId is null — pre-v1.7.227
  // the world-exit respawn path skipped the trans-fade and let the
  // 400 ms battle fade ramp in *during* the 733 ms wipe-close,
  // brightening the roster panel under the closing bars).
  // `rosterLocForMapId('world')` returns 'world' — the roster module
  // already handles the string sentinel.
  const destForFade = useExit ? 'world' : fallbackMapId;
  triggerWipe(() => {
    mapSt.dungeonFloor = -1;
    mapSt.encounterSteps = 0;
    mapSt.mapStack = [];
    if (useExit) {
      loadWorldMapAtPosition(exitX, exitY);
    } else {
      loadMapById(fallbackMapId);
    }
  }, destForFade);
}
