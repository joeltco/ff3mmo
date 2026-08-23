// labels.js — the text a dungeon shows ABOUT ITSELF.
//
// ⛔ WHY THIS EXISTS. The dungeon loading screen had four elements and exactly
// one of them knew which dungeon it was drawing. The Cave of Seals shipped with
// Altar Cave's banner, Altar Cave's floor count and the Land Turtle's HP over a
// correctly-resolved Djinn silhouette — three module-level constants with no
// dungeon parameter:
//
//     DUNGEON_NAME   = "Altar Cave"          (data/strings.js)
//     _FLOORS_BYTES  = "4 Levels"            (loading-screen.js)
//     _LODHP_BYTES   = "HP " + MONSTERS.get(DEFAULT_BOSS_ID).hp
//
// The registry already carried `name`, `floors` and `bossId` for both rows, so
// every one of the three was a field read away. A second dungeon is supposed to
// work by data alone (see the header in `data/dungeons.js`); text was the one
// axis where it did not.
//
// Memoized per dungeon id — the loading screen calls this every frame.

import { encodeName } from '../data/strings.js';
import { MONSTERS } from '../data/monsters.js';
import { DEFAULT_BOSS_ID } from '../data/bosses.js';

const _cache = new Map();

/**
 * ⛔ THE LAST FLOOR IS THE BOSS CHAMBER, NOT A LEVEL. `floors` counts map ids
 * (see the registry header: floor N is `base + N`, and `floors - 1` is the boss
 * chamber), so the number the player is told is `floors - 1`. Altar Cave's
 * `floors: 5` is what made the shipped literal read "4 Levels" — this
 * reproduces that value rather than replacing it.
 */
export function dungeonLevelCount(dungeon) {
  return Math.max(1, (dungeon ? dungeon.floors : 5) - 1);
}

/** The dungeon's boss HP, or the default boss's when a row names no monster. */
export function dungeonBossHP(dungeon) {
  const id = dungeon && dungeon.bossId != null ? dungeon.bossId : DEFAULT_BOSS_ID;
  const mon = MONSTERS.get(id) || MONSTERS.get(DEFAULT_BOSS_ID);
  return mon ? mon.hp : 120;
}

/**
 * `{ nameBytes, levelsBytes, hpBytes }` for a dungeon row, NES-encoded.
 *
 * Cache key includes the fields it reads, so a tool or gate that mutates a row
 * in place (to prove the screen tracks the registry) does not get a stale
 * answer — a plain id key made exactly that test pass against frozen text.
 */
export function dungeonLabels(dungeon) {
  const levels = dungeonLevelCount(dungeon);
  const hp = dungeonBossHP(dungeon);
  const name = dungeon ? dungeon.name : 'Altar Cave';
  const key = `${dungeon ? dungeon.id : '-'}|${name}|${levels}|${hp}`;
  let hit = _cache.get(key);
  if (hit) return hit;
  hit = {
    nameBytes: encodeName(name),
    levelsBytes: encodeName(`${levels} Level${levels === 1 ? '' : 's'}`),
    hpBytes: encodeName(`HP ${hp}`),
  };
  _cache.set(key, hit);
  return hit;
}
