// map-music.js — what music a map entry should start. ONE decision, in one
// place, with no DOM or audio imports so a gate can run it directly.
//
// The decision used to live inline in `map-loading.js#_loadRegularMap` as a
// single `mapId === 114` branch. That made it untestable outside a browser and,
// more to the point, wrong: exactly one map in the game started a track and
// every other map inherited whatever the previous one left playing. Kazus and
// Castle Sasune ran on Ur's town theme for that reason.
//
// Returns a PLAN, not an effect, so the caller does the playing and the gate
// can assert the choice:
//
//   { kind: 'ff2',      track }  — elder house: FF2 NSF track, FF3 stopped
//   { kind: 'ff3',      song  }  — start this FF3 song now
//   { kind: 'deferred', song  }  — a transition owns the start (pendingTrack)
//   { kind: 'none'            }  — nothing to start (unmeasured map slot)

import { songForMap } from './data/map-songs.js';

// Elder house, both floors. Its FF2 theme is a deliberate design choice, NOT a
// ROM-measured value — the ROM says song 31 (Ur's theme) for maps 6 and 7 like
// every other Ur interior. Keep it above the measured table so a re-measure
// never silently reverts the choice.
export const ELDER_HOUSE_MAPS = new Set([6, 7]);

/**
 * @param {number} mapId
 * @param {object} opts
 * @param {boolean} opts.ff2Ready      FF2 ROM loaded (its NSF is built)?
 * @param {number|null} opts.pendingTrack  a transition already owns the start
 * @param {number} opts.ff2ElderTrack  FF2_TRACKS.ELDER_HOUSE
 */
export function mapEntryMusic(mapId, { ff2Ready = false, pendingTrack = null, ff2ElderTrack = 0 } = {}) {
  if (ELDER_HOUSE_MAPS.has(mapId) && ff2Ready) return { kind: 'ff2', track: ff2ElderTrack };
  const song = songForMap(mapId);
  if (song == null) return { kind: 'none' };
  // A transition is already queued to start music when its fade completes;
  // starting a second track here would talk over it.
  if (pendingTrack != null) return { kind: 'deferred', song };
  return { kind: 'ff3', song };
}
