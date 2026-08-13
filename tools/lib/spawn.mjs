// spawn.mjs — the ONE copy of "where does the player actually stand on entry".
//
// Mirrors src/map-loading.js#_calcSpawnY. The ROM's entranceX/Y points at the
// door tile on the OUTSIDE of a building; the game then walks the player to the
// interior doorway. Seeding a renderer from the raw entrance photographs a tile
// the player never occupies — and because `MapRenderer` computes the room clip
// from its seed, it also produces a clip the game never builds.
//
// That mistake has been made three times in this codebase from three separate
// hand-copies of this function (a throwaway diagnostic that reported map 44 as
// a one-tile room, a clip-comparison script, and check-room-clip.mjs itself).
// Every tool imports this now. Do not paste a fourth copy.

/** Open the closed passage exactly as map-loading.js does at load time. */
export function applyPassageForTools(md) {
  // Maps carrying the torch opener ($32 at 8,16) keep the passage shut.
  if (md.tilemap[16 * 32 + 8] === 0x32) return md;
  for (let i = 0; i < md.tilemap.length; i++) {
    if (md.tilemap[i] === 0x5B) md.tilemap[i] = 0x5D;
    if (md.tilemap[i] === 0x5C) md.tilemap[i] = 0x5E;
  }
  return md;
}

/** The row the player lands on when entering at column `ex`. */
export function calcSpawnY(m, ex, ey) {
  const at = (x, y) => m.tilemap[y * 32 + x];
  const collOf = (mid) => m.collision[mid < 128 ? mid : mid & 0x7F];

  if ((collOf(at(ex, ey)) & 0x07) === 3) {
    for (let d = 1; d < 32; d++) {
      const ny = (ey - d + 32) % 32;
      if (at(ex, ny) === 0x44) return ny;
    }
    for (let d = 1; d <= 16; d++) {
      const ny = ey + d;
      if (ny >= 32) break;
      const mid = at(ex, ny);
      if (mid === m.fillTile) break;
      const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
    }
    for (let d = 1; d <= 16; d++) {
      const ny = ey - d;
      if (ny < 0) break;
      const mid = at(ex, ny);
      if (mid === m.fillTile) break;
      const c = collOf(mid);
      if ((c & 0x07) !== 3 && !(c & 0x80)) return ny;
    }
    return ey;
  }

  const entMid = at(ex, ey);
  const entM = entMid < 128 ? entMid : entMid & 0x7F;
  if (entMid === 0x44) return ey;
  if ((m.collision[entM] & 0x80) && ((m.collisionByte2[entM] >> 4) & 0x0F) === 0) {
    for (let d = 1; d <= 8; d++) {
      const ny = ey - d;
      if (ny < 0) break;
      if (at(ex, ny) === 0x44) return ny;
    }
  }
  return ey;
}

/** Convenience: the tile the game seeds the renderer from. */
export function spawnOf(md) {
  return { x: md.entranceX, y: calcSpawnY(md, md.entranceX, md.entranceY) };
}
