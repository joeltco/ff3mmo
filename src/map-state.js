// Map state — player position, map data, triggers, dungeon state, and world-fx effects
// triggered by map tile interactions (shake, star, pond flash).
//
// Single `mapSt` object so consumers read/write live values through object properties.

/**
 * v1.7.907 — fire triggers on APPROACH instead of on arrival.
 *
 * The ROM never lets the player stand on a trigger tile. All 17 trigger tiles
 * ($60-$63 events, $70-$77 doors, $78-$7C treasure) carry collision bit 7 in
 * all 7 tilesets — 119/119 — and both collision routines (3B/90EB, 3B/B0C5)
 * open `LDA $0400,Y / BMI blocked`, rejecting the tile without ever inspecting
 * the trigger type. The trigger fires from the attempt to enter.
 *
 * This engine grew up doing the opposite: walk ONTO the tile, then fire from
 * there, which forced `isPassable` to call trigger types 1/4 and collision
 * types 0/4/5 walkable. The cost is that type 1 is solid with nothing to fire
 * it, which is why maps 43, 96, 124 and 167 have no exit from their spawn.
 *
 * Flag lives here because `map-state.js` imports nothing — `map-renderer.js`
 * needs it and is imported BY `map-triggers.js`, so putting it there would
 * make a cycle.
 *
 * Scope is deliberately interior-only. The world map has its own tile-prop
 * system (`world-map-renderer.js#isPassable`, `props.byte1 & 0x80` → passable)
 * and entering a town by stepping onto it already works; nothing about the
 * type-1 problem lives out there, so it keeps the arrival model.
 *
 * Default OFF, following this codebase's own convention for risky core changes
 * (COOP_HOST_ARB, PVE_ARBITER and SERVER_ECONOMY all shipped dark and were
 * flipped in a later version after a smoke test). Every map that works today —
 * Ur, the shops, the elder house, the Altar Cave — traverses through this path,
 * and it cannot be verified headlessly. Flip it, walk Ur and the cave, then
 * ship the flip.
 */
export const TRIGGER_FIRE_ON_APPROACH = false;

export const mapSt = {
  // ── Position ──────────────────────────────────────────────────────
  worldX: 0,              // player world pixel X
  worldY: 0,              // player world pixel Y
  moving: false,          // true while step tween in progress

  // ── Map id / stack ────────────────────────────────────────────────
  currentMapId: 114,      // 114 = Ur (starting town)
  mapStack: [],           // [{mapId, x, y}] for exit_prev
  onWorldMap: false,

  // ── Map data ──────────────────────────────────────────────────────
  mapData: null,          // current indoor/dungeon tilemap + triggers
  mapRenderer: null,      // current MapRenderer instance
  worldMapData: null,     // parsed 128×128 world map (loaded once)
  worldMapRenderer: null, // WorldMapRenderer for world map

  // ── Dungeon ───────────────────────────────────────────────────────
  dungeonSeed: null,
  dungeonFloor: -1,
  dungeonDestinations: null, // Map<`${type}:${trigId}`, {mapId, destX, destY}> — composite key required because processTriggerTiles assigns trigIds per type independently (a type-1 trigId 0 and a type-4 trigId 0 are distinct triggers; before v1.7.691 the chamber-door / passage-entry collision on floor 2 routed the exit stairs into the locked room).

  // ── Map interaction state ─────────────────────────────────────────
  disabledTrigger: null,  // {x, y} — spawn exit_prev, disabled so player can't immediately exit
  openDoor: null,         // {x, y, tileId} — door shown open, swap back when player walks off
  secretWalls: null,
  falseWalls: null,
  hiddenTraps: null,
  lockedDoors: null,  // Set<"x,y"> — door coords that block movement +
                      // show "Locked." message on bump / A-press. v1.7.669.
  rockSwitch: null,
  warpTile: null,
  pondTiles: null,

  // ── Boss presence on map ──────────────────────────────────────────
  bossSprite: null,       // {frames, px, py} when boss is visible on floor

  // ── Encounter ─────────────────────────────────────────────────────
  encounterSteps: 0,
  // Indoor-map encounter patch (set when entering a town tile that
  // flood-fills into an encounter zone). Set<y*32+x> of tilemap indices
  // the player triggers random encounters on. Cleared on every map load
  // by the loader that opts in.
  encounterPatch: null,
  encounterPatchZone: null, // ENCOUNTERS key for the active patch (e.g. 'grasslands_wild')

  // ── World-fx (triggered by map tile interactions) ─────────────────
  shakeActive: false,
  shakeTimer: 0,
  shakePendingAction: null,
  starEffect: null,
  pondStrobeTimer: -1,
};
