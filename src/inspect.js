// inspect.js — roster "Inspect" → read-only stat panel (v1.7.239).
//
// Standalone overlay mirroring `trade.js` item-pick panel: bordered box
// covers the HUD viewport, no state machine, no accept-roll, no sim
// timer. X (or Z) closes. Intentional divergence from the roster-action
// lifecycle pattern documented in
// `project_ff3mmo_roster_action_pattern.md` — Inspect is a UI affordance,
// not a negotiation.
//
// Stats source: `generateAllyStats(target)` returns the same shape used
// by `tryJoinPlayerAlly` and `pvp-search.js`, so what you see here is
// what the target would fight as.

import { generateAllyStats } from './data/players.js';
import { JOBS, JOB_NAMES_SHRINES } from './data/jobs.js';
import { ITEMS } from './data/items.js';
import { getItemNameClean, getItemNameShrines, getSpellNameClean, getSpellNameShrines } from './text-decoder.js';
import { _nameToBytes } from './text-utils.js';
import { drawText, measureText, TEXT_WHITE } from './font-renderer.js';
import { drawBorderedBox, clipToViewport } from './hud-drawing.js';
import { ui } from './ui-state.js';
import { playSFX, SFX } from './music.js';

// HUD viewport for clipping the slide animation.
const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

// Compact panel sized to name + 5 equipment rows. Anchors flush to the
// right edge of the HUD viewport so the slide reveals from x=HUD_VIEW_W.
const PANEL_W = 96;
const PANEL_H = 80;
const PANEL_FINAL_X = HUD_VIEW_X + HUD_VIEW_W - PANEL_W;  // 48
const PANEL_Y = HUD_VIEW_Y + 8;                            // 40
const SLIDE_MS = 150;

export const inspectSt = {
  open: false,
  target: null,
  stats: null,
  openedAt: 0,   // ms timestamp; drives slide-in
  closingAt: 0,  // ms timestamp once close requested; drives slide-out
};

export function isInspectOpen() {
  return inspectSt.open;
}

export function openInspect(target) {
  if (!target) return false;
  inspectSt.open = true;
  inspectSt.target = target;
  inspectSt.stats = generateAllyStats(target);
  inspectSt.openedAt = Date.now();
  inspectSt.closingAt = 0;
  return true;
}

// Start slide-out; actual state clear happens when slide finishes
// (handled inside drawInspect).
export function closeInspect() {
  if (!inspectSt.open || inspectSt.closingAt !== 0) return;
  inspectSt.closingAt = Date.now();
}

function _finalClose() {
  inspectSt.open = false;
  inspectSt.target = null;
  inspectSt.stats = null;
  inspectSt.openedAt = 0;
  inspectSt.closingAt = 0;
}

export function handleInspectInput(keys) {
  if (!inspectSt.open) return false;
  if (keys['x'] || keys['X'] || keys['z'] || keys['Z']) {
    keys['x'] = false; keys['X'] = false; keys['z'] = false; keys['Z'] = false;
    playSFX(SFX.CONFIRM);
    closeInspect();
  }
  // Block movement keys while open — same pattern as trade item-pick.
  keys['ArrowUp']    = false;
  keys['ArrowDown']  = false;
  keys['ArrowLeft']  = false;
  keys['ArrowRight'] = false;
  return true;
}

export function drawInspect() {
  if (!inspectSt.open) return;
  const ctx = ui.ctx;
  const target = inspectSt.target;
  const s = inspectSt.stats;
  if (!target || !s) return;

  // Slide progress. Slide-in: panelX runs from HUD_VIEW_W → PANEL_FINAL_X.
  // Slide-out: panelX runs from PANEL_FINAL_X → HUD_VIEW_W, then close.
  const now = Date.now();
  let panelX;
  if (inspectSt.closingAt !== 0) {
    const p = Math.min(1, (now - inspectSt.closingAt) / SLIDE_MS);
    if (p >= 1) { _finalClose(); return; }
    panelX = PANEL_FINAL_X + (HUD_VIEW_W - PANEL_FINAL_X) * p;
  } else {
    const p = Math.min(1, (now - inspectSt.openedAt) / SLIDE_MS);
    panelX = HUD_VIEW_W - (HUD_VIEW_W - PANEL_FINAL_X) * p;
  }

  // Clip to the HUD viewport so the slide reveals from the right edge.
  clipToViewport();

  drawBorderedBox(panelX, PANEL_Y, PANEL_W, PANEL_H, true);

  const tx = panelX + 8;
  const pal = TEXT_WHITE;
  const STEP = 11;
  let y = PANEL_Y + 6;

  // Name centered.
  const nameBytes = _nameToBytes(target.name);
  drawText(ctx, panelX + Math.floor((PANEL_W - measureText(nameBytes)) / 2), y, nameBytes, pal);
  y += STEP + 1;

  function equipRow(label, itemId) {
    if (itemId == null) return;
    const item = ITEMS.get(itemId);
    if (!item) return;
    drawText(ctx, tx, y, _nameToBytes(label), pal);
    drawText(ctx, tx + 20, y, getItemNameShrines(itemId), pal);
    y += STEP;
  }
  equipRow('R',  s.weaponId);
  if (s.weaponL != null) equipRow('L', s.weaponL);
  equipRow('Bd', target.armorId);
  equipRow('Hd', target.helmId);
  equipRow('Sh', target.shieldId);

  ctx.restore();
}
