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
  dungeonDestinations: null, // Map<trigId, {mapId, destX, destY}>

  // ── Map interaction state ─────────────────────────────────────────
  disabledTrigger: null,  // {x, y} — spawn exit_prev, disabled so player can't immediately exit
  openDoor: null,         // {x, y, tileId} — door shown open, swap back when player walks off
  secretWalls: null,
  falseWalls: null,
  hiddenTraps: null,
  rockSwitch: null,
  warpTile: null,
  pondTiles: null,

  // ── Boss presence on map ──────────────────────────────────────────
  bossSprite: null,       // {frames, px, py} when boss is visible on floor

  // ── Encounter ─────────────────────────────────────────────────────
  encounterSteps: 0,

  // ── World-fx (triggered by map tile interactions) ─────────────────
  shakeActive: false,
  shakeTimer: 0,
  shakePendingAction: null,
  starEffect: null,
  pondStrobeTimer: -1,
};
