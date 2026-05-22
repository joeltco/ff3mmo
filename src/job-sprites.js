// Job-specific sprite swap — called when the player changes jobs OR changes
// their color (Options → Color). Updates the battle sprite cache AND the
// walk-sprite GFX/palette so every view matches the chosen job + palIdx.

import { loadJobBattleSprites } from './battle-sprite-cache.js';
import { sprite } from './player-sprite.js';
import { romRaw } from './boot.js';
import { ps } from './player-stats.js';
import { jobBattlePalette } from './data/players.js';

// NES PPU-traced palettes for the player walk sprite (dual palette: top/bottom tiles).
export const SPRITE_PAL_TOP = [0x0F, 0x0F, 0x16, 0x30];    // spr_pal0: black, dark red, white
export const SPRITE_PAL_BTM = [0x1A, 0x0F, 0x15, 0x30];    // spr_pal1: green, black, magenta, white

// Monk walk palette — PPU capture. Head (top) uses SP0 with 0x17 hair / 0x36 skin;
// body (bottom) uses SP1 with 0x22 blue gi / 0x36 skin. Blue 0x22 is the customizable color.
export const MO_WALK_TOP = [0x1A, 0x0F, 0x17, 0x36];
export const MO_WALK_BTM = [0x1A, 0x0F, 0x22, 0x36];

// Black Mage walk palette — PPU capture (REC OAM frame 1629, default party).
// Hat/face (top SP0) uses 0x27 peach for the brim/face highlight; robe
// (bottom SP1) uses 0x21 canon-blue for the cloak. Color 3 = 0x36 (light
// pink) on both halves for the trim/highlight outline.
export const BM_WALK_TOP = [0x1A, 0x0F, 0x27, 0x36];
export const BM_WALK_BTM = [0x1A, 0x0F, 0x21, 0x36];

// Per-job walk sprite palettes: [topPal, bottomPal]
const JOB_WALK_PALS = {
  0: [SPRITE_PAL_TOP, SPRITE_PAL_BTM],   // Onion Knight: red top, green/magenta bottom
  1: [SPRITE_PAL_TOP, SPRITE_PAL_TOP],   // Warrior: all red
  2: [MO_WALK_TOP, MO_WALK_BTM],         // Monk: brown hair + peach skin top, blue gi bottom
  4: [BM_WALK_TOP, BM_WALK_BTM],         // Black Mage: peach face top, blue robe bottom
  5: [SPRITE_PAL_TOP, SPRITE_PAL_TOP],   // Red Mage: all red (same pattern as Warrior)
};

// Which walk-palette slot(s) carry the recolorable "outfit" color, as
// [half, index] pairs. Only these get swapped to the chosen color slot — skin,
// hair, face, and outline stay fixed. (Monk top[2]=hair and BM top[2]=face are
// deliberately NOT listed so a color swap never tints the face/hair.)
const WALK_OUTFIT_SLOTS = {
  0: [['top', 2], ['btm', 2]],   // OK — torso + legs
  1: [['top', 2], ['btm', 2]],   // Fi — all red
  2: [['btm', 2]],               // Mo — gi only
  3: [['top', 2], ['btm', 2]],   // WM — falls back to OK base palette
  4: [['btm', 2]],               // BM — robe only
  5: [['top', 2], ['btm', 2]],   // RM — all red
};

// Resolve the walk sprite palette for (jobIdx, palIdx). palIdx 0 returns the
// PPU-traced base verbatim (zero visual change vs pre-color-picker). For slots
// 1-7 the outfit slots are recolored to the same hue the battle sprite uses
// (jobBattlePalette color 3), so the chosen color reads consistently across
// overworld and battle.
function resolveWalkPalette(jobIdx, palIdx) {
  const base = JOB_WALK_PALS[jobIdx] || JOB_WALK_PALS[0];
  const top = [...base[0]];
  const btm = [...base[1]];
  if (palIdx > 0) {
    const outfit = jobBattlePalette(jobIdx, palIdx)[3];
    const slots = WALK_OUTFIT_SLOTS[jobIdx] || WALK_OUTFIT_SLOTS[0];
    for (const [half, idx] of slots) {
      if (half === 'top') top[idx] = outfit;
      else btm[idx] = outfit;
    }
  }
  return [top, btm];
}

// Rebuild every player-sprite view for the given job + color slot. palIdx
// defaults to the player's current selection so callers that only care about a
// job change (e.g. title-screen load, pause-menu job switch) don't have to pass
// it. Single entry point — see [[ff3mmo-single-source-paths]].
export function swapBattleSprites(jobIdx, palIdx = ps.palIdx | 0) {
  loadJobBattleSprites(romRaw, jobIdx, palIdx);
  if (sprite) {
    sprite.setGfxID(jobIdx);
    const [top, btm] = resolveWalkPalette(jobIdx, palIdx);
    sprite.setPalette(top, btm);
  }
}
