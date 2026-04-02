// PVP grid math — shared between game.js and pvp.js

export const PVP_CELL_W = 24;
export const PVP_CELL_H = 32;

// HUD viewport constants (duplicated in many modules — canonical source here)
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;

/** Grid layout for N enemies: cols, rows, and grid-position lookup array. */
export function pvpGridLayout(totalEnemies) {
  const cols = totalEnemies <= 1 ? 1 : 2;
  const rows = totalEnemies <= 2 ? 1 : 2;
  const gridPos = [[rows-1,cols-1],[rows-1,0],[0,cols-1],[0,0]];
  return { cols, rows, gridPos };
}

/** Center point of PVP enemy cell `idx` (0=main, 1+=allies) within the HUD viewport. */
export function pvpEnemyCellCenter(idx, totalEnemies) {
  const { cols, rows, gridPos } = pvpGridLayout(totalEnemies);
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const intLeft = centerX - cols * Math.floor(PVP_CELL_W / 2);
  const intTop  = centerY - rows * Math.floor(PVP_CELL_H / 2);
  const [gr, gc] = gridPos[Math.min(idx, gridPos.length - 1)];
  return { x: intLeft + gc * PVP_CELL_W + 12, y: intTop + gr * PVP_CELL_H + 12 };
}
