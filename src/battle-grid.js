// Shared battle-grid layout helpers — used by encounter rendering, FX, and
// spell projectile/effect targeting. Pure layout math: no drawing, no state
// mutation. Extracted v1.7.184 to break the circular import that would
// otherwise form between battle-drawing.js (FX, ally rows, player portrait)
// and battle-draw-encounter.js (encounter monsters + boss sprite box).

import { battleSt } from './battle-state.js';
import { pvpSt } from './pvp.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { _encounterGridPos, encounterColOff, encounterBoxWidth } from './battle-layout.js';
import { pvpEnemyCellCenter as _pvpEnemyCellCenterRaw } from './pvp-math.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;

// Encounter monster box dimensions — depends on tallest sprite per row so
// boss-class sprites (e.g. EyeFang at 48 px tall) don't overflow row1.
export function encounterBoxDims() {
  if (!battleSt.encounterMonsters)
    return { fullW: 64, fullH: 64, sprH: 32, row0H: 32, row1H: 0, widths: [], colOff: 20 };
  const count = battleSt.encounterMonsters.length;
  const heights = battleSt.encounterMonsters.map(m => {
    const c = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    return c ? c.height : 32;
  });
  // ⛔ WIDTH IS NOT ALWAYS 32. The layout assumed it was until v1.10.61; see
  // `_encounterGridPos`. Read it from the same canvas the height comes from so
  // the two can never describe different sprites.
  const widths = battleSt.encounterMonsters.map(m => {
    const c = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    return c ? c.width : 32;
  });
  const colOff = encounterColOff(widths);
  // Row 0 = indices 0-1, row 1 = indices 2-3 (monsters pre-sorted tallest first)
  const row0H = Math.max(heights[0] || 32, heights[1] || 0);
  const row1H = count > 2 ? Math.max(heights[2] || 32, heights[3] || 0) : 0;
  const sprH = Math.max(row0H, row1H); // legacy — tallest overall
  const gapY = row1H > 0 ? 2 : 0;
  const padding = 16;
  const innerH = row1H > 0 ? row0H + gapY + row1H : row0H;
  const fullH = Math.ceil((innerH + padding) / 8) * 8;
  const fullW = encounterBoxWidth(count, colOff, widths);
  return { fullW, fullH, sprH, row0H, row1H, widths, colOff };
}

// Centered grid positions for live encounter monsters (1-4) — call site
// passes count + sprite-height info from `encounterBoxDims()`.
export function encounterGridLayout() {
  const count = battleSt.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H, widths, colOff } = encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H, widths, colOff);
  return { count, boxX, boxY, sprH, row0H, row1H, fullW, fullH, gridPos };
}

// PVP enemy cell center — wraps `pvp-math.js` with the active enemy count
// (opponent + ally count). Always pulls from live `pvpSt`. Named `Local`
// to disambiguate from `pvpEnemyCellCenter` exported by `pvp-math.js`
// (which takes an explicit count argument).
export function pvpEnemyCellCenterLocal(idx) {
  return _pvpEnemyCellCenterRaw(idx, 1 + pvpSt.pvpEnemyAllies.length);
}

// Party-side portrait geometry. Kept here beside `pvpEnemyCellCenterLocal` so
// "where is this caster" has ONE answer for all three roles.
const HUD_RIGHT_X = 144;
const ROSTER_ROW_H = 32;

/**
 * Centre of a caster's 16x16 portrait, in screen coords.
 *
 * ⛔ MUST MATCH THE `drawCastWindup` CALL SITES, which are what every other
 * spell's cast visual is anchored to: the player at `px + 8, py + 8` with
 * `px,py = (HUD_RIGHT_X + 8, HUD_VIEW_Y + 8)` (battle-draw-player.js), and an
 * ally at `ppx + 8, ppy + 8` with `ppy = panelTop + i * ROSTER_ROW_H + 8`
 * (battle-draw-allies.js). This math is currently ALSO open-coded in those two
 * files and in battle-drawing.js's SouthWind anchor — new code should call here
 * rather than add a fourth copy.
 *
 * ⚠ The SouthWind anchor uses `+ 8 + 12` for the player rather than `+ 8 + 8`.
 * That is a 4px difference on one effect and is left alone deliberately; do not
 * "unify" it without looking at SouthWind on screen first.
 */
export function casterPortraitCentre(role, idx = 0) {
  if (role === 'pvp-enemy') return pvpEnemyCellCenterLocal(idx);
  if (role === 'ally') {
    const panelTop = HUD_VIEW_Y + 32;
    return { x: HUD_RIGHT_X + 8 + 8, y: panelTop + idx * ROSTER_ROW_H + 8 + 8 };
  }
  return { x: HUD_RIGHT_X + 8 + 8, y: HUD_VIEW_Y + 8 + 8 };
}
