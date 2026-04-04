const BOSS_BOX_EXPAND_MS = 300; // box expand from center duration

// Compute encounter box dimensions at a point in time during expand/close animation
export function _calcBoxExpandSize(fullW, fullH, isExpand, isClose, timer) {
  let boxW = fullW, boxH = fullH;
  if (isExpand || isClose) {
    const t = isExpand ? Math.min(timer / BOSS_BOX_EXPAND_MS, 1) : 1 - Math.min(timer / BOSS_BOX_EXPAND_MS, 1);
    boxW = Math.max(16, Math.ceil(fullW * t / 8) * 8);
    boxH = Math.max(16, Math.ceil(fullH * t / 8) * 8);
  }
  return { boxW, boxH };
}

// Compute pixel positions for 1-4 monsters centered in the encounter box
export function _encounterGridPos(boxX, boxY, boxW, boxH, count, sprH) {
  sprH = sprH || 32;
  const cx = boxX + Math.floor(boxW / 2);
  const cy = boxY + Math.floor(boxH / 2);
  const hs = 16; // half sprite width (32px wide)
  const gapX = 20;
  const gapY = 8;
  const gridH2 = sprH * 2 + gapY;
  const row0y = cy - Math.floor(gridH2 / 2);
  const row1y = row0y + sprH + gapY;
  if (count === 1) return [{ x: cx - hs, y: cy - Math.floor(sprH / 2) }];
  if (count === 2) {
    const topY = cy - Math.floor(sprH / 2);
    return [
      { x: cx - gapX - hs, y: topY },
      { x: cx + gapX - hs, y: topY },
    ];
  }
  if (count === 3) return [
    { x: cx - gapX - hs, y: row0y },
    { x: cx + gapX - hs, y: row0y },
    { x: cx - hs,         y: row1y },
  ];
  return [
    { x: cx - gapX - hs, y: row0y },
    { x: cx + gapX - hs, y: row0y },
    { x: cx - gapX - hs, y: row1y },
    { x: cx + gapX - hs, y: row1y },
  ];
}
