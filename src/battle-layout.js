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
// row0H/row1H allow per-row height sizing; falls back to sprH if not provided
/**
 * Where each encounter monster is drawn.
 *
 * ⛔ THIS USED TO ASSUME EVERY MONSTER WAS 32px WIDE (`const hs = 16`). It was
 * true for the hand-authored zones, whose widest monster was 32; the moment
 * v1.10.56 replaced them with the cartridge's own tables it stopped being true,
 * and 48px monsters — Berserker in four of the reachable overworld regions —
 * overlapped their neighbour by 8px and spilled 4px past the box border. The
 * boss chamber had the same bug the whole time: a lone 48px Land Turtle was
 * drawn 8px right of centre.
 *
 * `widths` is per SLOT, in `battleSt.encounterMonsters` order (already sorted
 * tallest-first at spawn), and `colOff` is the distance from the box centre to a
 * COLUMN CENTRE — `encounterBoxDims()` derives it from those widths so the two
 * cannot disagree.
 *
 * ⛔ Both defaults reproduce the old numbers exactly (32px sprites, colOff 20 =
 * the old `gapX`), so a caller that has not been updated still renders as before
 * rather than silently collapsing everything onto the centre line.
 */
/** The width the old layout assumed for every monster. */
const DEFAULT_SPRITE_W = 32;
/** Clear space kept between two sprites sharing a row — what 32px sprites had. */
const SPRITE_AIR = 8;
/** `(32 + 32) / 4 + 8 / 2` — the old `gapX`, kept as the floor. */
const DEFAULT_COL_OFF = 20;
/** Box breathing room, matching the vertical padding in `encounterBoxDims`. */
const BOX_PADDING = 16;

export function _encounterGridPos(boxX, boxY, boxW, boxH, count, sprH, row0H, row1H,
                                  widths = [], colOff = DEFAULT_COL_OFF) {
  sprH = sprH || 32;
  row0H = row0H || sprH;
  row1H = row1H || sprH;
  const cx = boxX + Math.floor(boxW / 2);
  const cy = boxY + Math.floor(boxH / 2);
  /** Half of THIS slot's sprite, so `x` puts its centre on the column. */
  const hw = (i) => Math.floor((widths[i] || DEFAULT_SPRITE_W) / 2);
  const gapY = count <= 2 ? 0 : 2;
  const totalH = row0H + gapY + row1H;
  const row0y = cy - Math.floor(totalH / 2);
  const row1y = row0y + row0H + gapY;
  if (count === 1) return [{ x: cx - hw(0), y: cy - Math.floor(row0H / 2) }];
  if (count === 2) {
    const topY = cy - Math.floor(row0H / 2);
    return [
      { x: cx - colOff - hw(0), y: topY },
      { x: cx + colOff - hw(1), y: topY },
    ];
  }
  if (count === 3) return [
    { x: cx - colOff - hw(0), y: row0y },
    { x: cx + colOff - hw(1), y: row0y },
    { x: cx - hw(2),          y: row1y },
  ];
  return [
    { x: cx - colOff - hw(0), y: row0y },
    { x: cx + colOff - hw(1), y: row0y },
    { x: cx - colOff - hw(2), y: row1y },
    { x: cx + colOff - hw(3), y: row1y },
  ];
}

/**
 * How wide the encounter box must be to contain these sprites.
 *
 * A column centre sits `colOff` from the middle and the widest sprite reaches
 * `widest / 2` beyond that. ⭐ 64 and 96 stay the floor, so every encounter that
 * already fitted keeps exactly the box it had.
 *
 * ⛔ PURE, AND EXPORTED, ON PURPOSE. `encounterBoxDims()` needs live battle state
 * and a canvas, so an audit cannot call it — and an audit that re-implements this
 * arithmetic keeps passing after someone changes the real one. This is the one
 * copy.
 */
export function encounterBoxWidth(count, colOff, widths) {
  const widest = Math.max(DEFAULT_SPRITE_W, ...widths);
  const innerW = count === 1 ? widest : 2 * (colOff + widest / 2);
  return Math.max(count === 1 ? 64 : 96, Math.ceil((innerW + BOX_PADDING) / 8) * 8);
}

/**
 * Distance from the box centre to a column centre, for a row holding sprites of
 * these widths.
 *
 * Two sprites on a row must not touch: with centres `2*colOff` apart their inner
 * edges are `2*colOff - (wL + wR)/2` apart, so `colOff = (wL + wR)/4 + AIR/2`.
 * ⭐ At 32/32 that is exactly 20 — the old hardcoded `gapX` — and `AIR` is the
 * 8px the old layout happened to leave. So this widens for big sprites and
 * changes nothing for the ones that already fitted.
 */
export function encounterColOff(widths) {
  const pairs = [[0, 1], [2, 3]];
  let need = DEFAULT_COL_OFF;
  for (const [a, b] of pairs) {
    if (widths[a] == null || widths[b] == null) continue;
    need = Math.max(need, Math.ceil((widths[a] + widths[b]) / 4 + SPRITE_AIR / 2));
  }
  return need;
}
