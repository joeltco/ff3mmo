// UI state — shared canvas refs and platform constants used across rendering modules.
// game.js owns the lifecycle (creates canvases during init) and mirrors each ref into `ui`
// immediately after assignment. Consumers import `ui` and read fields directly.

export const ui = {
  canvas: null,                   // main <canvas> element
  ctx: null,                      // 2D context for `canvas`
  cursorTileCanvas: null,         // 8×8 cursor tile
  cursorFadeCanvases: null,       // [step1..step4] NES-faded cursor tiles
  borderTileCanvases: null,       // [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]
  borderBlueTileCanvases: null,   // same as above, blue (0x02) background
  borderFadeSets: null,           // [fadeLevel] → [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR, FILL]
  cornerMasks: null,              // [TL, TR, BL, BR] 8×8 corner rounding masks
  hudCanvas: null,                // pre-baked HUD (in-game layout)
  hudFadeCanvases: null,          // [fadeLevel 1..4] faded HUD — game start fade-in
  titleHudCanvas: null,           // pre-baked title HUD (no right boxes, full-width viewport)
  titleHudFadeCanvases: null,     // [fadeLevel 1..4] faded title HUD
};

export const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// Generic box-draw using a 9-tile border set. Used by HUD init + loading screen.
export function drawBoxOnCtx(pctx, tileCanvases, x, y, w, h, fill = true) {
  const [TL, TOP, TR, LEFT, RIGHT, BL, BOT, BR] = tileCanvases;
  if (fill) { pctx.fillStyle = '#000'; pctx.fillRect(x + 8, y + 8, w - 16, h - 16); }
  pctx.drawImage(TL, x, y); pctx.drawImage(TR, x + w - 8, y);
  pctx.drawImage(BL, x, y + h - 8); pctx.drawImage(BR, x + w - 8, y + h - 8);
  for (let tx = x + 8; tx < x + w - 8; tx += 8) { pctx.drawImage(TOP, tx, y); pctx.drawImage(BOT, tx, y + h - 8); }
  for (let ty = y + 8; ty < y + h - 8; ty += 8) { pctx.drawImage(LEFT, x, ty); pctx.drawImage(RIGHT, x + w - 8, ty); }
}
