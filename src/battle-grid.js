// Shared battle-grid layout helpers — used by encounter rendering, FX, and
// spell projectile/effect targeting. Pure layout math: no drawing, no state
// mutation. Extracted v1.7.184 to break the circular import that would
// otherwise form between battle-drawing.js (FX, ally rows, player portrait)
// and battle-draw-encounter.js (encounter monsters + boss sprite box).

import { battleSt } from './battle-state.js';
import { pvpSt } from './pvp.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { _encounterGridPos } from './battle-layout.js';
import { pvpEnemyCellCenter as _pvpEnemyCellCenterRaw } from './pvp-math.js';

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;

// Encounter monster box dimensions — depends on tallest sprite per row so
// boss-class sprites (e.g. EyeFang at 48 px tall) don't overflow row1.
export function encounterBoxDims() {
  if (!battleSt.encounterMonsters) return { fullW: 64, fullH: 64, sprH: 32, row0H: 32, row1H: 0 };
  const count = battleSt.encounterMonsters.length;
  const heights = battleSt.encounterMonsters.map(m => {
    const c = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    return c ? c.height : 32;
  });
  const fullW = count === 1 ? 64 : 96;
  // Row 0 = indices 0-1, row 1 = indices 2-3 (monsters pre-sorted tallest first)
  const row0H = Math.max(heights[0] || 32, heights[1] || 0);
  const row1H = count > 2 ? Math.max(heights[2] || 32, heights[3] || 0) : 0;
  const sprH = Math.max(row0H, row1H); // legacy — tallest overall
  const gapY = row1H > 0 ? 2 : 0;
  const padding = 16;
  const innerH = row1H > 0 ? row0H + gapY + row1H : row0H;
  const fullH = Math.ceil((innerH + padding) / 8) * 8;
  return { fullW, fullH, sprH, row0H, row1H };
}

// Centered grid positions for live encounter monsters (1-4) — call site
// passes count + sprite-height info from `encounterBoxDims()`.
export function encounterGridLayout() {
  const count = battleSt.encounterMonsters.length;
  const { fullW, fullH, sprH, row0H, row1H } = encounterBoxDims();
  const boxX = HUD_VIEW_X + Math.floor((HUD_VIEW_W - fullW) / 2);
  const boxY = HUD_VIEW_Y + Math.floor((HUD_VIEW_H - fullH) / 2);
  const gridPos = _encounterGridPos(boxX, boxY, fullW, fullH, count, sprH, row0H, row1H);
  return { count, boxX, boxY, sprH, row0H, row1H, fullW, fullH, gridPos };
}

// PVP enemy cell center — wraps `pvp-math.js` with the active enemy count
// (opponent + ally count). Always pulls from live `pvpSt`. Named `Local`
// to disambiguate from `pvpEnemyCellCenter` exported by `pvp-math.js`
// (which takes an explicit count argument).
export function pvpEnemyCellCenterLocal(idx) {
  return _pvpEnemyCellCenterRaw(idx, 1 + pvpSt.pvpEnemyAllies.length);
}
