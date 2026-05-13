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

const HUD_VIEW_X = 0;
const HUD_VIEW_Y = 32;
const HUD_VIEW_W = 144;
const HUD_VIEW_H = 144;

export const inspectSt = {
  open: false,
  target: null,
  stats: null,
};

export function isInspectOpen() {
  return inspectSt.open;
}

export function openInspect(target) {
  if (!target) return false;
  inspectSt.open = true;
  inspectSt.target = target;
  inspectSt.stats = generateAllyStats(target);
  return true;
}

export function closeInspect() {
  inspectSt.open = false;
  inspectSt.target = null;
  inspectSt.stats = null;
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

  clipToViewport();
  drawBorderedBox(HUD_VIEW_X, HUD_VIEW_Y, HUD_VIEW_W, HUD_VIEW_H, true);

  const tx = HUD_VIEW_X + 8;
  const rx = HUD_VIEW_X + HUD_VIEW_W - 8;
  const pal = TEXT_WHITE;
  const STEP = 11;
  let y = HUD_VIEW_Y + 8;

  // Name centered at top so it's clear who's being inspected.
  const nameBytes = _nameToBytes(target.name);
  drawText(ctx, HUD_VIEW_X + Math.floor((HUD_VIEW_W - measureText(nameBytes)) / 2), y, nameBytes, pal);
  y += STEP + 2;

  // Equipment block — only rows with actual items.
  function equipRow(label, itemId) {
    if (itemId == null) return;
    const item = ITEMS.get(itemId);
    if (!item) return;
    drawText(ctx, tx, y, _nameToBytes(label), pal);
    drawText(ctx, tx + 24, y, getItemNameShrines(itemId), pal);
    y += STEP;
  }
  equipRow('R',  s.weaponId);
  if (s.weaponL != null) equipRow('L', s.weaponL);
  equipRow('Bd', target.armorId);
  equipRow('Hd', target.helmId);
  equipRow('Sh', target.shieldId);

  ctx.restore();
}
