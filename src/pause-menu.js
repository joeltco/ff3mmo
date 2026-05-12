// pause-menu.js — pause menu state, transitions, and rendering

import { drawText, measureText } from './font-renderer.js';
import { ps, getEquipSlotId, setEquipSlotId, jobSwitchCost, getJobLevel, getJobLevelStatBonus,
         recalcCombatStats, changeJob, EQUIP_SLOT_SUBTYPE } from './player-stats.js';
import { JOBS, JOB_NAMES_SHRINES, canJobEquip } from './data/jobs.js';
import { _makeFadedPal, nesColorFade } from './palette.js';
import { _nameToBytes } from './text-utils.js';
import { getItemNameClean, getItemNameShrines, getSpellNameClean, getSpellNameShrines } from './text-decoder.js';
import { SPELLS, getSpellMPCost, getCastableKnownSpells } from './data/spells.js';
import { stopFF1Music, resumeMusic, playFF1Track, FF1_TRACKS, playSFX, SFX, pauseMusic } from './music.js';
import { PAUSE_ITEMS } from './data/strings.js';
import { selectCursor, saveSlots, saveSlotsToDB } from './save-state.js';
import { ui } from './ui-state.js';
import { inputSt, keys } from './input-handler.js';
import { drawBorderedBox, clipToViewport, drawCursorFaded } from './hud-drawing.js';
import { playerInventory, addItem, removeItem } from './inventory.js';
import { battleSt } from './battle-state.js';
import { transSt } from './transitions.js';
import { mapSt } from './map-state.js';
import { msgState } from './message-box.js';
import { ITEMS, isHandEquippable } from './data/items.js';
import { swapBattleSprites } from './job-sprites.js';
import { getRosterVisible } from './roster.js';
import { STATUS, STATUS_NAME_TO_FLAG, canCastMagic } from './status-effects.js';
import { applyMagicHeal, applyMagicCureStatus } from './combatant-cast.js';

// NES layout constants — must match game.js
const HUD_VIEW_X  = 0;
const HUD_VIEW_Y  = 32;
const HUD_VIEW_W  = 144;
const HUD_VIEW_H  = 144;
const HUD_RIGHT_X = 144;
const ROSTER_VISIBLE = 3;    // must match roster.js — visible row count for the right-side panel
const ROSTER_ROW_H   = 32;   // must match roster.js — was 24, caused inv-target cursor to drift down per row

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
  // Magic submenu (piggybacks on inv-* state machine; menuMode toggles list/input/draw branches)
  menuMode:     'inv',   // 'inv' or 'magic'
  magicCursor:  0,       // active spell index when menuMode === 'magic'
  useSpellId:   0,       // spell ID stashed between magic-list Z press and inv-target confirm (0 = none)
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

function _updatePauseMainTransitions() {
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

function _updatePauseInvTransitions(dt) {
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
    if (pauseSt.timer >= T) {
      pauseSt.state = 'open'; pauseSt.timer = 0;
      pauseSt.menuMode = 'inv';   // reset so a future Item-cursor open starts in inv mode
    }
  } else if (pauseSt.state === 'inv-heal') {
    if (pauseSt.healNum) { pauseSt.healNum.timer += dt; if (pauseSt.healNum.timer >= BATTLE_DMG_SHOW_MS) pauseSt.healNum = null; }
    if (pauseSt.timer >= DEFEND_SPARKLE_TOTAL_MS) {
      pauseSt.healNum = null;
      if (pauseSt.menuMode === 'inv') {
        const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
        if (pauseSt.invScroll >= entries.length) pauseSt.invScroll = Math.max(0, entries.length - 1);
      }
      // Magic mode: stay in 'inventory' state; the spell list re-renders via menuMode branch.
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

export function updatePauseMenu(dt) {
  if (pauseSt.state === 'none') return;
  pauseSt.timer += Math.min(dt, 33);
  if (pauseSt.state.startsWith('inv-'))            _updatePauseInvTransitions(dt);
  else if (pauseSt.state.startsWith('eq-'))        _updatePauseEqTransitions();
  else if (pauseSt.state.startsWith('stats-') || pauseSt.state === 'stats') _updatePauseStatsTransitions();
  else if (pauseSt.state.startsWith('options-') || pauseSt.state === 'options') _updatePauseOptionsTransitions();
  else if (pauseSt.state.startsWith('job-') || pauseSt.state === 'job') _updatePauseJobTransitions();
  else                                              _updatePauseMainTransitions();
}

// ── Draw helpers ───────────────────────────────────────────────────────────

function _drawPauseBox(ctx) {
  const { px, finalY, pw, ph, isInvState, isEqState, isStatsState, isOptState, isJobState, panelY } = _pausePanelLayout();
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
    drawBorderedBox(px, finalY, bw, bh);
  } else {
    drawBorderedBox(px, panelY, pw, ph);
  }
}

function _drawPauseMenuText(ctx) {
  const { px, finalY, pw, ph, isInvState, isEqState, isStatsState, isOptState, isJobState, panelY } = _pausePanelLayout();
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
  drawCursorFaded(px + 8, startY + pauseSt.cursor * 16 - 4, fadeStep);
}

function _drawPauseInventory(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const showInvItems = pauseSt.state === 'inv-items-in' || pauseSt.state === 'inventory' || pauseSt.state === 'inv-items-out' ||
    pauseSt.state === 'inv-target' || pauseSt.state === 'inv-heal';
  if (!showInvItems) return;
  if (pauseSt.menuMode === 'magic') { _drawPauseMagicList(ctx); return; }
  const fadeStep = _pauseFadeStep('inv-items-in', 'inv-items-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
  const startIdx = Math.max(0, Math.min(pauseSt.invScroll, Math.max(0, entries.length - maxVisible)));
  const countRx = px + HUD_VIEW_W - 16;
  for (let i = 0; i < maxVisible && startIdx + i < entries.length; i++) {
    const [id, count] = entries[startIdx + i];
    const nameBytes = getItemNameShrines(Number(id));
    const countBytes = _nameToBytes(String(count));
    const iy = finalY + 12 + i * 14;
    drawText(ctx, px + 24, iy, nameBytes, fadedPal);
    drawText(ctx, countRx - measureText(countBytes), iy, countBytes, fadedPal);
    if (pauseSt.heldItem >= 0 && startIdx + i === pauseSt.heldItem && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal')
      drawCursorFaded(px + 8, iy - 4, fadeStep);
    if (startIdx + i === pauseSt.invScroll && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal') {
      const activeX = pauseSt.heldItem >= 0 ? px + 4 : px + 8;
      drawCursorFaded(activeX, iy - 4, fadeStep);
    }
  }
}

function _drawPauseMagicList(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const fadeStep = _pauseFadeStep('inv-items-in', 'inv-items-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const list = getCastableKnownSpells(ps.jobIdx, ps.knownSpells);
  const colW = HUD_VIEW_W;
  const costRightX = px + colW - 16;
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    const name = getSpellNameShrines(id);
    const iy = finalY + 12 + i * 14;
    drawText(ctx, px + 24, iy, name, fadedPal);
    const cost = getSpellMPCost(id);
    if (cost > 0) {
      const costStr = String(cost);
      const costBytes = new Uint8Array(costStr.length);
      for (let c = 0; c < costStr.length; c++) costBytes[c] = 0x80 + parseInt(costStr[c]);
      drawText(ctx, costRightX - costBytes.length * 8, iy, costBytes, fadedPal);
    }
    if (i === pauseSt.magicCursor && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal') {
      drawCursorFaded(px + 8, iy - 4, fadeStep);
    }
  }
}

function _drawPauseEquipSlots(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
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
      drawText(ctx, px + 24, iy + 9, getItemNameShrines(slotId), activePal);
    } else {
      drawText(ctx, px + 24, iy + 9, new Uint8Array([0xC2,0xC2,0xC2]), activePal);
    }
  }
  // "Opt" right-aligned on R.Hand row
  const optPal  = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
  const optText = new Uint8Array([0x98,0xD9,0xDD]); // "Opt"
  const optX = px + HUD_VIEW_W - 16 - optText.length * 8;
  const optActivePal = (dimSlots && pauseSt.eqCursor === 5) ? fadedPal : optPal;
  drawText(ctx, optX, eqStartY, optText, optActivePal);
  // ATK / DEF on bottom row
  const atkDefY = eqStartY + 5 * eqRowH + 4;
  const atkDefPal = dimSlots ? [0x0F, 0x0F, 0x0F, 0x00] : fadedPal;
  drawText(ctx, px + 24, atkDefY, _nameToBytes('ATK'), atkDefPal);
  drawText(ctx, px + 24 + 32, atkDefY, _nameToBytes(String(ps.atk)), atkDefPal);
  drawText(ctx, px + 80, atkDefY, _nameToBytes('DEF'), atkDefPal);
  drawText(ctx, px + 80 + 32, atkDefY, _nameToBytes(String(ps.def)), atkDefPal);
  if (drawCursorFaded) {
    if (pauseSt.eqCursor < 5) {
      drawCursorFaded(px + 8, eqStartY + pauseSt.eqCursor * eqRowH - 4, fadeStep);
    } else {
      drawCursorFaded(optX - 16, eqStartY - 4, fadeStep);
    }
  }
}

function _drawPauseEquipItems(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
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
        drawText(ctx, listX + 16, iy, getItemNameShrines(entry.id), fadedPal);
      }
    }
    if (drawCursorFaded) {
      drawCursorFaded(listX, useY + pauseSt.eqItemCursor * 12 - 4, fadeStep);
    }
  }
}

function _drawPauseStats(ctx) {
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
  const jlb = getJobLevelStatBonus();
  statPair('STR', String(s.str + jlb.str), 'AGI', String(s.agi + jlb.agi));
  statPair('VIT', String(s.vit + jlb.vit), 'INT', String(s.int + jlb.int));
  statPair('MND', String(s.mnd + jlb.mnd), 'MDF', String(ps.mdef));
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

function _drawPauseOptions(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
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
  if (drawCursorFaded) {
    drawCursorFaded(px + 8, y + pauseSt.optCursor * 16 - 4, fadeStep);
  }
}

function _drawPauseJob(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
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
    // Shrines short name (≤8 chars, truncated)  Lv (right-aligned 2 chars)  Cost (right-aligned 2-3 chars)
    const fullName = JOB_NAMES_SHRINES[jobIdx] || '??';
    const nameStr = fullName.length > 8 ? fullName.slice(0, 8) : fullName;
    drawText(ctx, tx, ry, _nameToBytes(nameStr), pal);
    const jlv = getJobLevel(jobIdx);
    const jlvBytes = _nameToBytes(String(jlv));
    // Lv right-aligned just before the cost column. valRx=128 is the
    // cost right-edge; cost is ≤3 chars (24 px), so Lv ends at 104.
    // Name occupies tx (24) .. lvRx-16 (88) = 64 px = 8 chars.
    const lvRx = valRx - 24;
    drawText(ctx, lvRx - jlvBytes.length * 8, ry, jlvBytes, pal);
    if (!isCurrentJob && cost > 0) {
      const costBytes = _nameToBytes(String(cost));
      drawText(ctx, valRx - costBytes.length * 8, ry, costBytes, pal);
    }
  }
  if (drawCursorFaded) {
    drawCursorFaded(px + 8, y + pauseSt.jobCursor * 12 - 4, fadeStep);
  }
}

// ── Public draw API ────────────────────────────────────────────────────────

export function drawPauseMenu(ctx) {
  if (pauseSt.state === 'none') return;
  clipToViewport();
  _drawPauseBox(ctx);
  _drawPauseMenuText(ctx);
  _drawPauseInventory(ctx);
  _drawPauseEquipSlots(ctx);
  _drawPauseEquipItems(ctx);
  _drawPauseStats(ctx);
  _drawPauseOptions(ctx);
  _drawPauseJob(ctx);
  ctx.restore();
  // Target cursor on portrait — drawn after restore so it's unclipped
  const cursorTile = ui.cursorTileCanvas;
  if (pauseSt.state === 'inv-target' && cursorTile) {
    if (pauseSt.invAllyTarget >= 0) {
      const visRow = pauseSt.invAllyTarget - inputSt.rosterScroll;
      if (visRow >= 0 && visRow < ROSTER_VISIBLE) {
        ctx.drawImage(cursorTile, HUD_RIGHT_X - 4, HUD_VIEW_Y + 32 + visRow * ROSTER_ROW_H + 12);
      }
    } else {
      ctx.drawImage(cursorTile, HUD_RIGHT_X - 4, HUD_VIEW_Y + 12);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Pause-menu input handlers — extracted from input-handler.js v1.7.192.
//
// Drives the pause-menu state machine from keyboard input. Mirrors the
// state declared in `pauseSt` above. Outside callers: `handlePauseInput`
// invoked from `movement.js` (pre-update tick).

// `_returnToTitle` is injected at boot to break the circular import on
// main.js. `_toggleCrt` is defined locally above (line 476). Set via
// `initPauseMenuInput({ returnToTitle })`.
let _returnToTitle = () => {};
export function initPauseMenuInput(deps) {
  _returnToTitle = deps.returnToTitle;
}

// Local helpers — the input-handler module's `_zPressed` / `_xPressed` reset
// the key state on read. Inlined here so pause-menu doesn't need to expose
// them as exports from input-handler.
function _zPressed() {
  const k = keys;
  if (!k['z'] && !k['Z']) return false;
  k['z'] = false; k['Z'] = false; return true;
}
function _xPressed() {
  const k = keys;
  if (!k['x'] && !k['X']) return false;
  k['x'] = false; k['X'] = false; return true;
}

// ── Pause input ────────────────────────────────────────────────────────────

function _pauseInputOpenClose() {
  const k = keys;
  if (k['Enter']) {
    k['Enter'] = false;
    if (pauseSt.state === 'none' && battleSt.battleState === 'none' && transSt.state === 'none' && !mapSt.shakeActive && !mapSt.starEffect && !mapSt.moving && msgState.state === 'none') {
      playSFX(SFX.CONFIRM);
      pauseMusic();
      playFF1Track(FF1_TRACKS.MENU_SCREEN);
      pauseSt.state = 'scroll-in'; pauseSt.timer = 0; pauseSt.cursor = 0;
    }
    return true;
  }
  if (k['x'] || k['X']) {
    if (pauseSt.state === 'open') {
      k['x'] = false; k['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'text-out'; pauseSt.timer = 0;
      return true;
    }
  }
  return false;
}

function _pauseInputMainMenu() {
  if (pauseSt.state !== 'open') return false;
  const k = keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.cursor = (pauseSt.cursor + 1) % 7; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.cursor = (pauseSt.cursor + 6) % 7; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    if (pauseSt.cursor === 0) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'inv-text-out'; pauseSt.timer = 0; pauseSt.invScroll = 0;
    } else if (pauseSt.cursor === 1) {
      _pauseInputMagicZ();
    } else if (pauseSt.cursor === 2) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'eq-text-out'; pauseSt.timer = 0; pauseSt.eqCursor = 0;
    } else if (pauseSt.cursor === 3) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'stats-text-out'; pauseSt.timer = 0;
    } else if (pauseSt.cursor === 4) {
      playSFX(SFX.CONFIRM);
      pauseSt.jobList = [];
      for (let i = 0; i < 22; i++) { if ((ps.unlockedJobs >> i) & 1) pauseSt.jobList.push(i); }
      pauseSt.jobCursor = Math.max(0, pauseSt.jobList.indexOf(ps.jobIdx));
      pauseSt.state = 'job-text-out'; pauseSt.timer = 0;
    } else if (pauseSt.cursor === 5) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'options-text-out'; pauseSt.timer = 0; pauseSt.optCursor = 0;
    } else if (pauseSt.cursor === 6) {
      playSFX(SFX.CONFIRM);
      _returnToTitle();
    }
  }
  return true;
}

// Pause-menu Magic submenu — opens the inventory state machine in 'magic' mode.
function _pauseInputMagicZ() {
  const known = getCastableKnownSpells(ps.jobIdx, ps.knownSpells);
  if (known.length === 0) { playSFX(SFX.ERROR); return; }
  playSFX(SFX.CONFIRM);
  pauseSt.menuMode = 'magic';
  pauseSt.magicCursor = 0;
  pauseSt.magicHeldId = -1;
  pauseSt.state = 'inv-text-out';
  pauseSt.timer = 0;
}

// Apply a pause-menu spell cast on the current target (player or roster ally).
function _applyPauseSpellUse(rosterTargets) {
  const spellId = pauseSt.useSpellId;
  const spell = SPELLS.get(spellId);
  if (!spell) { playSFX(SFX.ERROR); return; }
  // Silence gate — Silenced player can't cast out-of-battle either.
  // Echo Herbs still work (items bypass Silence).
  if (ps.status && !canCastMagic(ps.status)) { playSFX(SFX.ERROR); return; }
  const cost = getSpellMPCost(spellId);
  if (ps.mp < cost) { playSFX(SFX.ERROR); return; }
  ps.mp -= cost;

  // Status-cure spells (Poisona, Bndna, …) — remove the matching status and bounce a 0-heal number.
  // Routes through `applyMagicCureStatus` so the in-battle and pause paths share
  // the same status-removal logic (single-source per memory feedback).
  if (spell.target === 'cure_status') {
    const flag = STATUS_NAME_TO_FLAG[spell.type];
    if (pauseSt.invAllyTarget >= 0) {
      const rp = rosterTargets[pauseSt.invAllyTarget];
      if (!rp) { playSFX(SFX.ERROR); return; }
      if (flag) applyMagicCureStatus(rp, flag);
      pauseSt.healNum = { value: 0, timer: 0, rosterIdx: pauseSt.invAllyTarget, spellId };
    } else {
      if (flag) applyMagicCureStatus(ps, flag);
      pauseSt.healNum = { value: 0, timer: 0, spellId };
    }
    playSFX(SFX.CURE);
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    pauseSt.useSpellId = 0;
    saveSlotsToDB();
    return;
  }

  // 0x36 Sight — out-of-battle scan has no gameplay effect; guard against
  // the heal math below using `power: 0` to accidentally tick a few HP.
  if (spell.target === 'sight') {
    if (pauseSt.invAllyTarget >= 0) {
      pauseSt.healNum = { value: 0, timer: 0, rosterIdx: pauseSt.invAllyTarget };
    } else {
      pauseSt.healNum = { value: 0, timer: 0 };
    }
    playSFX(SFX.SIGHT);
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    pauseSt.useSpellId = 0;
    saveSlotsToDB();
    return;
  }

  // Healing spells — roll the magic amount with the same formula spell-cast.js
  // and combatant-cast.js use, then apply via `applyMagicHeal` so the pause and
  // in-battle paths share one heal-clamp implementation. White magic uses MND,
  // black magic uses INT (matches spell-cast.js:_rollMagicAmount).
  const isWhite = spell.element === 'recovery';
  const stat = ps.stats ? (isWhite ? (ps.stats.mnd || 5) : (ps.stats.int || 5)) : 5;
  const atk = Math.floor(stat / 2) + spell.power;
  const amt = atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1));
  if (pauseSt.invAllyTarget >= 0) {
    const rp = rosterTargets[pauseSt.invAllyTarget];
    if (!rp) { playSFX(SFX.ERROR); return; }
    const heal = applyMagicHeal(rp, amt);
    pauseSt.healNum = { value: heal, timer: 0, rosterIdx: pauseSt.invAllyTarget, spellId };
  } else {
    const heal = applyMagicHeal(ps, amt);
    pauseSt.healNum = { value: heal, timer: 0, spellId };
  }
  playSFX(SFX.CURE);
  pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
  pauseSt.useSpellId = 0;
  saveSlotsToDB();
}

function _pauseInvZPress(entries) {
  if (pauseSt.heldItem === -1) {
    if (entries.length > 0 && entries[pauseSt.invScroll]) { pauseSt.heldItem = pauseSt.invScroll; playSFX(SFX.CONFIRM); }
    else playSFX(SFX.ERROR);
  } else if (pauseSt.heldItem === pauseSt.invScroll) {
    const [id] = entries[pauseSt.heldItem]; const item = ITEMS.get(Number(id));
    if (item && item.type === 'consumable') {
      playSFX(SFX.CONFIRM); pauseSt.heldItem = -1;
      pauseSt.state = 'inv-target'; pauseSt.timer = 0; pauseSt.useItemId = Number(id); pauseSt.invAllyTarget = -1;
    } else { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
  } else {
    if (entries[pauseSt.invScroll]) { pauseSt.heldItem = pauseSt.invScroll; playSFX(SFX.CONFIRM); }
    else { pauseSt.heldItem = -1; playSFX(SFX.ERROR); }
  }
}

function _pauseInputInventory() {
  if (pauseSt.state !== 'inventory') return false;
  if (pauseSt.menuMode === 'magic') return _pauseInputMagicList();
  const entries = Object.entries(playerInventory).filter(([,c]) => c > 0);
  const k = keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.invScroll < entries.length - 1) { pauseSt.invScroll++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.invScroll > 0) { pauseSt.invScroll--; playSFX(SFX.CURSOR); }
  }
  if (k['z'] || k['Z']) { k['z'] = false; k['Z'] = false; _pauseInvZPress(entries); }
  if (_xPressed()) {
    if (pauseSt.heldItem !== -1) { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); pauseSt.state = 'inv-items-out'; pauseSt.timer = 0; }
  }
  return true;
}

function _pauseInputMagicList() {
  const list = getCastableKnownSpells(ps.jobIdx, ps.knownSpells);
  const k = keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.magicCursor < list.length - 1) { pauseSt.magicCursor++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.magicCursor > 0) { pauseSt.magicCursor--; playSFX(SFX.CURSOR); }
  }
  if (_zPressed()) {
    const spellId = list[pauseSt.magicCursor];
    if (spellId == null) { playSFX(SFX.ERROR); return true; }
    const spell = SPELLS.get(spellId);
    if (!spell) { playSFX(SFX.ERROR); return true; }
    // Sight (0x36) is a map-reveal spell in NES canon; we don't have an
    // overworld minimap-reveal system yet, so block out-of-battle casting at
    // the menu level — no MP cost, no target picker, no fake heal.
    if (spell.target === 'sight') { playSFX(SFX.ERROR); return true; }
    if (ps.mp < getSpellMPCost(spellId)) { playSFX(SFX.ERROR); return true; }
    playSFX(SFX.CONFIRM);
    pauseSt.useSpellId = spellId;
    pauseSt.invAllyTarget = -1;   // start on player
    pauseSt.state = 'inv-target'; pauseSt.timer = 0;
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'inv-items-out'; pauseSt.timer = 0;
  }
  return true;
}

function _applyPauseItemUse(item, rosterTargets) {
  if (!item) { playSFX(SFX.ERROR); return; }
  const eff = item.effect || (item.type === 'consumable' ? 'heal' : null);

  // Cure status items (Antidote, Eye Drops, etc.) — only targets player outside battle.
  // Routes through `applyMagicCureStatus` so this matches the in-battle path.
  if (eff === 'cure_status') {
    const flag = STATUS_NAME_TO_FLAG[item.cures];
    if (flag) applyMagicCureStatus(ps, flag);
    const itemId = pauseSt.useItemId;
    removeItem(itemId); playSFX(SFX.CURE);
    pauseSt.healNum = { value: 0, timer: 0, itemId };
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    saveSlotsToDB();
    return;
  }

  if (eff !== 'heal' && eff !== 'full_heal' && eff !== 'restore_hp') { playSFX(SFX.ERROR); return; }
  const healPower = eff === 'full_heal' ? 9999 : (item.power || item.value || 50);
  const itemId = pauseSt.useItemId;
  if (pauseSt.invAllyTarget >= 0) {
    const rp = rosterTargets[pauseSt.invAllyTarget];
    if (!rp) { playSFX(SFX.ERROR); return; }
    const heal = applyMagicHeal(rp, healPower);
    removeItem(itemId); playSFX(SFX.CURE);
    pauseSt.healNum = { value: heal, timer: 0, rosterIdx: pauseSt.invAllyTarget, itemId };
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    saveSlotsToDB();
  } else {
    const heal = applyMagicHeal(ps, healPower);
    removeItem(itemId); playSFX(SFX.CURE);
    pauseSt.healNum = { value: heal, timer: 0, itemId };
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    saveSlotsToDB();
  }
}

function _pauseInputInvTarget() {
  if (pauseSt.state !== 'inv-target') return false;
  const rosterTargets = getRosterVisible();
  const k = keys;
  // Roster panel only renders 3 rows at a time. When the cursor moves past the
  // visible window we have to scroll inputSt.rosterScroll so the actual roster
  // panel scrolls in sync (otherwise the cursor walks off into empty space).
  const PAUSE_ROSTER_VISIBLE = 3;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.invAllyTarget < rosterTargets.length - 1) {
      pauseSt.invAllyTarget++;
      const visRow = pauseSt.invAllyTarget - inputSt.rosterScroll;
      if (visRow >= PAUSE_ROSTER_VISIBLE) inputSt.rosterScroll++;
      playSFX(SFX.CURSOR);
    }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.invAllyTarget > -1) {
      pauseSt.invAllyTarget--;
      if (pauseSt.invAllyTarget >= 0 && pauseSt.invAllyTarget < inputSt.rosterScroll) {
        inputSt.rosterScroll = pauseSt.invAllyTarget;
      }
      playSFX(SFX.CURSOR);
    }
  }
  if (_zPressed()) {
    if (pauseSt.useSpellId > 0) _applyPauseSpellUse(rosterTargets);
    else _applyPauseItemUse(ITEMS.get(pauseSt.useItemId), rosterTargets);
  }
  if (_xPressed()) {
    pauseSt.state = 'inventory'; pauseSt.timer = 0;
    pauseSt.heldItem = -1;
    pauseSt.useSpellId = 0;
    playSFX(SFX.CONFIRM);
  }
  return true;
}

function _enforceEquipRestrictions(jobIdx) {
  const slots = [-100, -101, -102, -103, -104];
  for (const eq of slots) {
    const id = getEquipSlotId(eq);
    if (id && !canJobEquip(jobIdx, id, ITEMS)) {
      setEquipSlotId(eq, 0);
      addItem(id, 1);
    }
  }
  recalcCombatStats();
  saveSlotsToDB();
}

function _equipBestMainSlots() {
  const SLOT_DEFS = [
    { eq: -100, type: 'hand', stat: 'atk' },
    { eq: -102, type: 'armor', subtype: 'helmet', stat: 'def' },
    { eq: -103, type: 'armor', subtype: 'body',   stat: 'def' },
    { eq: -104, type: 'armor', subtype: 'arms',   stat: 'def' },
  ];
  for (const sd of SLOT_DEFS) {
    const curId = getEquipSlotId(sd.eq); const curItem = ITEMS.get(curId);
    let bestId = curId, bestVal = curItem ? (curItem[sd.stat] || 0) : 0;
    for (const [idStr, count] of Object.entries(playerInventory)) {
      if (count <= 0) continue;
      const id = Number(idStr); const item = ITEMS.get(id); if (!item) continue;
      if (sd.type === 'hand' && !isHandEquippable(item)) continue;
      if (sd.type === 'armor' && (item.type !== 'armor' || item.subtype !== sd.subtype)) continue;
      if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
      const val = item[sd.stat] || 0; if (val > bestVal) { bestVal = val; bestId = id; }
    }
    if (bestId !== curId) {
      if (curId !== 0) addItem(curId, 1);
      if (bestId !== 0) { setEquipSlotId(sd.eq, bestId); removeItem(bestId); } else setEquipSlotId(sd.eq, 0);
    }
  }
}

function _equipBestLeftHand() {
  const curId = getEquipSlotId(-101); const curItem = ITEMS.get(curId);
  let bestWepId = 0, bestWepAtk = 0, bestShieldId = 0, bestShieldDef = 0;
  if (curItem?.type === 'weapon') { bestWepAtk = curItem.atk || 0; bestWepId = curId; }
  else if (curItem?.subtype === 'shield') { bestShieldDef = curItem.def || 0; bestShieldId = curId; }
  for (const [idStr, count] of Object.entries(playerInventory)) {
    if (count <= 0) continue;
    const id = Number(idStr); const item = ITEMS.get(id);
    if (!item || !isHandEquippable(item)) continue;
    if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
    if (item.type === 'weapon') { const v = item.atk || 0; if (v > bestWepAtk) { bestWepAtk = v; bestWepId = id; } }
    else if (item.subtype === 'shield') { const v = item.def || 0; if (v > bestShieldDef) { bestShieldDef = v; bestShieldId = id; } }
  }
  const bestId = bestShieldId !== 0 ? bestShieldId : bestWepId;
  if (bestId !== curId) {
    if (curId !== 0) addItem(curId, 1);
    if (bestId !== 0) { setEquipSlotId(-101, bestId); removeItem(bestId); } else setEquipSlotId(-101, 0);
  }
}

function _equipOptimum() {
  _equipBestMainSlots();
  _equipBestLeftHand();
  recalcCombatStats();
  saveSlotsToDB();
  playSFX(SFX.CONFIRM);
}

function _pauseInputEquip() {
  if (pauseSt.state !== 'equip') return false;
  const k = keys;
  if (pauseSt.eqCursor < 5) {
    if (k['ArrowDown'])  { k['ArrowDown'] = false;  pauseSt.eqCursor = (pauseSt.eqCursor + 1) % 5; playSFX(SFX.CURSOR); }
    if (k['ArrowUp'])    { k['ArrowUp'] = false;    pauseSt.eqCursor = (pauseSt.eqCursor + 4) % 5; playSFX(SFX.CURSOR); }
    if (k['ArrowRight']) { k['ArrowRight'] = false;  pauseSt._lastEqSlot = pauseSt.eqCursor; pauseSt.eqCursor = 5; playSFX(SFX.CURSOR); }
  } else {
    if (k['ArrowLeft'])  { k['ArrowLeft'] = false;   pauseSt.eqCursor = pauseSt._lastEqSlot || 0; playSFX(SFX.CURSOR); }
  }
  if (_zPressed()) {
    if (pauseSt.eqCursor === 5) {
      _equipOptimum();
    } else {
      playSFX(SFX.CONFIRM);
      pauseSt.eqSlotIdx = -100 - pauseSt.eqCursor;
      const isWeaponSlot = pauseSt.eqSlotIdx >= -101;
      const slotSubtype = EQUIP_SLOT_SUBTYPE[String(pauseSt.eqSlotIdx)];
      pauseSt.eqItemList = [];
      const currentId = getEquipSlotId(pauseSt.eqSlotIdx);
      if (currentId !== 0) pauseSt.eqItemList.push({ id: 0, label: 'remove' });
      for (const [idStr, count] of Object.entries(playerInventory)) {
        if (count <= 0) continue;
        const id = Number(idStr);
        const item = ITEMS.get(id);
        if (!item) continue;
        if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
        if (isWeaponSlot && isHandEquippable(item)) pauseSt.eqItemList.push({ id, count });
        else if (!isWeaponSlot && item.type === 'armor' && item.subtype === slotSubtype) pauseSt.eqItemList.push({ id, count });
      }
      pauseSt.eqItemCursor = 0;
      pauseSt.state = 'eq-items-in'; pauseSt.timer = 0;
    }
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'eq-slots-out'; pauseSt.timer = 0;
  }
  return true;
}

function _pauseInputEquipItemSelect() {
  if (pauseSt.state !== 'eq-item-select') return false;
  const k = keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; if (pauseSt.eqItemCursor < pauseSt.eqItemList.length - 1) { pauseSt.eqItemCursor++; playSFX(SFX.CURSOR); } }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   if (pauseSt.eqItemCursor > 0) { pauseSt.eqItemCursor--; playSFX(SFX.CURSOR); } }
  if (_zPressed()) {
    const pick = pauseSt.eqItemList[pauseSt.eqItemCursor];
    if (pick) {
      const oldId = getEquipSlotId(pauseSt.eqSlotIdx);
      if (pick.label === 'remove') {
        setEquipSlotId(pauseSt.eqSlotIdx, 0);
        if (oldId !== 0) addItem(oldId, 1);
      } else {
        setEquipSlotId(pauseSt.eqSlotIdx, pick.id);
        removeItem(pick.id);
        if (oldId !== 0) addItem(oldId, 1);
      }
      recalcCombatStats();
      saveSlotsToDB();
      playSFX(SFX.CONFIRM);
    }
    pauseSt.state = 'eq-items-out'; pauseSt.timer = 0;
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'eq-items-out'; pauseSt.timer = 0;
  }
  return true;
}

function _pauseInputStats() {
  if (pauseSt.state !== 'stats') return false;
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'stats-out'; pauseSt.timer = 0; }
  return true;
}

function _pauseInputJob() {
  if (pauseSt.state !== 'job') return false;
  const k = keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.jobCursor = (pauseSt.jobCursor + 1) % pauseSt.jobList.length; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.jobCursor = (pauseSt.jobCursor + pauseSt.jobList.length - 1) % pauseSt.jobList.length; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    const newJobIdx = pauseSt.jobList[pauseSt.jobCursor];
    if (newJobIdx === ps.jobIdx) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'job-out'; pauseSt.timer = 0;
    } else {
      const cost = jobSwitchCost(newJobIdx);
      if (ps.cp >= cost) {
        ps.cp -= cost;
        changeJob(newJobIdx);
        _enforceEquipRestrictions(newJobIdx);
        swapBattleSprites(newJobIdx);
        playSFX(SFX.CONFIRM);
        pauseSt.state = 'job-out'; pauseSt.timer = 0;
      } else {
        playSFX(SFX.ERROR);
      }
    }
  }
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'job-out'; pauseSt.timer = 0; }
  return true;
}

function _pauseInputOptions() {
  if (pauseSt.state !== 'options') return false;
  const k = keys;
  if (_zPressed()) {
    if (pauseSt.optCursor === 0) { _toggleCrt(); playSFX(SFX.CONFIRM); }
  }
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'options-out'; pauseSt.timer = 0; }
  return true;
}

export function handlePauseInput() {
  if (_pauseInputOpenClose()) return true;
  if (_pauseInputMainMenu()) return true;
  if (_pauseInputInventory()) return true;
  if (_pauseInputInvTarget()) return true;
  if (pauseSt.state === 'inv-heal') return true;
  if (pauseSt.state.startsWith('inv-')) return true;
  if (_pauseInputEquip()) return true;
  if (_pauseInputEquipItemSelect()) return true;
  if (pauseSt.state.startsWith('eq-')) return true;
  if (_pauseInputStats()) return true;
  if (pauseSt.state.startsWith('stats-')) return true;
  if (_pauseInputJob()) return true;
  if (pauseSt.state.startsWith('job-')) return true;
  if (_pauseInputOptions()) return true;
  if (pauseSt.state.startsWith('options-')) return true;
  if (pauseSt.state !== 'none') return true;
  return false;
}
