// Player Sprite instance — created once at boot in game.js, consumed by
// render / movement / transitions / battle-update. Imported directly so
// modules don't need getSprite callback plumbing.
//
// ES module bindings are live: consumers see the latest value after setPlayerSprite().

export let sprite = null;

export function setPlayerSprite(s) {
  sprite = s;
}
