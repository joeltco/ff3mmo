// Opening-scene NPC tile bundles — built from FF3 NES OAM capture at frame 1860
// (the scene a new player spawns into on map 7).
//
// Each NPC ships a 256-byte sprite-bank bundle that drops into the player
// Sprite class (`src/sprite.js`) the same way the moogle / black mage NPCs
// do. We don't add a parallel render path — everything goes through
// `Sprite.draw` via `Sprite.gfxBase = 0` + this bundle as `romData`.
//
// Slot layout (mirrors WALK_FRAMES in sprite.js):
//   slots 0-3   = DOWN frame 0 tiles (bottomFlip on frame 1 reuses these)
//   slots 4-7   = UP frame 0
//   slots 8-11  = LEFT frame 0 (also used for RIGHT frame 0 with full HFLIP)
//   slots 12-15 = LEFT frame 1
//
// We only have one frame from the OAM dump. For the elder (DOWN), one
// frame is enough because FF3's DOWN walk cycle reuses tiles 0-3 with a
// bottomFlip toggle for frame 1. For the attendants, slots 12-15 are
// empty; they MUST stay on frame 0 (no animation) — never call
// `setWalkProgress` on them. Animating with empty frame-1 slots would
// render blank tiles on the off-beat; bobbling would be fabrication.

import { DIR_DOWN, DIR_LEFT, DIR_RIGHT } from '../sprite.js';

const SCENE_PAL_TOP = [0x1A, 0x0F, 0x27, 0x30]; // PPU SP3
const SCENE_PAL_BTM = [0x1A, 0x0F, 0x12, 0x36]; // PPU SP2

// Raw 2BPP tile bytes — verbatim from the user's OAM capture.
const TILE_40 = new Uint8Array([0x01,0x02,0x04,0x0C,0x1F,0x3E,0x1A,0x1D,0x00,0x01,0x03,0x03,0x0E,0x19,0x05,0x06]);
const TILE_41 = new Uint8Array([0x80,0x40,0x20,0x30,0xF8,0x78,0x50,0xB8,0x00,0x80,0xC0,0xC0,0x70,0x90,0xA0,0x60]);
const TILE_42 = new Uint8Array([0x2F,0x4F,0xA7,0xB7,0xB3,0xB1,0xA0,0x50,0x17,0x37,0x5B,0x7B,0x7D,0x4E,0x5F,0x2F]);
const TILE_43 = new Uint8Array([0xF4,0xE6,0xE7,0xC7,0x85,0x05,0x06,0x78,0xE8,0xD8,0xDE,0xBE,0x7A,0xFA,0xF8,0x80]);

const TILE_2C = new Uint8Array([0x1F,0x30,0x28,0x28,0x18,0x1E,0x1F,0x1F,0x00,0x0F,0x1F,0x1F,0x0F,0x0B,0x0B,0x0E]);
const TILE_2D = new Uint8Array([0x80,0x40,0x20,0x30,0x38,0x68,0x88,0x98,0x00,0x80,0xC0,0xC0,0xD0,0xB0,0x70,0x60]);
const TILE_2E = new Uint8Array([0x0C,0x1C,0x11,0x0C,0x10,0x20,0x3C,0x3F,0x03,0x0F,0x0E,0x03,0x0F,0x1F,0x03,0x18]);
const TILE_2F = new Uint8Array([0x70,0xE0,0xF0,0xF0,0x28,0x04,0x03,0xFF,0x80,0xC0,0xE0,0x20,0xD0,0xF8,0xFC,0x00]);

const TILE_3C = new Uint8Array([0x01,0x06,0x08,0x10,0x1C,0x1E,0x1F,0x1F,0x00,0x01,0x07,0x0F,0x03,0x0D,0x0A,0x0A]);
const TILE_3D = new Uint8Array([0xF8,0x04,0x02,0x0D,0x12,0x10,0x20,0xE0,0x00,0xF8,0xFC,0xF2,0xE0,0xE0,0xC0,0x00]);
const TILE_3E = new Uint8Array([0x1E,0x3E,0x3C,0x3D,0x3B,0x3B,0x33,0x3F,0x0D,0x1D,0x1B,0x1A,0x15,0x15,0x0C,0x00]);
const TILE_3F = new Uint8Array([0x10,0x10,0x08,0x08,0x94,0x94,0xA2,0xFE,0xE0,0xE0,0xF0,0xF0,0x68,0x68,0x5C,0x00]);

function _bundle(slots) {
  const out = new Uint8Array(256);
  for (const [slot, bytes] of slots) out.set(bytes, slot * 16);
  return out;
}

// Elder — DOWN-facing, walks in place. FF3 DOWN frame 1 reuses tiles 0-3
// with bottomFlip applied by the Sprite class, so a single captured frame
// produces a REAL walk cycle (not fabricated).
export const OPENING_ELDER = {
  bundle: _bundle([[0, TILE_40], [1, TILE_41], [2, TILE_42], [3, TILE_43]]),
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

// Left attendant — faces RIGHT (toward player). Captured frame goes into
// slots 8-11 (LEFT frame 0). Render with DIR_RIGHT applies full HFLIP.
// animate=false because frame 1 slots (12-15) are empty.
export const OPENING_LEFT_ATTENDANT = {
  bundle: _bundle([[8, TILE_2C], [9, TILE_2D], [10, TILE_2E], [11, TILE_2F]]),
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_RIGHT,
  animate: false,
};

// Right attendant — faces LEFT (toward player). Captured frame at slots 8-11.
// animate=false (no frame 1 data).
export const OPENING_RIGHT_ATTENDANT = {
  bundle: _bundle([[8, TILE_3C], [9, TILE_3D], [10, TILE_3E], [11, TILE_3F]]),
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_LEFT,
  animate: false,
};
