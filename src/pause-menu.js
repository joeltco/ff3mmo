// pause-menu.js — pause menu state, transitions, and rendering

import { drawText } from './font-renderer.js';
import { ps, getEquipSlotId, jobSwitchCost, getJobLevel } from './player-stats.js';
import { JOBS, JOB_ABBR } from './data/jobs.js';
import { _makeFadedPal, nesColorFade } from './palette.js';
import { _nameToBytes, _buildItemRowBytes } from './text-utils.js';
import { getItemNameClean } from './text-decoder.js';
import { stopFF1Music, resumeMusic, playFF1Track, FF1_TRACKS } from './music.js';
import { PAUSE_ITEMS } from './data/strings.js';
import { selectCursor, saveSlots } from './save-state.js';

// NES layout constants — must match game.js
const HUD_VIEW_X  = 0;
const HUD_VIEW_Y  = 32;
const HUD_VIEW_W  = 144;
const HUD_VIEW_H  = 144;
const HUD_RIGHT_X = 144;
const ROSTER_VISIBLE = 5;
const ROSTER_ROW_H   = 24;

// Pause timing constants
const PAUSE_EXPAND_MS    = 150;
const PAUSE_SCROLL_MS    = 150;
const PAUSE_TEXT_STEP_MS = 100;
const PAUSE_TEXT_STEPS   = 4;
const PAUSE_MENU_W       = 96;
const PAUSE_MENU_H       = 128;
const BATTLE_DMG_SHOW_MS        = 550;
const DEFEND_SPARKLE_TOTAL_MS   = 533;

// ── Mutable state ──────────────────────────────────────────────────────────
export const pauseSt = {
  state:        'none',  // 'none'|'scroll-in'|'text-in'|'open'|'text-out'|'scroll-out' + sub-states
  timer:        0,
  cursor:       0,       // 0-6 main menu cursor
  invScroll:    0,       // scroll offset for inventory list
  heldItem:     -1,      // index into inventory entries of held item (-1 = none)
  healNum:      null,    // {value, timer, rosterIdx?} — green heal number during pause item use
  useItemId:    0,       // item ID stashed between target-select and use
  invAllyTarget: -1,     // -1 = player, 0+ = ally index for pause menu item targeting
  eqCursor:     0,       // 0-5: RH, LH, HD, BD, SH, AR
  eqSlotIdx:    -100,    // which equip slot we're picking an item for
  eqItemList:   [],      // filtered items that fit the selected slot
  eqItemCursor: 0,       // cursor in eqItemList
  optCursor:    0,       // options sub-menu cursor
  jobCursor:    0,       // job sub-menu cursor
  jobList:      [],      // unlocked job indices
};

// ── Private helpers ────────────────────────────────────────────────────────

function _pauseFadeStep(inState, outState) {
  if (pauseSt.state === inState)  return PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseSt.timer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  if (pauseSt.state === outState) return Math.min(Math.floor(pauseSt.timer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  return 0;
}

function _pausePanelLayout() {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y, pw = PAUSE_MENU_W, ph = PAUSE_MENU_H;
  const isInvState   = pauseSt.state.startsWith('inv-') || pauseSt.state === 'inventory';
  const isEqState    = pauseSt.state.startsWith('eq-')  || pauseSt.state === 'equip';
  const isStatsState = pauseSt.state.startsWith('stats-') || pauseSt.state === 'stats';
  const isOptState   = pauseSt.state.startsWith('options-') || pauseSt.state === 'options';
  const isJobState   = pauseSt.state.startsWith('job-') || pauseSt.state === 'job';
  let panelY = finalY;
  if (pauseSt.state === 'scroll-in') {
    const t = Math.min(pauseSt.timer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - ph + t * ph;
  } else if (pauseSt.state === 'scroll-out') {
    const t = Math.min(pauseSt.timer / PAUSE_SCROLL_MS, 1);
    panelY = finalY - t * ph;
  }
  return { px, finalY, pw, ph, isInvState, isEqState, isStatsState, isOptState, isJobState, panelY };
}

// ── Update ─────────────────────────────────────────────────────────────────

function _updatePauseMainTransitions(playerInventory) {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'scroll-in') {
    if (pauseSt.timer >= PAUSE_SCROLL_MS) { pauseSt.state = 'text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'scroll-out'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'scroll-out') {
    if (pauseSt.timer >= PAUSE_SCROLL_MS) { pauseSt.state = 'none'; pauseSt.timer = 0; stopFF1Music(); resumeMusic(); }
  }
}

function _updatePauseInvTransitions(dt, playerInventory) {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'inv-text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'inv-expand'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-expand') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'inv-items-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-items-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'inventory'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-items-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'inv-shrink'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-shrink') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'inv-text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'inv-heal') {
    if (pauseSt.healNum) { pauseSt.healNum.timer += dt; if (pauseSt.healNum.timer >= BATTLE_DMG_SHOW_MS) pauseSt.healNum = null; }
    if (pauseSt.timer >= DEFEND_SPARKLE_TOTAL_MS) {
      pauseSt.healNum = null;
      const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
      if (pauseSt.invScroll >= entries.length) pauseSt.invScroll = Math.max(0, entries.length - 1);
      pauseSt.state = 'inventory'; pauseSt.timer = 0;
    }
  }
}

function _updatePauseEqTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'eq-text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'eq-expand'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-expand') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'eq-slots-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-slots-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'equip'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-slots-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'eq-shrink'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-shrink') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'eq-text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-items-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'eq-item-select'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'eq-items-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'equip'; pauseSt.timer = 0; }
  }
}

function _updatePauseOptionsTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'options-text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'options-expand'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'options-expand') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'options-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'options-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'options'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'options-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'options-shrink'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'options-shrink') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'options-text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'options-text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  }
}

function _updatePauseJobTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'job-text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'job-expand'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'job-expand') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'job-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'job-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'job'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'job-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'job-shrink'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'job-shrink') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'job-text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'job-text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  }
}

function _updatePauseStatsTransitions() {
  const T = (PAUSE_TEXT_STEPS + 1) * PAUSE_TEXT_STEP_MS;
  if (pauseSt.state === 'stats-text-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'stats-expand'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'stats-expand') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'stats-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'stats-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'stats'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'stats-out') {
    if (pauseSt.timer >= T) { pauseSt.state = 'stats-shrink'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'stats-shrink') {
    if (pauseSt.timer >= PAUSE_EXPAND_MS) { pauseSt.state = 'stats-text-in'; pauseSt.timer = 0; }
  } else if (pauseSt.state === 'stats-text-in') {
    if (pauseSt.timer >= T) { pauseSt.state = 'open'; pauseSt.timer = 0; }
  }
}

export function updatePauseMenu(dt, playerInventory) {
  if (pauseSt.state === 'none') return;
  pauseSt.timer += Math.min(dt, 33);
  if (pauseSt.state.startsWith('inv-'))            _updatePauseInvTransitions(dt, playerInventory);
  else if (pauseSt.state.startsWith('eq-'))        _updatePauseEqTransitions();
  else if (pauseSt.state.startsWith('stats-') || pauseSt.state === 'stats') _updatePauseStatsTransitions();
  else if (pauseSt.state.startsWith('options-') || pauseSt.state === 'options') _updatePauseOptionsTransitions();
  else if (pauseSt.state.startsWith('job-') || pauseSt.state === 'job') _updatePauseJobTransitions();
  else                                              _updatePauseMainTransitions(playerInventory);
}

// ── Draw helpers ───────────────────────────────────────────────────────────

function _drawPauseBox(ctx, shared) {
  const { px, finalY, pw, ph, isInvState, isEqState, isStatsState, isOptState, isJobState, panelY } = _pausePanelLayout();
  const { _drawBorderedBox } = shared;
  if (isInvState || isEqState || isStatsState || isOptState || isJobState) {
    let t = 1;
    if (pauseSt.state === 'inv-expand' || pauseSt.state === 'eq-expand' || pauseSt.state === 'stats-expand' || pauseSt.state === 'options-expand' || pauseSt.state === 'job-expand') {
      t = Math.min(pauseSt.timer / PAUSE_EXPAND_MS, 1);
    } else if (pauseSt.state === 'inv-shrink' || pauseSt.state === 'eq-shrink' || pauseSt.state === 'stats-shrink' || pauseSt.state === 'options-shrink' || pauseSt.state === 'job-shrink') {
      t = 1 - Math.min(pauseSt.timer / PAUSE_EXPAND_MS, 1);
    } else if (pauseSt.state === 'inv-text-out' || pauseSt.state === 'eq-text-out' || pauseSt.state === 'stats-text-out' || pauseSt.state === 'options-text-out' || pauseSt.state === 'job-text-out' ||
               pauseSt.state === 'inv-text-in'  || pauseSt.state === 'eq-text-in'  || pauseSt.state === 'stats-text-in'  || pauseSt.state === 'options-text-in'  || pauseSt.state === 'job-text-in') {
      t = 0;
    }
    const bw = Math.round(pw + (HUD_VIEW_W - pw) * t);
    const bh = Math.round(ph + (HUD_VIEW_H - ph) * t);
    _drawBorderedBox(px, finalY, bw, bh);
  } else {
    _drawBorderedBox(px, panelY, pw, ph);
  }
}

function _drawPauseMenuText(ctx, shared) {
  const { px, finalY, pw, ph, isInvState, isEqState, isStatsState, isOptState, isJobState, panelY } = _pausePanelLayout();
  const { _drawCursorFaded } = shared;
  const showPauseText = pauseSt.state === 'text-in' || pauseSt.state === 'open' || pauseSt.state === 'text-out' ||
                        pauseSt.state === 'inv-text-out' || pauseSt.state === 'inv-text-in' ||
                        pauseSt.state === 'eq-text-out' || pauseSt.state === 'eq-text-in' ||
                        pauseSt.state === 'stats-text-out' || pauseSt.state === 'stats-text-in' ||
                        pauseSt.state === 'options-text-out' || pauseSt.state === 'options-text-in' ||
                        pauseSt.state === 'job-text-out' || pauseSt.state === 'job-text-in';
  if (!showPauseText) return;
  let fadeStep = 0;
  if (pauseSt.state === 'text-in' || pauseSt.state === 'inv-text-in' || pauseSt.state === 'eq-text-in' || pauseSt.state === 'stats-text-in' || pauseSt.state === 'options-text-in' || pauseSt.state === 'job-text-in') {
    fadeStep = PAUSE_TEXT_STEPS - Math.min(Math.floor(pauseSt.timer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  } else if (pauseSt.state === 'text-out' || pauseSt.state === 'inv-text-out' || pauseSt.state === 'eq-text-out' || pauseSt.state === 'stats-text-out' || pauseSt.state === 'options-text-out' || pauseSt.state === 'job-text-out') {
    fadeStep = Math.min(Math.floor(pauseSt.timer / PAUSE_TEXT_STEP_MS), PAUSE_TEXT_STEPS);
  }
  const fadedPal = _makeFadedPal(fadeStep);
  const textX = px + 24;
  const startY = ((isInvState || isEqState || isStatsState || isOptState || isJobState) ? finalY : panelY) + 12;
  for (let i = 0; i < PAUSE_ITEMS.length; i++) {
    drawText(ctx, textX, startY + i * 16, PAUSE_ITEMS[i], fadedPal);
  }
  _drawCursorFaded(px + 8, startY + pauseSt.cursor * 16 - 4, fadeStep);
}

function _drawPauseInventory(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const { playerInventory, _drawCursorFaded } = shared;
  const showInvItems = pauseSt.state === 'inv-items-in' || pauseSt.state === 'inventory' || pauseSt.state === 'inv-items-out' ||
    pauseSt.state === 'inv-target' || pauseSt.state === 'inv-heal';
  if (!showInvItems) return;
  const fadeStep = _pauseFadeStep('inv-items-in', 'inv-items-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
  const startIdx = Math.max(0, Math.min(pauseSt.invScroll, Math.max(0, entries.length - maxVisible)));
  for (let i = 0; i < maxVisible && startIdx + i < entries.length; i++) {
    const [id, count] = entries[startIdx + i];
    const nameBytes = getItemNameClean(Number(id));
    const countStr = String(count);
    const rowBytes = _buildItemRowBytes(nameBytes, countStr);
    const iy = finalY + 12 + i * 14;
    drawText(ctx, px + 24, iy, rowBytes, fadedPal);
    if (pauseSt.heldItem >= 0 && startIdx + i === pauseSt.heldItem && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal')
      _drawCursorFaded(px + 8, iy - 4, fadeStep);
    if (startIdx + i === pauseSt.invScroll && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal') {
      const activeX = pauseSt.heldItem >= 0 ? px + 4 : px + 8;
      _drawCursorFaded(activeX, iy - 4, fadeStep);
    }
  }
}

function _drawPauseEquipSlots(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const { cursorTileCanvas } = shared;
  const showEqSlots = pauseSt.state === 'eq-slots-in' || pauseSt.state === 'equip' || pauseSt.state === 'eq-slots-out' ||
    pauseSt.state === 'eq-items-in' || pauseSt.state === 'eq-item-select' || pauseSt.state === 'eq-items-out';
  if (!showEqSlots) return;
  const fadeStep = _pauseFadeStep('eq-slots-in', 'eq-slots-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const EQ_LABELS = [
    new Uint8Array([0x9B,0xC4,0x91,0xCA,0xD7,0xCD]),
    new Uint8Array([0x95,0xC4,0x91,0xCA,0xD7,0xCD]),
    new Uint8Array([0x91,0xCE,0xCA,0xCD]),
    new Uint8Array([0x8B,0xD8,0xCD,0xE2]),
    new Uint8Array([0x8A,0xDB,0xD6,0xDC]),
  ];
  const EQ_IDS = [-100, -101, -102, -103, -104];
  const eqRowH = 22;
  const eqStartY = finalY + 12;
  const dimSlots = pauseSt.state === 'eq-items-in' || pauseSt.state === 'eq-item-select' || pauseSt.state === 'eq-items-out';
  for (let r = 0; r < 5; r++) {
    const slotId = getEquipSlotId(EQ_IDS[r]);
    const label = EQ_LABELS[r];
    const iy = eqStartY + r * eqRowH;
    const labelPal  = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
    const activePal = (dimSlots && r === pauseSt.eqCursor) ? fadedPal : labelPal;
    drawText(ctx, px + 24, iy, label, activePal);
    if (slotId !== 0) {
      drawText(ctx, px + 24, iy + 9, getItemNameClean(slotId), activePal);
    } else {
      drawText(ctx, px + 24, iy + 9, new Uint8Array([0xC2,0xC2,0xC2]), activePal);
    }
  }
  const optY   = eqStartY + 5 * eqRowH + 4;
  const optPal  = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
  const optText = new Uint8Array([0x98,0xD9,0xDD,0xD2,0xD6,0xDE,0xD6]);
  drawText(ctx, px + 24, optY, optText, optPal);
  if (cursorTileCanvas && pauseSt.state === 'equip' && fadeStep === 0) {
    const curY = pauseSt.eqCursor < 5 ? eqStartY + pauseSt.eqCursor * eqRowH - 4 : optY - 4;
    ctx.drawImage(cursorTileCanvas, px + 8, curY);
  }
}

function _drawPauseEquipItems(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const { cursorTileCanvas } = shared;
  const showEqItems = pauseSt.state === 'eq-items-in' || pauseSt.state === 'eq-item-select' || pauseSt.state === 'eq-items-out';
  if (!showEqItems) return;
  const fadeStep = _pauseFadeStep('eq-items-in', 'eq-items-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const listX = px + 24;
  const listY = finalY + 12 + pauseSt.eqCursor * 22 + 22;
  const maxBelow = Math.floor((finalY + HUD_VIEW_H - 16 - listY) / 12);
  const useY = maxBelow >= pauseSt.eqItemList.length ? listY : finalY + 12;
  if (pauseSt.eqItemList.length === 0) {
    drawText(ctx, listX, useY, new Uint8Array([0xC2,0xC2,0xC2]), fadedPal);
  } else {
    for (let i = 0; i < pauseSt.eqItemList.length; i++) {
      const entry = pauseSt.eqItemList[i];
      const iy = useY + i * 12;
      if (iy + 8 > finalY + HUD_VIEW_H - 8) break;
      if (entry.label === 'remove') {
        drawText(ctx, listX + 16, iy, new Uint8Array([0x9B,0xCE,0xD6,0xD8,0xDF,0xCE]), fadedPal);
      } else {
        drawText(ctx, listX + 16, iy, getItemNameClean(entry.id), fadedPal);
      }
    }
    if (cursorTileCanvas && pauseSt.state === 'eq-item-select' && fadeStep === 0) {
      ctx.drawImage(cursorTileCanvas, listX, useY + pauseSt.eqItemCursor * 12 - 4);
    }
  }
}

function _drawPauseStats(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  // selectCursor, saveSlots imported from save-state.js
  const show = pauseSt.state === 'stats-in' || pauseSt.state === 'stats' || pauseSt.state === 'stats-out';
  if (!show) return;
  const fadeStep = _pauseFadeStep('stats-in', 'stats-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const tx = px + 8;
  const statRx = tx + 128;
  const STEP = 11;
  let y = finalY + 8;

  const s = ps.stats;
  if (!s) return;

  function statRow(label, val) {
    const vb = _nameToBytes(val);
    drawText(ctx, tx, y, _nameToBytes(label), fadedPal);
    drawText(ctx, statRx - vb.length * 8, y, vb, fadedPal);
    y += STEP;
  }
  const GAP = 16; // 2-char gap between labels and values
  const r1LabelX = tx + 72; // fixed column for right-side labels
  function statPair(l0, v0, l1, v1) {
    const l0b = _nameToBytes(l0), v0b = _nameToBytes(v0);
    const l1b = _nameToBytes(l1), v1b = _nameToBytes(v1);
    drawText(ctx, tx, y, l0b, fadedPal);
    drawText(ctx, tx + l0b.length * 8 + GAP, y, v0b, fadedPal);
    drawText(ctx, r1LabelX, y, l1b, fadedPal);
    drawText(ctx, statRx - v1b.length * 8, y, v1b, fadedPal);
    y += STEP;
  }

  const slot = saveSlots[selectCursor];
  if (slot?.name) {
    const nb = slot.name;
    drawText(ctx, statRx - nb.length * 8, y, nb, fadedPal);
    y += STEP;
  }

  statRow('Lv',   String(s.level));
  const hpStr = ps.hp + '/' + s.maxHP;
  const mpStr = ps.mp + '/' + s.maxMP;
  const hpb = _nameToBytes(hpStr), mpb = _nameToBytes(mpStr);
  drawText(ctx, tx, y, _nameToBytes('HP'), fadedPal);
  drawText(ctx, statRx - hpb.length * 8, y, hpb, fadedPal);
  y += STEP;
  drawText(ctx, tx, y, _nameToBytes('MP'), fadedPal);
  drawText(ctx, statRx - mpb.length * 8, y, mpb, fadedPal);
  y += STEP;
  statRow('EXP',  String(s.exp));
  statRow('Next', String(s.expToNext));
  statPair('ATK', String(ps.atk),  'DEF', String(ps.def));
  statPair('HIT', String(ps.hitRate), 'EVD', String(ps.evade));
  statPair('STR', String(s.str),   'AGI', String(s.agi));
  statPair('VIT', String(s.vit),   'INT', String(s.int));
  statPair('MND', String(s.mnd),   'MDF', String(ps.mdef));
  statRow('Gil',  String(ps.gil));
  y += STEP;

}

const OPT_CRT_LABEL = new Uint8Array([0x8C,0x9B,0x9D]); // "CRT"
const OPT_ON  = new Uint8Array([0x98,0xD7]); // "On"
const OPT_OFF = new Uint8Array([0x98,0xCF,0xCF]); // "Off"

function _isCrtOn() {
  const el = document.getElementById('canvas-wrapper');
  return el && el.classList.contains('crt');
}

function _toggleCrt() {
  const el = document.getElementById('canvas-wrapper');
  if (el) el.classList.toggle('crt');
}

function _drawPauseOptions(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const { cursorTileCanvas } = shared;
  const show = pauseSt.state === 'options-in' || pauseSt.state === 'options' || pauseSt.state === 'options-out';
  if (!show) return;
  const fadeStep = _pauseFadeStep('options-in', 'options-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const tx = px + 24;
  const valRx = px + HUD_VIEW_W - 16;
  let y = finalY + 12;
  drawText(ctx, tx, y, OPT_CRT_LABEL, fadedPal);
  const valBytes = _isCrtOn() ? OPT_ON : OPT_OFF;
  drawText(ctx, valRx - valBytes.length * 8, y, valBytes, fadedPal);
  if (cursorTileCanvas && pauseSt.state === 'options' && fadeStep === 0) {
    ctx.drawImage(cursorTileCanvas, px + 8, y + pauseSt.optCursor * 16 - 4);
  }
}

function _drawPauseJob(ctx, shared) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const { cursorTileCanvas } = shared;
  const show = pauseSt.state === 'job-in' || pauseSt.state === 'job' || pauseSt.state === 'job-out';
  if (!show) return;
  const fadeStep = _pauseFadeStep('job-in', 'job-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const tx = px + 24;
  const valRx = px + HUD_VIEW_W - 16;
  let y = finalY + 12;
  // CP counter at top
  const cpLabel = _nameToBytes('CP');
  const cpVal = _nameToBytes(String(ps.cp));
  drawText(ctx, tx, y, cpLabel, fadedPal);
  drawText(ctx, valRx - cpVal.length * 8, y, cpVal, fadedPal);
  y += 14;
  // Job list
  for (let i = 0; i < pauseSt.jobList.length; i++) {
    const jobIdx = pauseSt.jobList[i];
    const isCurrentJob = jobIdx === ps.jobIdx;
    const cost = jobSwitchCost(jobIdx);
    const canAfford = isCurrentJob || ps.cp >= cost;
    let pal;
    if (isCurrentJob) {
      let g = 0x2A; for (let s = 0; s < fadeStep; s++) g = nesColorFade(g);
      pal = [0x0F, 0x0F, 0x0F, g]; // green, faded
    } else if (!canAfford) {
      let gr = 0x00; for (let s = 0; s < fadeStep; s++) gr = nesColorFade(gr);
      pal = [0x0F, 0x0F, 0x0F, gr]; // grey, faded
    } else {
      pal = fadedPal;
    }
    const ry = y + i * 12;
    // Abbr (2 chars)  Lv (right-aligned 2 chars)  Cost (right-aligned 2 chars)
    drawText(ctx, tx, ry, _nameToBytes(JOB_ABBR[jobIdx] || '??'), pal);
    const jlv = getJobLevel(jobIdx);
    const jlvBytes = _nameToBytes(String(jlv));
    const lvX = tx + 32; // after abbr + gap
    drawText(ctx, lvX + 16 - jlvBytes.length * 8, ry, jlvBytes, pal);
    if (!isCurrentJob && cost > 0) {
      const costBytes = _nameToBytes(String(cost));
      drawText(ctx, valRx - costBytes.length * 8, ry, costBytes, pal);
    }
  }
  if (shared.drawCursorFaded) {
    shared.drawCursorFaded(px + 8, y + pauseSt.jobCursor * 12 - 4, fadeStep);
  }
}

// ── Public draw API ────────────────────────────────────────────────────────

// shared = { playerInventory, saveSlots, selectCursor, cursorTileCanvas, rosterScroll,
//            _drawBorderedBox, _clipToViewport, _drawCursorFaded }
export function drawPauseMenu(ctx, shared) {
  if (pauseSt.state === 'none') return;
  shared._clipToViewport();
  _drawPauseBox(ctx, shared);
  _drawPauseMenuText(ctx, shared);
  _drawPauseInventory(ctx, shared);
  _drawPauseEquipSlots(ctx, shared);
  _drawPauseEquipItems(ctx, shared);
  _drawPauseStats(ctx, shared);
  _drawPauseOptions(ctx, shared);
  _drawPauseJob(ctx, shared);
  ctx.restore();
  // Target cursor on portrait — drawn after restore so it's unclipped
  const { cursorTileCanvas, rosterScroll } = shared;
  if (pauseSt.state === 'inv-target' && cursorTileCanvas) {
    if (pauseSt.invAllyTarget >= 0) {
      const visRow = pauseSt.invAllyTarget - rosterScroll;
      if (visRow >= 0 && visRow < ROSTER_VISIBLE) {
        ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 32 + visRow * ROSTER_ROW_H + 12);
      }
    } else {
      ctx.drawImage(cursorTileCanvas, HUD_RIGHT_X - 4, HUD_VIEW_Y + 12);
    }
  }
}
