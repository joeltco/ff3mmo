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
// Offsets are relative to `romRaw` (which INCLUDES the 16-byte iNES
// header), matching the convention SPRITE_TILE_BASE uses in sprite.js.
//
// PPU palette state at capture (sprite palettes 2 + 3):
//   SP2 = [0x1A, 0x0F, 0x12, 0x36]
//   SP3 = [0x1A, 0x0F, 0x27, 0x30]

import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from '../sprite.js';

const SCENE_PAL_TOP = [0x1A, 0x0F, 0x27, 0x30]; // PPU SP3
const SCENE_PAL_BTM = [0x1A, 0x0F, 0x12, 0x36]; // PPU SP2

// Elder + 2 attendants surround the new-game spawn at map 7 (4,4): elder one
// tile north (4,3), attendants flanking at (2,4) / (6,4). `dialogue` is what
// each says when talked to AFTER the intro (see OPENING_INTRO). Pages ≤2 lines
// per the box real estate ([[reference_ff3mmo_message_box_realestate]]).
export const OPENING_ELDER = {
  romOffset: 0x01EC10,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_DOWN,
  animate: true,
  dialogue: [
    'The crystal waits below.',
    'Find it, and grow strong.',
  ],
};

export const OPENING_LEFT_ATTENDANT = {
  romOffset: 0x01E010,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_RIGHT, // faces toward player (player at 4,4; attendant at 2,4)
  animate: true,
  dialogue: [
    'We tend the elder here.',
    'Be well, traveler.',
  ],
};

export const OPENING_RIGHT_ATTENDANT = {
  romOffset: 0x01E210,
  palTop: SCENE_PAL_TOP,
  palBtm: SCENE_PAL_BTM,
  dir: DIR_LEFT, // faces toward player (attendant at 6,4)
  animate: true,
  dialogue: [
    'Mind the caves below.',
    'Monsters lurk there.',
  ],
};

// New-game intro: the three speak in turn the moment the player spawns. `dir`
// is the direction the PLAYER turns to face the current speaker — elder is
// north (UP), left attendant west (LEFT), right attendant east (RIGHT).
// Plays once (queued only on a fresh-slot start), movement locked until done.
export const OPENING_INTRO = [
  { dir: DIR_UP,    text: 'Oh? Another one came through.' }, // elder
  { dir: DIR_LEFT,  text: 'That makes three this moon.' },   // left attendant
  { dir: DIR_RIGHT, text: 'Hush. Let them wake.' },          // right attendant
  { dir: DIR_UP,    text: 'Easy, child. You are safe.' },    // elder
  { dir: DIR_UP,    text: 'The crystal called you here.' },  // elder
  { dir: DIR_LEFT,  text: 'They wake so confused.' },        // left attendant
  { dir: DIR_RIGHT, text: 'You did too, once.' },            // right attendant
  { dir: DIR_UP,    text: 'Rest. Then seek the light.' },    // elder
];
