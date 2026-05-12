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

  // Name top-right (matches pause stats screen layout)
  const nameBytes = _nameToBytes(target.name);
  drawText(ctx, rx - measureText(nameBytes), y, nameBytes, pal);
  y += STEP;

  // Job + Lv
  const jobName = JOB_NAMES_SHRINES[target.jobIdx] || (JOBS[target.jobIdx] && JOBS[target.jobIdx].name) || '???';
  drawText(ctx, tx, y, _nameToBytes(jobName), pal);
  const lvBytes = _nameToBytes('Lv ' + s.level);
  drawText(ctx, rx - measureText(lvBytes), y, lvBytes, pal);
  y += STEP;

  // HP
  const hpStr = s.hp + '/' + s.maxHP;
  const hpBytes = _nameToBytes(hpStr);
  drawText(ctx, tx, y, _nameToBytes('HP'), pal);
  drawText(ctx, rx - measureText(hpBytes), y, hpBytes, pal);
  y += STEP;

  const GAP = 8;
  const r1LabelX = tx + 64;
  function pair(l0, v0, l1, v1) {
    const l0b = _nameToBytes(l0), v0b = _nameToBytes(v0);
    const l1b = _nameToBytes(l1), v1b = _nameToBytes(v1);
    drawText(ctx, tx, y, l0b, pal);
    drawText(ctx, tx + l0b.length * 8 + GAP, y, v0b, pal);
    drawText(ctx, r1LabelX, y, l1b, pal);
    drawText(ctx, rx - v1b.length * 8, y, v1b, pal);
    y += STEP;
  }
  pair('ATK', String(s.atk), 'DEF', String(s.def));
  pair('AGI', String(s.agi), 'INT', String(s.int));
  pair('MND', String(s.mnd), 'EVD', String(s.evade));

  // Equipment block — only rows with actual items
  y += 2;
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

  // Spells (first 2 — Black Mages at high level can have many)
  if (s.knownSpells && s.knownSpells.length > 0) {
    y += 2;
    const shown = s.knownSpells.slice(0, 2);
    for (const spellId of shown) {
      drawText(ctx, tx, y, getSpellNameShrines(spellId), pal);
      y += STEP;
    }
    if (s.knownSpells.length > 2) {
      drawText(ctx, tx, y, _nameToBytes('+' + (s.knownSpells.length - 2) + ' more'), pal);
    }
  }

  ctx.restore();
}
