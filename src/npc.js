// NPC runtime — active NPC list, sprite render, tile-based interaction
// lookup, FF-style wander.
//
// Single source of truth for every NPC-style sprite in ff3mmo:
//   - moogle (wander)            — gfxId 42, MOOGLE_PAL
//   - black-mage shopkeeper      — gfxId 4 (BM walk bank), BM palette
//   - opening-scene NPCs         — raw ROM bundle offsets (data/opening-scene.js)
//   - boss-on-map (Land Turtle)  — pre-rendered canvas frames
//   - loading-screen sprites     — pulled by `loading-screen.js` via getters below
//
// See [[ff3mmo-one-npc-module]] for the rule. New NPC types extend the
// helpers + render dispatch here — no parallel render paths.

import { NPCS } from './data/npcs.js';
import { romRaw } from './boot.js';
import { mapSt } from './map-state.js';
import { msgState, showMsgBoxPages, dismissMsgBox } from './message-box.js';
import { sendNetInvEvent, SERVER_ECONOMY, sendNetQuestClaim, setNetQuestResultHandler,
         sendNetInvStateRequest, nextChestTxnId } from './net.js';
import { openWordMenu } from './word-menu.js';
import { talkQuest, revertQuestHandIn } from './quests.js';
import { QUESTS } from './data/quests.js';
import { _nameToBytes } from './text-utils.js';
import { sprite as playerSprite } from './player-sprite.js';
import { Sprite, DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { MOOGLE_GFX_ID, MOOGLE_PAL } from './sprite-init.js';
import { BM_WALK_TOP, BM_WALK_BTM } from './job-sprites.js';
import { OPENING_ELDER, OPENING_LEFT_ATTENDANT, OPENING_RIGHT_ATTENDANT, OPENING_INTRO } from './data/opening-scene.js';
import { transSt } from './transitions.js';
import { TOWN_NPCS } from './data/town-npcs.js';
// The map is the authority on how it colours people — see data/npc-palette.js.
// Node-clean and shared with the gate so the rule lives in exactly one place.
import { mapPalettesForSpec } from './data/npc-palette.js';
import { isOpenAreaTile } from './data/npc-walk-area.js';
import { openShop } from './shop.js';
import { waterSt } from './water-animation.js';
import { battleSt } from './battle-state.js';
import { ps, grantGil, grantExp } from './player-stats.js';
import { addItem } from './inventory.js';
import { playSFX, SFX } from './music.js';
import { saveSlotsToDB } from './save-state.js';

// Wind Crystal dialogue — condensed from the FF3 NES Altar-Cave crystal event
// (disassembly event $4B / $C5, strings $1D/$1E). First talk = the blessing;
// repeat talks = a flavor line + full restore (FF3 $C5 clears status + refills
// HP/MP). See [[ff3mmo-crystal-reveal]].
// Pages must wrap to <=3 lines at 16 chars/line (box is 144px wide, 48px tall).
const CRYSTAL_BLESSING = [
  'The crystal light is slowly fading...',
  "'You are the chosen Light Warrior.'",
  "'Take the last of my fading light.'",
  'Jobs unlocked! Use the menu to switch.',
  "'Do not let this world vanish.'",
  'Light surrounds you.',
];
// Crystal flash duration (mirrors the pond-drink screen strobe — reuses the
// shared `mapSt.pondStrobeTimer` viewport strobe). 65 frames @ ~16.67ms.
const CRYSTAL_FLASH_MS = Math.round(65 * 16.67);
const CRYSTAL_REVISIT = [
  'The crystal sheds its light in silence...',
  "'Light Warrior, bring hope to this world.'",
  'HP and MP restored.',
];

const TILE_SIZE = 16;

const WALK_DURATION_MS = 480;
// Yield-to-player walk: half the normal duration so the NPC visibly hops out
// of the player's way without making them wait. Triggered from
// movement.js#startMove when the player tries to step onto an NPC tile.
// v1.7.693.
const YIELD_DURATION_MS = 240;
const PAUSE_MIN_MS     = 1500;
const PAUSE_MAX_MS     = 4000;
const WALK_RUN_MIN     = 1;     // tiles per wander burst
const WALK_RUN_MAX     = 3;
const MOOGLE_LEASH     = 2;     // max Chebyshev tiles the cave moogle wanders from its spawn
const IDLE_MARCH_MS    = 480;   // walk-cycle period for stationary NPCs

let _npcs = [];

// ── Sprite asset registry ──────────────────────────────────────────────────
// Pre-rendered canvas frames live here as the single source. Producers
// (sprite-init.js consumers in boot.js) set; consumers (loading-screen.js,
// drawNpcs below) read via getters.
let _landTurtleFrames = null;        // [normal16, flipped16]
let _landTurtleFadeFrames = null;    // [[normal, flipped], ...] per fade level
let _loadingMoogleFadeFrames = null; // [[normal, flipped], ...] per fade level
let _crystalFrames = null;           // [frameA, frameB, frameC] — 16×32 Wind Crystal

export function setLandTurtleFrames(f)        { _landTurtleFrames = f; }
export function getLandTurtleFrames()         { return _landTurtleFrames; }
export function setCrystalFrames(f)           { _crystalFrames = f; }
export function getCrystalFrames()            { return _crystalFrames; }

// Land Turtle → Wind Crystal reveal timing (overworld, on defeat).
const CRYSTAL_BLINK_MS     = 720;    // total blink phase (~4 blinks before morph)
const CRYSTAL_BLINK_PERIOD = 90;     // visible/hidden toggle interval
const CRYSTAL_ANIM_MS      = 140;    // crystal shimmer frame hold

// Flip the existing boss NPC into the blink→crystal reveal. Called on defeat
// instead of removeBossNpc — the turtle stays on the tile, blinks a few times
// once the battle HUD exits (updateNpcs only ticks in the overworld), then
// morphs into the standing crystal. See [[ff3mmo-crystal-reveal]].
export function startCrystalReveal() {
  const boss = _npcs.find(n => n.key === 'boss_land_turtle');
  if (boss) boss.reveal = { phase: 'blink', t: 0 };
}

// Place the already-revealed Wind Crystal (no blink) — used by map-loading when
// re-entering the Crystal Room with the turtle already defeated this run.
export function addCrystalNpc(tileX, tileY) {
  const npc = _makeNpc('boss_land_turtle', tileX, tileY, { spriteKey: 'boss', mode: 'static' });
  npc.reveal = { phase: 'crystal', t: 0 };
  _npcs.push(npc);
}
export function setLandTurtleFadeFrames(f)    { _landTurtleFadeFrames = f; }
export function getLandTurtleFadeFrames()     { return _landTurtleFadeFrames; }
export function setLoadingMoogleFadeFrames(f) { _loadingMoogleFadeFrames = f; }
export function getLoadingMoogleFadeFrames()  { return _loadingMoogleFadeFrames; }

// ── Sprite-class resolver (moogle / black mage / scene) ────────────────────
// Each entry returns a `Sprite` instance bound to its bank + palette. Cached
// so we don't rebuild the tile cache on every frame.
const _spriteCache = new Map();
const _SPRITE_FACTORIES = {
  moogle: () => {
    const s = new Sprite(romRaw, MOOGLE_PAL, MOOGLE_PAL);
    s.setGfxID(MOOGLE_GFX_ID);
    return s;
  },
  black_mage: () => {
    const s = new Sprite(romRaw, BM_WALK_TOP, BM_WALK_BTM);
    s.setGfxID(4); // jobIdx 4 = Black Mage walk-sprite GFX bank
    return s;
  },
  scene: (npc) => {
    const spec = npc.scene;
    const s = new Sprite(romRaw, spec.palTop, spec.palBtm);
    s.gfxBase = spec.romOffset; // raw ROM bundle (header-inclusive, see [[ff3mmo-ines-header-romraw-vs-header-stripped]])
    s.tileCache.clear();
    return s;
  },
};
function _getSprite(npc) {
  if (!romRaw) return null;
  // Scene NPCs are per-key (different ROM bundles); moogle/BM share one.
  const cacheKey = npc.spriteKey === 'scene' ? `scene:${npc.key}` : npc.spriteKey;
  let s = _spriteCache.get(cacheKey);
  if (s) return s;
  const factory = _SPRITE_FACTORIES[npc.spriteKey];
  if (!factory) return null;
  s = factory(npc);
  _spriteCache.set(cacheKey, s);
  return s;
}

// ── NPC record factory ─────────────────────────────────────────────────────
// All NPCs share this skeleton. `add*` helpers below differ only in
// spriteKey + mode + role-specific fields (dialogue / shopId / scene spec).
function _makeNpc(key, tileX, tileY, opts) {
  return {
    key,
    tileX, tileY,
    spriteKey:  opts.spriteKey,
    dialogue:   opts.dialogue || null,
    shopId:     opts.shopId   || null,
    scene:      opts.scene    || null,
    mode:       opts.mode,
    timer:      opts.mode === 'pause' ? _randPauseMs() : 0,
    pixelOffX:  0,
    pixelOffY:  0,
    walkDX:     0,
    walkDY:     0,
    walkFromX:  tileX,
    walkFromY:  tileY,
    walkDur:    WALK_DURATION_MS,   // per-walk duration override (yield uses faster)
    dir:        opts.dir != null ? opts.dir : DIR_DOWN,
    talkFacing: null,
    runRemaining: 0,
  };
}

// ── Public API: clear / add / query ────────────────────────────────────────

export function clearNpcs() { _npcs = []; }

export function addMoogle(tileX, tileY) {
  const entry = NPCS.get('altar_moogle');
  const npc = _makeNpc('altar_moogle', tileX, tileY, {
    spriteKey: 'moogle',
    dialogue:  (entry && entry.dialogue) || [],
    mode:      'pause',
  });
  // Wanders, but stays near the chamber center — leashed to within MOOGLE_LEASH
  // tiles of its spawn so it's always findable. v1.7.561.
  npc.homeX = tileX; npc.homeY = tileY; npc.leash = MOOGLE_LEASH;
  _npcs.push(npc);
}

// Stationary shopkeeper NPC — walks in place; opens `shopId` on Z.
export function addBlackMageShopkeeper(tileX, tileY, shopId) {
  _npcs.push(_makeNpc('bm_shop', tileX, tileY, {
    spriteKey: 'black_mage',
    shopId,
    mode:      'idle-march',
  }));
}

// Boss NPC (Land Turtle on the altar floor). Battle trigger + walk-onto
// blocker still go through `mapSt.bossSprite` in `movement.js` —
// `addBossNpc` only owns the visual render path.
export function addBossNpc(tileX, tileY) {
  _npcs.push(_makeNpc('boss_land_turtle', tileX, tileY, {
    spriteKey: 'boss',
    mode:      'static',
  }));
}

// v1.7.454 — drop the boss NPC from the active list on defeat. The
// map-loading path gates new spawns on `battleSt.enemyDefeated`, but the
// already-pushed NPC entry was never removed, so the boss sprite stayed
// on-screen after the dissolve. On next dungeon reload `addBossNpc` runs
// again because clearNpcs() ran at map load.
export function removeBossNpc() {
  _npcs = _npcs.filter(n => n.key !== 'boss_land_turtle');
}

// Scene NPC — backed by the player Sprite class with `gfxBase` overridden
// to a raw FF3 ROM walk bundle (see data/opening-scene.js). Behavior modes
// (mutually exclusive, priority top→down):
//   spec.wander === true → FF-style burst-and-pause wander (1–3 tile runs,
//     1.5–4 s pauses). Uses `spec.leash` (default 3 tiles Chebyshev) to keep
//     the NPC near their spawn so they don't migrate across the map. v1.7.694.
//   spec.animate === true → idle-march (walk-cycle in place, no movement).
//   otherwise → static (frame 0, no animation — no fabricated motion, see
//     [[never-add-fake-content-user-didnt-ask-for]]).
export function addSceneNpc(key, tileX, tileY, spec) {
  const mode = spec.wander ? 'pause' : (spec.animate ? 'idle-march' : 'static');
  const npc = _makeNpc(key, tileX, tileY, {
    spriteKey: 'scene',
    scene:     spec,
    dialogue:  spec.dialogue || null,
    mode,
    dir:       spec.dir,
  });
  if (spec.wander) {
    npc.homeX = tileX;
    npc.homeY = tileY;
    npc.leash = spec.leash != null ? spec.leash : 3;
  }
  _npcs.push(npc);
}

export function placeMoogleAtCaveCenter(mapData) {
  // Spiral out from Room A's column (the entry column) so the moogle lands in
  // the opening room, not the center gap between the two floor-1 rooms. v1.7.564.
  const cx = (mapData && mapData.entranceX != null) ? mapData.entranceX : 16;
  const cy = 9;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = cx + dx, ty = cy + dy;
        if (!_isOpenAreaTile(mapData, tx, ty)) continue;
        addMoogle(tx, ty);
        return true;
      }
    }
  }
  return false;
}

// Map 7 (new-game spawn) opening scene: elder facing south, two
// attendants flanking the player and facing inward. Player spawns at
// (4, 4); elder 1N, attendants 2W + 2E. See [[ff3mmo-opening-scene-map-7]].
export function placeOpeningScene() {
  addSceneNpc('opening_elder', 4, 3, OPENING_ELDER);
  addSceneNpc('opening_left',  2, 4, OPENING_LEFT_ATTENDANT);
  addSceneNpc('opening_right', 6, 4, OPENING_RIGHT_ATTENDANT);
}

// Town keepers (shop NPCs behind counters) — data-driven from TOWN_NPCS.
// No-op for maps with no entry. Each keeper renders via the shared Sprite
// class; counter-bound, so they idle-march facing down (never talk-faced).
//
// Wandering town NPCs (spec.wander === true) re-roll their spawn on every
// map entry from a grass-tile pool, with `mapSt.encounterPatch` tiles
// excluded so they never spawn in a random-encounter zone. Static keepers
// (shops, quest_npc) keep their fixed `(n.x, n.y)`. v1.7.769.
//
// `TOWN_NPC_GRASS_TILES`: per-map metatile ids that count as "plain grass"
// for the random spawn pool. Read from the existing wanderer placements
// when adding a new map (e.g. Ur peach/quest/maiden land on 0x00 + sage
// on 0x01 — both included).
const TOWN_NPC_GRASS_TILES = new Map([
  [114, new Set([0x00, 0x01])],
]);

function _collectRandomSpawnPool(mapData, encounterPatch, tileIds) {
  const pool = [];
  for (let y = 1; y <= 30; y++) {
    for (let x = 1; x <= 30; x++) {
      const t = mapData.tilemap[y * 32 + x];
      if (!tileIds.has(t)) continue;
      if (encounterPatch && encounterPatch.has(y * 32 + x)) continue;
      if (!_isOpenAreaTile(mapData, x, y)) continue;
      pool.push([x, y]);
    }
  }
  return pool;
}

function _shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function placeTownNpcs(mapId) {
  const list = TOWN_NPCS.get(mapId);
  if (!list) return;
  const grassTiles = TOWN_NPC_GRASS_TILES.get(mapId);
  let pool = null;
  if (grassTiles && mapSt.mapData) {
    pool = _collectRandomSpawnPool(mapSt.mapData, mapSt.encounterPatch, grassTiles);
    _shuffleInPlace(pool);
  }
  let pi = 0;
  for (const n of list) {
    let x = n.x, y = n.y;
    // `fixedSpawn` keeps the declared (ROM) coordinates and still wanders from
    // there. The random pool is drawn from a map's "grass" tiles, and on Ur
    // those are lopsided — 164 candidates, but rows 20-23 alone hold ~75 of
    // them and rows 1-15 have almost none. Shuffling and taking the first N
    // therefore dropped nearly every wanderer into the south plaza, right where
    // the player walks in, while the ROM spreads the same ten people from row
    // 10 to row 28. The ROM's spacing is simply better than the shuffle.
    if (pool && n.spec.wander && !n.spec.fixedSpawn && pi < pool.length) {
      [x, y] = pool[pi++];
    }
    addSceneNpc(n.key, x, y, mapPalettesForSpec(n.spec, mapSt.mapData));
  }
}

// ── Opening-scene intro ──────────────────────────────────────────────────
// Scripted conversation between the elder + 2 attendants the moment a NEW
// GAME spawns the player at map 7 (4,4). Queued only from the fresh-slot
// path (title-screen.js) — never on a death-respawn or revisit to map 7. The
// open message box locks movement until the last page slides out; the player
// sprite turns to face whichever NPC is speaking. Afterward, each NPC's own
// `dialogue` plays on talk.
let _openingIntroPending = false;
export function queueOpeningIntro() { _openingIntroPending = true; }

export function tickOpeningIntro() {
  if (!_openingIntroPending) return;
  // Only fire on map 7, once the entry transition has settled and no box is up.
  if (mapSt.currentMapId !== 7) { _openingIntroPending = false; return; }
  if (transSt.state !== 'none' || msgState.state !== 'none') return;
  _openingIntroPending = false;

  const face = (i) => {
    const line = OPENING_INTRO[i];
    if (line && playerSprite) { playerSprite.setDirection(line.dir); playerSprite.resetFrame(); }
  };
  const pages = OPENING_INTRO.map(l => _nameToBytes(l.text));
  showMsgBoxPages(pages, () => {
    // Hand control back facing the elder (north) — where the player woke.
    if (playerSprite) { playerSprite.setDirection(DIR_UP); playerSprite.resetFrame(); }
  }, face);
}

export function findNpcAt(tileX, tileY) {
  for (const npc of _npcs) {
    if (npc.tileX === tileX && npc.tileY === tileY) return npc;
    if (npc.mode === 'walk' && npc.walkFromX === tileX && npc.walkFromY === tileY) return npc;
  }
  return null;
}

// ── Update tick ────────────────────────────────────────────────────────────

export function updateNpcs(dt) {
  if (_npcs.length === 0) return;
  if (msgState.state !== 'none') return;
  for (const npc of _npcs) {
    if (npc.reveal) { _tickReveal(npc, dt); continue; }
    _tickNpc(npc, dt);
  }
}

function _tickReveal(npc, dt) {
  npc.reveal.t += dt;
  if (npc.reveal.phase === 'blink' && npc.reveal.t >= CRYSTAL_BLINK_MS) {
    npc.reveal.phase = 'crystal'; npc.reveal.t = 0;   // morph; crystal holds forever
  }
}

function _tickNpc(npc, dt) {
  if (npc.mode === 'static') return;
  if (npc.mode === 'idle-march') {
    npc.timer = (npc.timer + dt) % (IDLE_MARCH_MS * 2);
    return;
  }
  npc.timer -= dt;
  if (npc.mode === 'pause') {
    if (npc.timer > 0) return;
    // Start a new walk burst: pick a direction + a 1..3-tile run length.
    npc.runRemaining = WALK_RUN_MIN + Math.floor(Math.random() * (WALK_RUN_MAX - WALK_RUN_MIN + 1));
    _startWalk(npc);
    return;
  }
  // mode === 'walk'
  if (npc.timer <= 0) {
    npc.tileX = npc.walkFromX + npc.walkDX;
    npc.tileY = npc.walkFromY + npc.walkDY;
    npc.pixelOffX = 0;
    npc.pixelOffY = 0;
    npc.runRemaining--;
    if (npc.runRemaining > 0 && _trySameDir(npc)) return;
    npc.mode = 'pause';
    npc.timer = _randPauseMs();
    return;
  }
  const progress = 1 - (npc.timer / npc.walkDur);
  npc.pixelOffX = Math.round(npc.walkDX * TILE_SIZE * progress) - npc.walkDX * TILE_SIZE;
  npc.pixelOffY = Math.round(npc.walkDY * TILE_SIZE * progress) - npc.walkDY * TILE_SIZE;
}

// Same-direction continuation: keep dx/dy if the next tile is legal.
function _trySameDir(npc) {
  if (!mapSt.mapData) return false;
  const dx = npc.walkDX, dy = npc.walkDY;
  const tx = npc.tileX + dx, ty = npc.tileY + dy;
  if (!_isOpenAreaTile(mapSt.mapData, tx, ty)) return false;
  if (_tileOccupied(tx, ty, npc)) return false;
  if (npc.leash != null && (Math.abs(tx - npc.homeX) > npc.leash || Math.abs(ty - npc.homeY) > npc.leash)) return false;
  npc.mode = 'walk';
  npc.walkDur = WALK_DURATION_MS;
  npc.timer = WALK_DURATION_MS;
  npc.walkFromX = npc.tileX;
  npc.walkFromY = npc.tileY;
  npc.tileX = tx;
  npc.tileY = ty;
  npc.pixelOffX = -dx * TILE_SIZE;
  npc.pixelOffY = -dy * TILE_SIZE;
  return true;
}

function _startWalk(npc) {
  if (!mapSt.mapData) { npc.timer = _randPauseMs(); return; }
  const dirs = _shuffledDirs();
  for (const [dx, dy] of dirs) {
    const tx = npc.tileX + dx, ty = npc.tileY + dy;
    if (!_isOpenAreaTile(mapSt.mapData, tx, ty)) continue;
    if (_tileOccupied(tx, ty, npc)) continue;
    if (npc.leash != null && (Math.abs(tx - npc.homeX) > npc.leash || Math.abs(ty - npc.homeY) > npc.leash)) continue;
    npc.mode = 'walk';
    npc.walkDur = WALK_DURATION_MS;
    npc.timer = WALK_DURATION_MS;
    npc.walkFromX = npc.tileX;
    npc.walkFromY = npc.tileY;
    npc.walkDX = dx;
    npc.walkDY = dy;
    npc.tileX = tx;
    npc.tileY = ty;
    npc.pixelOffX = -dx * TILE_SIZE;
    npc.pixelOffY = -dy * TILE_SIZE;
    npc.dir = _dxDyToDir(dx, dy);
    return;
  }
  npc.runRemaining = 0;
  npc.timer = _randPauseMs();
}

// Player tried to step onto this NPC's tile and got blocked (movement.js#
// startMove). Hop the NPC quickly to a neighboring tile so the player can
// pass. Prefers perpendicular sidesteps; falls back to "further in the
// direction the player was heading"; never picks the tile the player is
// standing on. Relaxes the wander's open-area requirement (FLOOR only —
// the NPC can step into a corridor temporarily; their next wander will
// route them back to open space once the player walks past).
// Returns true on a successful yield. v1.7.693.
//
// **Yields on the 2nd distinct bump**, not the first (v1.7.712,
// edge-detected via `isNewPress` in v1.7.713). The 1st bump just blocks
// ("hey, watch it"); a follow-up press makes them step aside ("oh, you
// really do want through").
//
// `isNewPress` is computed in movement.js#startMoveFromKeys — true only
// on the tick where the player FIRST presses an arrow (or switches
// direction) after a tick where it wasn't pressed. Holding the arrow
// down doesn't generate repeated isNewPress=true, so the count stays at
// 1 through any continuous hold. Releasing + re-pressing produces a
// second isNewPress=true → count hits 2 → yield. Counter resets after
// `BUMP_RESET_MS` of no contact so a much-later first bump still needs
// a follow-up.
const BUMP_RESET_MS  = 2000;
const BUMPS_TO_YIELD = 2;
export function tryYieldToPlayer(npc, playerDir, isNewPress) {
  if (!mapSt.mapData) return false;
  if (npc.mode === 'walk') return false;       // already moving — let the current step finish, the player can press again next frame
  if (npc.mode === 'static' || npc.mode === 'idle-march') return false;
  if (npc.reveal) return false;                // crystal reveal etc.
  if (npc.talkFacing != null) return false;    // in dialogue

  // Time-based reset so an idle player walking back to the same NPC later
  // starts fresh at bump 1 instead of yielding immediately.
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (!npc._bumpAt || (now - npc._bumpAt) > BUMP_RESET_MS) {
    npc._bumpCount = 0;
  }
  npc._bumpAt = now;
  // Continued hold of the same direction (no fresh press this tick) —
  // doesn't count as a new bump. Player must release + re-press to
  // increment.
  if (!isNewPress) return false;
  npc._bumpCount = (npc._bumpCount || 0) + 1;
  if (npc._bumpCount < BUMPS_TO_YIELD) return false;
  npc._bumpCount = 0;   // reset for the next interaction
  const pdx = playerDir === DIR_RIGHT ? 1 : playerDir === DIR_LEFT ? -1 : 0;
  const pdy = playerDir === DIR_DOWN  ? 1 : playerDir === DIR_UP   ? -1 : 0;
  // Candidate priority:
  //   perpendicular to the player's facing (both sides, random order)
  //   then "away" — same direction the player was heading, lets the NPC
  //   continue down the path instead of stepping back into the player.
  const perp = (pdy === 0) ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
  if (Math.random() < 0.5) perp.reverse();
  const candidates = [perp[0], perp[1], [pdx, pdy]];
  for (const [dx, dy] of candidates) {
    const tx = npc.tileX + dx, ty = npc.tileY + dy;
    if (tx < 1 || tx > 30 || ty < 1 || ty > 30) continue;
    if (!_isWalkableForNpc(mapSt.mapData, tx, ty)) continue;
    if (_tileOccupied(tx, ty, npc)) continue;
    if (npc.leash != null && (Math.abs(tx - npc.homeX) > npc.leash || Math.abs(ty - npc.homeY) > npc.leash)) continue;
    npc.mode = 'walk';
    npc.walkDur = YIELD_DURATION_MS;
    npc.timer = YIELD_DURATION_MS;
    npc.walkFromX = npc.tileX;
    npc.walkFromY = npc.tileY;
    npc.walkDX = dx;
    npc.walkDY = dy;
    npc.tileX = tx;
    npc.tileY = ty;
    npc.pixelOffX = -dx * TILE_SIZE;
    npc.pixelOffY = -dy * TILE_SIZE;
    npc.dir = _dxDyToDir(dx, dy);
    npc.runRemaining = 0;   // single-tile hop; pause cycle resumes after
    return true;
  }
  return false;
}

function _dxDyToDir(dx, dy) {
  if (dx > 0) return DIR_RIGHT;
  if (dx < 0) return DIR_LEFT;
  if (dy > 0) return DIR_DOWN;
  if (dy < 0) return DIR_UP;
  return DIR_DOWN;
}

// Collision-based walkability for any tileset — the cave-floor 0x30 hardcode
// only worked for tileset 0 (caves). Now reads cb1: low 3 bits === 3 = solid
// wall, bit 7 = trigger (door/chest/etc — not wander floor). v1.7.694 — town
// NPCs on Ur (tileset 4, floor tile 0x00 / 0x21) need this. Cave NPCs still
// pass since cave 0x30 has cb1 walkable.
function _isWalkableForNpc(mapData, x, y) {
  if (x < 0 || x > 31 || y < 0 || y > 31) return false;
  const t = mapData.tilemap[y * 32 + x];
  const m = t < 128 ? t : t & 0x7F;
  const cb1 = mapData.collision[m];
  if ((cb1 & 0x07) === 3) return false;   // solid wall
  if ((cb1 & 0x07) === 2) return false;   // water — NPCs don't swim (v1.7.714 RED-in-pond bug)
  if (cb1 & 0x80) return false;           // trigger — keep NPCs off doors/chests/passage tiles
  return true;
}

// Delegates to data/npc-walk-area.js so the placement gate can test the SAME
// rule. A gate with its own copy of this drifts, and the thing it guards
// against — a wanderer placed somewhere it can never step off — is invisible
// until someone walks up to it.
const _isOpenAreaTile = (mapData, x, y) => isOpenAreaTile(mapData, x, y);

function _tileOccupied(tx, ty, selfNpc) {
  // Player straddles two tiles mid-walk (lerped worldX/worldY). Treat both
  // the player's FROM and TO tiles as occupied so a wandering NPC never
  // steps into the player's destination during a player walk.
  const pfx = Math.floor(mapSt.worldX / TILE_SIZE);
  const pcx = Math.ceil(mapSt.worldX  / TILE_SIZE);
  const pfy = Math.floor(mapSt.worldY / TILE_SIZE);
  const pcy = Math.ceil(mapSt.worldY  / TILE_SIZE);
  if ((tx === pfx || tx === pcx) && (ty === pfy || ty === pcy)) return true;
  for (const other of _npcs) {
    if (other === selfNpc) continue;
    if (other.tileX === tx && other.tileY === ty) return true;
    if (other.mode === 'walk' && other.walkFromX === tx && other.walkFromY === ty) return true;
  }
  return false;
}

const _DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function _shuffledDirs() {
  const a = _DIRS.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function _randPauseMs() {
  return PAUSE_MIN_MS + Math.floor(Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
}

// ── Render ─────────────────────────────────────────────────────────────────

// Walk-frame phase 0..1 (null = hold frame 0). Wander uses walk-duration
// timing; in-place "idle-march" uses its own period.
function _walkPhase(npc) {
  if (npc.talkFacing != null) return null; // hold pose while talking
  if (npc.mode === 'walk')       return 1 - (npc.timer / npc.walkDur);
  if (npc.mode === 'idle-march') return (npc.timer / IDLE_MARCH_MS) % 1;
  return null;
}

// Quest reward payout. Routed through the same grantGil / grantExp the battle
// rewards use, so the server's inventory mirror sees it the way it sees any
// other gain rather than through a second, unvalidated path.
function _grantQuestReward(reward, questId) {
  if (!reward) return;
  // The item comes FIRST because a full bag is the one failure worth stopping
  // for, and it is knowable right here — addItem returns 0 when the bag is
  // full. The server applies a claim all-or-nothing (economy-arbiter.js
  // #validateQuestClaim rejects on inv-full without marking the ledger), so
  // paying the gil now and dropping the heirloom would put the two halves out
  // of step on a reward that can only ever be handed over once.
  if (reward.item) {
    if (addItem(reward.item, 1) <= 0) {
      revertQuestHandIn(questId);
      _questNotice = { questId, pages: ['Your pack is full.', 'Come back for it.'] };
      return;
    }
  }
  if (reward.gil) grantGil(reward.gil);
  // exp needs no event — main.js ignores exp from inv-state ("NOT wire-managed;
  // the mirror only snapshots it at /api/save time"), so the local value is
  // canonical until the save round-trip carries it.
  if (reward.exp) grantExp(reward.exp);

  if (SERVER_ECONOMY) {
    // v1.8.6 — the server looks the reward up in its own copy of the quest
    // table and pays it at most once per (user, slot, quest). Replaced a bare
    // `gil-delta` that named its own amount, which made a hand-in worth 300
    // gil per page reload for as long as the player cared to keep reloading.
    sendNetQuestClaim({ txnId: nextChestTxnId(), questId });
  } else if (reward.gil) {
    // Legacy path, flag off: gil is WIRE-MANAGED — the mirror in inv_economies
    // is authoritative and the next inv-state push overwrites ps.gil. Without
    // an emit the quest paid out on screen and the reward vanished at the next
    // sync. v1.7.994.
    sendNetInvEvent('gil-delta', 0, reward.gil, 'quest');
    if (reward.item) sendNetInvEvent('add', reward.item, 1, 'quest');
  }
}

// A rejected claim has to reach the PLAYER, not just pm2 — a server verdict
// with no client branch is a silent failure. The reject lands ~100 ms after
// the hand-in, while the giver's "Take this" pages are still up, so the notice
// is stashed and shown the next time they are talked to rather than stamped
// over an open box.
let _questNotice = null;

setNetQuestResultHandler((msg) => {
  if (!msg || msg.status === 'ok') return;
  const questId = String(msg.questId || '');
  if (msg.reason === 'already-claimed') {
    // The server had already paid this one — the local save was behind (an
    // older client, or a hand-in that never made it to disk). Keep the quest
    // finished and let the mirror correct the gil we just added on screen.
    sendNetInvStateRequest();
    console.warn('[quest] server had already paid ' + questId + ' — resyncing gil');
    return;
  }
  // Anything else (economy-disabled, unknown-quest, bad-reward-item, a lost
  // ledger race): nothing was paid server-side, so put the quest back to
  // waiting-to-hand-in and let them try again.
  revertQuestHandIn(questId);
  sendNetInvStateRequest();
  _questNotice = { questId, pages: ['He counts the coin.', 'Not yet, he says.', 'Ask again.'] };
  console.warn('[quest] claim rejected for ' + questId + ' reason=' + (msg.reason || '?'));
});

// Does this NPC owe the player a notice from a rejected claim?
function _takeQuestNotice(npc) {
  if (!_questNotice || !npc || !npc.key) return null;
  const quest = QUESTS[_questNotice.questId];
  if (!quest || quest.giver.mapId !== mapSt.currentMapId || quest.giver.npcKey !== npc.key) return null;
  const pages = _questNotice.pages;
  _questNotice = null;
  return pages;
}

export function drawNpcs(ctx, camX, camY, originX, originY, spriteY) {
  if (_npcs.length === 0) return;
  // Map tiles use `originY` (3px below `spriteY`); sprites use `spriteY` so
  // their feet align with the player on the same row.
  const wLeft = camX - originX;
  const wTop  = camY - (spriteY != null ? spriteY : originY);
  for (const npc of _npcs) {
    const sx = npc.tileX * TILE_SIZE + npc.pixelOffX - wLeft;
    const sy = npc.tileY * TILE_SIZE + npc.pixelOffY - wTop;
    if (sx < -16 || sx > 256 || sy < -16 || sy > 240) continue;

    if (npc.spriteKey === 'boss') {
      _drawBossNpc(ctx, sx, sy, npc);
      continue;
    }
    // Sprite-class NPCs (moogle / black_mage / scene).
    const s = _getSprite(npc);
    if (!s) continue;
    s.setDirection(npc.talkFacing != null ? npc.talkFacing : npc.dir);
    const phase = _walkPhase(npc);
    if (phase == null) s.resetFrame();
    else               s.setWalkProgress(phase);
    s.draw(ctx, sx, sy);

  }
}

function _drawBossNpc(ctx, sx, sy, npc) {
  ctx.imageSmoothingEnabled = false;
  const reveal = npc && npc.reveal;

  // Defeat reveal — crystal phase: standing Wind Crystal, shimmer-animated.
  // 16×32, bottom-aligned on the boss tile (extends one tile up).
  if (reveal && reveal.phase === 'crystal') {
    const cf = _crystalFrames;
    if (!cf) return;
    const ci = Math.floor(reveal.t / CRYSTAL_ANIM_MS) % cf.length;
    ctx.drawImage(cf[ci], sx, sy - 16);
    return;
  }

  const frames = _landTurtleFrames;
  if (!frames) return;

  // Defeat reveal — blink phase: turtle flashes a few times before morphing.
  if (reveal && reveal.phase === 'blink') {
    if (Math.floor(reveal.t / CRYSTAL_BLINK_PERIOD) & 1) return;  // hidden half-cycle
    ctx.drawImage(frames[0], sx, sy);
    return;
  }

  // Normal: blink-out during boss flash (spell impact), else 2-frame idle on
  // water-tick parity. Land Turtle only has south-facing frames in ROM.
  const blinkHidden = battleSt.bossFlashTimer > 0 && (Math.floor(battleSt.bossFlashTimer / 60) & 1);
  if (blinkHidden) return;
  const idx = Math.floor(waterSt.tick / 8) & 1;
  ctx.drawImage(frames[idx], sx, sy);
}

// ── Dialogue ───────────────────────────────────────────────────────────────

export function talkToNpc(npc) {
  if (!npc) return;
  // Wind Crystal (post-defeat reveal): blessing on first talk, full restore on
  // repeat — mirrors the FF3 Altar-Cave crystal event. Only once it's morphed
  // (crystal phase); a mid-blink talk is ignored.
  if (npc.reveal) {
    if (npc.reveal.phase === 'crystal') _talkToCrystal(npc);
    return;
  }
  // Shopkeeper NPC: open the linked shop directly. The shop UI takes over;
  // no dialogue box. Keep the NPC's south-facing pose (don't flip to player).
  if (npc.shopId) {
    openShop(npc.shopId);
    return;
  }
  // A quest giver says its quest line instead of its idle dialogue. Returns
  // null when this NPC has no quest, so everyone else is unaffected. A pending
  // reject notice outranks it — the player is owed an explanation before the
  // hand-in is offered again.
  const qPages = npc.key
    ? (_takeQuestNotice(npc) || talkQuest(mapSt.currentMapId, npc.key, _grantQuestReward))
    : null;
  if (qPages && qPages.length) {
    if (playerSprite) {
      const pd = playerSprite.getDirection();
      npc.talkFacing = pd === DIR_DOWN ? DIR_UP : pd === DIR_UP ? DIR_DOWN
                     : pd === DIR_LEFT ? DIR_RIGHT : DIR_LEFT;
    }
    _sayThenOfferWords(npc, qPages);
    return;
  }
  if (!npc.dialogue || npc.dialogue.length === 0) return;
  // NPC turns to face the player. Player's facing = direction they walked
  // INTO the NPC, so the NPC's talk-facing is the opposite axis.
  if (playerSprite) {
    const pdir = playerSprite.getDirection();
    if (pdir === DIR_DOWN)       npc.talkFacing = DIR_UP;
    else if (pdir === DIR_UP)    npc.talkFacing = DIR_DOWN;
    else if (pdir === DIR_LEFT)  npc.talkFacing = DIR_RIGHT;
    else if (pdir === DIR_RIGHT) npc.talkFacing = DIR_LEFT;
  }
  _sayThenOfferWords(npc, npc.dialogue);
}

// Show an NPC's lines, then hand off to the FF2-style ASK/LEARN menu if this
// NPC teaches or answers any Key Term. `keepOpen` parks the box on the last
// page so the verb list appears under a window that's still up — without it
// the box slides out and the menu floats on nothing.
function _sayThenOfferWords(npc, lines) {
  const bytes = lines.map(l => _nameToBytes(l));
  const spec  = npc.scene;
  const hasWords = !!(spec && ((spec.teaches && spec.teaches.length) ||
                               (spec.answers && Object.keys(spec.answers).length)));
  if (!hasWords) {
    showMsgBoxPages(bytes, () => { npc.talkFacing = null; });
    return;
  }
  showMsgBoxPages(bytes, () => {
    // openWordMenu returns false when there's nothing left to learn or ask —
    // then the box has to be closed by hand, since keepOpen suppressed it.
    if (!openWordMenu(npc, () => { npc.talkFacing = null; })) {
      npc.talkFacing = null;
      dismissMsgBox();
    }
  }, null, { keepOpen: true });
}

// Thunder + screen flash (reuses the pond-drink viewport strobe).
function _crystalFlash() {
  playSFX(SFX.CRYSTAL_THUNDER);
  mapSt.pondStrobeTimer = CRYSTAL_FLASH_MS;
}

// Flash → wait out the strobe → show the pages → flash again on close. Mirrors
// FF3 event $4B, where the thunder/flash bracket each crystal message.
function _crystalSpeak(pages) {
  _crystalFlash();
  setTimeout(() => {
    showMsgBoxPages(pages.map(p => _nameToBytes(p)), () => _crystalFlash());
  }, CRYSTAL_FLASH_MS);
}

function _talkToCrystal(npc) {
  if (!npc.crystalSpoken) {
    npc.crystalSpoken = true;          // first talk = the blessing (FF3 $4B)
    _crystalSpeak(CRYSTAL_BLESSING);
    return;
  }
  // Repeat talk = full restore (FF3 $C5: clear status + refill HP/MP) + flavor.
  if (ps.stats) { ps.hp = ps.stats.maxHP; ps.mp = ps.stats.maxMP; }
  if (ps.status) ps.status.mask = 0;
  saveSlotsToDB();
  _crystalSpeak(CRYSTAL_REVISIT);
}
