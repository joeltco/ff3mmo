// Map state — player position, map data, triggers, dungeon state, and world-fx effects
// triggered by map tile interactions (shake, star, pond flash).
//
// Single `mapSt` object so consumers read/write live values through object properties.

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
