// ATB gauge rendering — slice 1 (v1.7.428).
// Display-only row of per-unit gauges at the bottom edge of the battle area.
// Slice 2+ will move bars to per-unit positions (under each sprite/portrait).

import { ui } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { getATBUnits, getGaugePct, isReady } from './atb.js';

const BAR_W   = 20;
const BAR_H   = 3;
const BAR_GAP = 4;
const ROW_Y   = 144;  // just below the play area, above the HUD strip

const FILL_BY_KIND = {
  'player':    '#4ec9b0',
  'ally':      '#6dc7ff',
  'monster':   '#e06c75',
  'pvp-enemy': '#e0904e',
};
const READY_FLASH = '#ffeb3b';
const EMPTY_FILL  = '#222';
const FRAME       = '#000';

export function drawATBGauges() {
  if (battleSt.battleState === 'none') return;
  // Dev-only diagnostic row. Toggle via `window.__atbDebug = true` in the
  // browser console. Default off — ATB drives dispatch silently in
  // production; the gauges are tooling, not UI.
  if (typeof window === 'undefined' || !window.__atbDebug) return;
  const units = getATBUnits();
  if (units.length === 0) return;
  const ctx = ui.ctx;
  let x = 8;
  const flash = Math.floor(Date.now() / 200) & 1;  // 5Hz blink for ready
  for (const u of units) {
    if (!u.ref || !u.ref._atb) { x += BAR_W + BAR_GAP; continue; }
    const pct = getGaugePct(u.ref);
    const filled = Math.round(BAR_W * pct);
    ctx.fillStyle = FRAME;
    ctx.fillRect(x - 1, ROW_Y - 1, BAR_W + 2, BAR_H + 2);
    ctx.fillStyle = EMPTY_FILL;
    ctx.fillRect(x, ROW_Y, BAR_W, BAR_H);
    const ready = isReady(u.ref);
    ctx.fillStyle = (ready && flash) ? READY_FLASH : (FILL_BY_KIND[u.kind] || '#ccc');
    ctx.fillRect(x, ROW_Y, filled, BAR_H);
    x += BAR_W + BAR_GAP;
  }
}
