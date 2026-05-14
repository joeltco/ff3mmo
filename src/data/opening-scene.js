// Opening-scene NPC sprite specs — verified against FF3 NES ROM
// (FF3-English.nes + AWJ patch).
//
// Each spec points at a 16-tile (256-byte) walk-sprite bundle in ROM, the
// same shape the player Sprite class expects. We pass `romRaw` as the data
// source and override `sprite.gfxBase` to the NPC's bundle offset, so the
// existing Sprite class renders frame 0 + frame 1 in all 4 directions —
// real FF3 walk cycle, no fabricated frames.
//
// ROM offsets were located by byte-searching for the captured OAM tiles
// against the patched ROM. Verified that surrounding slots are the
// matching walk-cycle alt frames (head stays, body legs alternate),
// matching FF3's standard walk-sprite layout:
//   slots 0-3   = DOWN
//   slots 4-7   = UP
//   slots 8-11  = LEFT frame 0
//   slots 12-15 = LEFT frame 1   (mirror via Sprite class for RIGHT)
//
// PPU palette state at capture (sprite palettes 2 + 3):
//   SP2 = [0x1A, 0x0F, 0x12, 0x36]
//   SP3 = [0x1A, 0x0F, 0x27, 0x30]

import { DIR_DOWN, DIR_LEFT, DIR_RIGHT } from '../sprite.js';

const SCENE_PAL_TOP = [0x1A, 0x0F, 0x27, 0x30]; // PPU SP3
const SCENE_PAL_BTM = [0x1A, 0x0F, 0x12, 0x36]; // PPU SP2

export const OPENING_ELDER = {
  romOffset: 0x01EC00,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
};

export const OPENING_LEFT_ATTENDANT = {
  romOffset: 0x01E000,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_RIGHT, // faces toward player (player at 4,4; attendant at 2,4)
  animate: true,
};

export const OPENING_RIGHT_ATTENDANT = {
  romOffset: 0x01E200,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_LEFT, // faces toward player (attendant at 6,4)
  animate: true,
};
