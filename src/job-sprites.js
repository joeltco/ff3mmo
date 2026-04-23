// Job-specific sprite swap — called when the player changes jobs. Updates the
// battle sprite cache AND the walk-sprite GFX/palette so both views match.

import { loadJobBattleSprites } from './battle-sprite-cache.js';
import { sprite } from './player-sprite.js';
import { romRaw } from './boot.js';

// NES PPU-traced palettes for the player walk sprite (dual palette: top/bottom tiles).
export const SPRITE_PAL_TOP = [0x0F, 0x0F, 0x16, 0x30];    // spr_pal0: black, dark red, white
export const SPRITE_PAL_BTM = [0x1A, 0x0F, 0x15, 0x30];    // spr_pal1: green, black, magenta, white

// Monk walk palette — PPU capture. Head (top) uses SP0 with 0x17 hair / 0x36 skin;
// body (bottom) uses SP1 with 0x22 blue gi / 0x36 skin. Blue 0x22 is the customizable color.
export const MO_WALK_TOP = [0x1A, 0x0F, 0x17, 0x36];
export const MO_WALK_BTM = [0x1A, 0x0F, 0x22, 0x36];

// Per-job walk sprite palettes: [topPal, bottomPal]
const JOB_WALK_PALS = {
  0: [SPRITE_PAL_TOP, SPRITE_PAL_BTM],   // Onion Knight: red top, green/magenta bottom
  1: [SPRITE_PAL_TOP, SPRITE_PAL_TOP],   // Warrior: all red
  2: [MO_WALK_TOP, MO_WALK_BTM],         // Monk: brown hair + peach skin top, blue gi bottom
};

export function swapBattleSprites(jobIdx) {
  loadJobBattleSprites(romRaw, jobIdx);
  if (sprite) {
    sprite.setGfxID(jobIdx);
    const pals = JOB_WALK_PALS[jobIdx] || JOB_WALK_PALS[0];
    sprite.setPalette(pals[0], pals[1]);
  }
}
