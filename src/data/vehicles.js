// vehicles.js — the vehicle table, MEASURED from the ROM.
//
// `ps.vehicle` is the cartridge's own movement MODE and indexes the mask table
// at $C6CD (see docs/VEHICLE-SYSTEM-PLAN.md §9). Terrain rules are enforced by
// world-map-renderer.js; this file carries what each mode SOUNDS like and what
// it is called.
//
// Music ids are raw song numbers, read from the ROM's vehicle music table at
// bank 59 $A027 and confirmed live at boarding. SFX are the companion table at
// $A047, also confirmed live; music.js's convention is "ROM SFX ID + 0x41" for
// the NSF track, so that conversion is applied here.
//
//   mode 0 -> $1e = TRACKS.WORLD_MAP, no cue   (on foot; the table stores $ff = silent)
//   mode 3 -> $22 music, $04 cue
//   modes 4-6 -> $0a music, cues $26 / $25 / $27
//   mode 7 -> $23 music, $28 cue
//
// ⭐ There is no per-step engine sound. Flying craft were driven 570-679 tiles
// with the sound port hooked and produced ZERO writes in motion — the continuous
// sail/propeller you hear IS the music track, started once on boarding.

export const MODE_ON_FOOT = 0;

/** ROM SFX id -> NSF track, the convention music.js documents. */
const cue = (romSfxId) => romSfxId + 0x41;

export const VEHICLES = new Map([
  [0, { name: 'on foot',        music: 0x1e, sfx: null,       water: false, flies: false }],
  [1, { name: 'canoe',          music: 0x08, sfx: null,       water: false, flies: false }],
  [2, { name: 'canoe (afloat)', music: 0x1e, sfx: null,       water: true,  flies: false }],
  [3, { name: 'ship',           music: 0x22, sfx: cue(0x04),  water: true,  flies: false }],
  [4, { name: 'airship',        music: 0x0a, sfx: cue(0x26),  water: false, flies: true  }],
  [5, { name: 'airship',        music: 0x0a, sfx: cue(0x25),  water: false, flies: true  }],
  [6, { name: 'airship',        music: 0x0a, sfx: cue(0x27),  water: false, flies: true  }],
  [7, { name: 'Invincible',     music: 0x23, sfx: cue(0x28),  water: true,  flies: true  }],
]);

export function vehicleInfo(mode) {
  return VEHICLES.get(mode | 0) || VEHICLES.get(0);
}

/** Is this mode a craft the player is riding (as opposed to walking)? */
export function isAboard(mode) {
  return (mode | 0) !== MODE_ON_FOOT;
}
