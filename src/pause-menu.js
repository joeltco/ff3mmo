// pause-menu.js — pause menu state, transitions, and rendering

import { drawText, measureText } from './font-renderer.js';
import { ps, getEquipSlotId, setEquipSlotId, jobSwitchCost, getJobLevel, getJobLevelStatBonus,
         recalcCombatStats, changeJob, EQUIP_SLOT_SUBTYPE } from './player-stats.js';
import { JOBS, JOB_NAMES_SHRINES, canJobEquip } from './data/jobs.js';
import { _makeFadedPal, nesColorFade } from './palette.js';
import { _nameToBytes, _nesNameToString } from './text-utils.js';
import { getItemNameClean, getItemNameShrines, getSpellNameClean, getSpellNameShrines } from './text-decoder.js';
import { SPELLS, getSpellMPCost, getCastableKnownSpells, canLearnSpell } from './data/spells.js';
import { stopFF1Music, resumeMusic, playFF1Track, FF1_TRACKS, playSFX, SFX, pauseMusic, applyMusicVolume, applySfxVolume } from './music.js';
import { getSetting, setSetting, VOL_MAX, BATTLE_SPEED_LABELS } from './settings.js';
import { PAUSE_ITEMS } from './data/strings.js';
import { selectCursor, saveSlots, saveSlotsToDB } from './save-state.js';
import { ui } from './ui-state.js';
import { inputSt, keys } from './input-handler.js';
import { drawBorderedBox, clipToViewport, drawCursorFaded } from './hud-drawing.js';
import {
  playerInventory, addItem, removeItem, getItemCount,
  buildItemSelectList, swapInventorySlots, INV_SLOTS, INV_CAP,
} from './inventory.js';
import { getTrashCanvas } from './data/inventory-icons.js';
import { showMsgBoxPrompt } from './message-box.js';
import { battleSt } from './battle-state.js';
import { transSt } from './transitions.js';
import { mapSt } from './map-state.js';
import { msgState, showMsgBox } from './message-box.js';
import { ITEMS, isHandEquippable, ITEM_NAMES_SHRINES } from './data/items.js';
import { sendNetGiveItem, setNetGiveItemHandler } from './net.js';
import { addChatMessage } from './chat.js';
import { hudSt } from './hud-state.js';
import { swapBattleSprites } from './job-sprites.js';
import { jobBattlePalette, PALETTE_SLOTS } from './data/players.js';
import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
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
  magicScroll:  0,       // first visible row in magic list (Sage can know 15+)
  useSpellId:   0,       // spell ID stashed between magic-list Z press and inv-target confirm (0 = none)
  deleteMode:   false,   // SELECT-toggled inventory delete mode (trash icon active). v1.7.599.
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
    pauseSt.deleteMode = false;   // exit Items tab → drop delete mode (v1.7.599)
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
  // Position-ordered list — buildItemSelectList pads with nulls to INV_SLOTS
  // so empty slots are reachable as drag/swap targets. v1.7.600.
  const slots = buildItemSelectList();
  const maxVisible = Math.min(INV_SLOTS, Math.floor((HUD_VIEW_H - 16) / 14));
  const startIdx = Math.max(0, Math.min(pauseSt.invScroll, Math.max(0, INV_SLOTS - maxVisible)));
  const countRx = px + HUD_VIEW_W - 16;
  for (let i = 0; i < maxVisible && startIdx + i < INV_SLOTS; i++) {
    const slot = slots[startIdx + i];
    const iy = finalY + 12 + i * 14;
    if (slot) {
      const nameBytes = getItemNameShrines(slot.id);
      const countBytes = _nameToBytes(String(slot.count));
      drawText(ctx, px + 24, iy, nameBytes, fadedPal);
      drawText(ctx, countRx - measureText(countBytes), iy, countBytes, fadedPal);
    }
    if (pauseSt.heldItem >= 0 && startIdx + i === pauseSt.heldItem && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal')
      drawCursorFaded(px + 8, iy - 4, fadeStep);
    if (startIdx + i === pauseSt.invScroll && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal') {
      const activeX = pauseSt.heldItem >= 0 ? px + 4 : px + 8;
      drawCursorFaded(activeX, iy - 4, fadeStep);
    }
  }

  // v1.7.603: trash icon is a fixed mode-indicator in the panel's
  // bottom-right corner — only visible while delete mode is active. Was
  // riding the cursor (v1.7.602), which moved with scroll and wasn't
  // readable as a "mode is on" signal. 16×16 sprite with 4px margin from
  // the right/bottom edges sits in the clear space below the 8 item rows
  // (last row ends ~y=150, panel bottom = 176). Fade rides globalAlpha
  // since the trash is a baked canvas (no palette to step through
  // nesColorFade like text does).
  if (pauseSt.deleteMode) {
    const tx = px + HUD_VIEW_W - 16 - 4;
    const ty = finalY + HUD_VIEW_H - 16 - 4;
    const fadeAlpha = Math.max(0, 1 - fadeStep / PAUSE_TEXT_STEPS);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * fadeAlpha;
    ctx.drawImage(getTrashCanvas(), tx, ty);
    ctx.globalAlpha = prevAlpha;
  }
}

function _drawPauseMagicList(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const fadeStep = _pauseFadeStep('inv-items-in', 'inv-items-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const list = getCastableKnownSpells(ps.jobIdx, ps.knownSpells);
  const costRightX = px + HUD_VIEW_W - 16;
  // v1.7.447 — empty-state mirror of the battle panel's "No spells". A
  // school-mismatched or freshly-debugged mage opens the menu and sees this
  // instead of a blank list. X-backs out cleanly via the existing input path.
  if (list.length === 0) {
    drawText(ctx, px + 8, finalY + 12, _nameToBytes('No spells'), fadedPal);
    return;
  }
  // Mirror inventory's scroll math — Sage/dual-school jobs can know more
  // spells than the panel fits at 14 px per row.
  const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
  const startIdx = Math.max(0, Math.min(pauseSt.magicScroll, Math.max(0, list.length - maxVisible)));
  for (let i = 0; i < maxVisible && startIdx + i < list.length; i++) {
    const id = list[startIdx + i];
    const name = getSpellNameShrines(id);
    const iy = finalY + 12 + i * 14;
    drawText(ctx, px + 24, iy, name, fadedPal);
    const cost = getSpellMPCost(id);
    if (cost > 0) {
      const costBytes = _nameToBytes(String(cost));
      drawText(ctx, costRightX - measureText(costBytes), iy, costBytes, fadedPal);
    }
    if (startIdx + i === pauseSt.magicCursor && pauseSt.state !== 'inv-target' && pauseSt.state !== 'inv-heal') {
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
    new Uint8Array([0x9B,0xC1,0xFF,0x91,0xA4,0xB1,0xA7]), // "R. Hand"
    new Uint8Array([0x95,0xC1,0xFF,0x91,0xA4,0xB1,0xA7]), // "L. Hand"
    new Uint8Array([0x91,0xA8,0xA4,0xA7]),                 // "Head"
    new Uint8Array([0x8B,0xB2,0xA7,0xBC]),                 // "Body"
    new Uint8Array([0x8A,0xB5,0xB0,0xB6]),                 // "Arms"
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
  const optText = new Uint8Array([0x98,0xB3,0xB7]); // "Opt"
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
        drawText(ctx, listX + 16, iy, new Uint8Array([0x9B,0xA8,0xB0,0xB2,0xB9,0xA8]), fadedPal);
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
  statRow('Next', s.expToNext >= 0xFFFFFF ? 'MAX' : String(s.expToNext));
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
const OPT_ON  = new Uint8Array([0x98,0xB1]); // "On"
const OPT_OFF = new Uint8Array([0x98,0xA9,0xA9]); // "Off"

function _isCrtOn() {
  const el = document.getElementById('canvas-wrapper');
  return el && el.classList.contains('crt');
}

function _toggleCrt() {
  const el = document.getElementById('canvas-wrapper');
  if (el) el.classList.toggle('crt');
}

const OPT_ROW_H = 16;       // vertical pitch between option rows
const OPT_ROW_COUNT = 5;    // Color, Music, SFX, Battle, CRT

// Volume bar — VOL_MAX cells, `level` filled. Drawn right-aligned at valRx.
function _drawVolBar(ctx, valRx, y, level, fadeStep) {
  const CELL_W = 4, GAP = 1, H = 7;
  const totalW = VOL_MAX * (CELL_W + GAP) - GAP;
  const x0 = valRx - totalW;
  let onCol = 0x30, offCol = 0x0F;          // white filled, dark empty
  for (let s = 0; s < fadeStep; s++) { onCol = nesColorFade(onCol); offCol = nesColorFade(offCol); }
  const on = NES_SYSTEM_PALETTE[onCol] || [255, 255, 255];
  const off = NES_SYSTEM_PALETTE[offCol] || [60, 60, 60];
  for (let i = 0; i < VOL_MAX; i++) {
    const c = i < level ? on : off;
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(x0 + i * (CELL_W + GAP), y, CELL_W, H);
  }
}

function _drawPauseOptions(ctx) {
  const px = HUD_VIEW_X, finalY = HUD_VIEW_Y;
  const show = pauseSt.state === 'options-in' || pauseSt.state === 'options' || pauseSt.state === 'options-out';
  if (!show) return;
  const fadeStep = _pauseFadeStep('options-in', 'options-out');
  const fadedPal = _makeFadedPal(fadeStep);
  const tx = px + 24;
  const valRx = px + HUD_VIEW_W - 16;
  const y0 = finalY + 12;

  // Row 0 — Color: outfit swatch + slot number (1-8)
  drawText(ctx, tx, y0, _nameToBytes('COLOR'), fadedPal);
  const slotBytes = _nameToBytes(String(ps.palIdx + 1));
  drawText(ctx, valRx - slotBytes.length * 8, y0, slotBytes, fadedPal);
  let swatchColor = jobBattlePalette(ps.jobIdx, ps.palIdx)[3];
  for (let s = 0; s < fadeStep; s++) swatchColor = nesColorFade(swatchColor);
  const rgb = NES_SYSTEM_PALETTE[swatchColor] || [0, 0, 0];
  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.fillRect(valRx - slotBytes.length * 8 - 14, y0, 8, 8);

  // Row 1 — Music volume bar
  const y1 = y0 + OPT_ROW_H;
  drawText(ctx, tx, y1, _nameToBytes('MUSIC'), fadedPal);
  _drawVolBar(ctx, valRx, y1, getSetting('musicVol'), fadeStep);

  // Row 2 — SFX volume bar
  const y2 = y0 + OPT_ROW_H * 2;
  drawText(ctx, tx, y2, _nameToBytes('SFX'), fadedPal);
  _drawVolBar(ctx, valRx, y2, getSetting('sfxVol'), fadeStep);

  // Row 3 — Battle speed
  const y3 = y0 + OPT_ROW_H * 3;
  drawText(ctx, tx, y3, _nameToBytes('BATTLE'), fadedPal);
  const bsBytes = _nameToBytes(BATTLE_SPEED_LABELS[getSetting('battleSpeed')] || 'Norm');
  drawText(ctx, valRx - bsBytes.length * 8, y3, bsBytes, fadedPal);

  // Row 4 — CRT toggle
  const y4 = y0 + OPT_ROW_H * 4;
  drawText(ctx, tx, y4, OPT_CRT_LABEL, fadedPal);
  const valBytes = _isCrtOn() ? OPT_ON : OPT_OFF;
  drawText(ctx, valRx - valBytes.length * 8, y4, valBytes, fadedPal);

  if (drawCursorFaded) {
    drawCursorFaded(px + 8, (y0 - 4) + pauseSt.optCursor * OPT_ROW_H, fadeStep);
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
// v1.7.447 — open even with an empty castable list. Render shows "No spells"
// (see _drawPauseMagicList) so the user gets visible feedback that the submenu
// opened but they haven't learned any school-matching spells yet.
function _pauseInputMagicZ() {
  playSFX(SFX.CONFIRM);
  pauseSt.menuMode = 'magic';
  pauseSt.magicCursor = 0;
  pauseSt.magicScroll = 0;
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

// Z press in the Items tab. Three branches:
//   1. No item held → pick up the item under the cursor. Picking an empty
//      slot beeps an error (nothing to grab).
//   2. Held + same row Z → activate the held item (consumable / scroll).
//   3. Held + different row Z → SWAP the two slot positions (or MOVE into
//      an empty slot). This is the position-rearrange path the user wants;
//      pre-v1.7.600 it just re-picked-up the new slot and the held item
//      stayed put.
function _pauseInvZPress() {
  const slots = buildItemSelectList();
  if (pauseSt.heldItem === -1) {
    if (slots[pauseSt.invScroll]) { pauseSt.heldItem = pauseSt.invScroll; playSFX(SFX.CONFIRM); }
    else playSFX(SFX.ERROR);
    return;
  }
  if (pauseSt.heldItem === pauseSt.invScroll) {
    const slot = slots[pauseSt.heldItem];
    if (!slot) { pauseSt.heldItem = -1; playSFX(SFX.ERROR); return; }
    const item = ITEMS.get(slot.id);
    if (item && item.type === 'consumable') {
      playSFX(SFX.CONFIRM); pauseSt.heldItem = -1;
      pauseSt.state = 'inv-target'; pauseSt.timer = 0; pauseSt.useItemId = slot.id; pauseSt.invAllyTarget = -1;
    } else if (item && item.type === 'scroll') {
      pauseSt.heldItem = -1;
      _applyScrollLearn(slot.id, item);
    } else { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
    return;
  }
  // Cross-row Z press — swap (or move-to-empty).
  if (swapInventorySlots(pauseSt.heldItem, pauseSt.invScroll)) {
    playSFX(SFX.CONFIRM);
    saveSlotsToDB();
  } else {
    playSFX(SFX.ERROR);
  }
  pauseSt.heldItem = -1;
}

// Scroll-use flow. Already-known scrolls refuse (the player can trade
// them instead — see [[ff3mmo-shops]] catalog for buy-back). Wrong job
// also refuses (school-gated via canLearnSpell). On success: spell ID
// joins ps.knownSpells permanently (carries across future job changes)
// and the scroll is consumed.
function _applyScrollLearn(itemId, item) {
  const spellId = item.learnedSpell;
  if (spellId == null) { playSFX(SFX.ERROR); return; }
  if (!ps.knownSpells) ps.knownSpells = [];
  if (ps.knownSpells.includes(spellId)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes('Already known!'));
    return;
  }
  if (!canLearnSpell(ps.jobIdx, spellId)) {
    playSFX(SFX.ERROR);
    showMsgBox(_nameToBytes("Can't learn that!"));
    return;
  }
  ps.knownSpells.push(spellId);
  removeItem(itemId);
  playSFX(SFX.TREASURE);
  saveSlotsToDB();
  showMsgBox(_scrollLearnedMsg(spellId));
}

function _scrollLearnedMsg(spellId) {
  const prefix = _nameToBytes('Learned ');
  const name   = getSpellNameClean(spellId);
  const out    = new Uint8Array(prefix.length + name.length + 1);
  out.set(prefix, 0);
  out.set(name, prefix.length);
  out[prefix.length + name.length] = 0xC4; // !
  return out;
}

function _pauseInputInventory() {
  if (pauseSt.state !== 'inventory') return false;
  if (pauseSt.menuMode === 'magic') return _pauseInputMagicList();
  const k = keys;
  // Navigate the FULL bag (incl. empty trailing slots) so a held item can
  // be moved into an empty space, not just swapped with another item. The
  // active row caps at INV_CAP-1 (8 slots total). v1.7.600.
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.invScroll < INV_CAP - 1) { pauseSt.invScroll++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.invScroll > 0) { pauseSt.invScroll--; playSFX(SFX.CURSOR); }
  }
  // SELECT toggles delete mode — trash icon next to cursor, Z deletes (with
  // confirm) instead of using/equipping. Dropping a held item clears it
  // first so we can't enter delete mode mid-pickup. v1.7.599.
  if (k['s'] || k['S']) {
    k['s'] = false; k['S'] = false;
    pauseSt.heldItem = -1;
    pauseSt.deleteMode = !pauseSt.deleteMode;
    playSFX(SFX.CONFIRM);
  }
  if (k['z'] || k['Z']) {
    k['z'] = false; k['Z'] = false;
    if (pauseSt.deleteMode) _pauseInvDeletePress();
    else _pauseInvZPress();
  }
  if (_xPressed()) {
    if (pauseSt.deleteMode) { pauseSt.deleteMode = false; playSFX(SFX.CONFIRM); }
    else if (pauseSt.heldItem !== -1) { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); pauseSt.state = 'inv-items-out'; pauseSt.timer = 0; }
  }
  return true;
}

// Delete-mode Z press — confirm box, then drop ALL of the held stack at
// invScroll. Confirmed deletion is intentional: this is a destructive
// action ("Bag full, get rid of stuff"); confirm + sound makes accidental
// taps unlikely. v1.7.599.
function _pauseInvDeletePress() {
  const slot = buildItemSelectList()[pauseSt.invScroll];
  if (!slot) { playSFX(SFX.ERROR); return; }
  const itemId = slot.id;
  const itemName = _nesNameToString(getItemNameClean(itemId));
  playSFX(SFX.CONFIRM);
  showMsgBoxPrompt(
    _nameToBytes('Delete ' + itemName + '? Z=ok X=no'),
    () => {
      removeItem(itemId, getItemCount(itemId));
      // Cursor stays where it is — the slot becomes an empty position the
      // user can swap into. v1.7.600.
      saveSlotsToDB();
      playSFX(SFX.CONFIRM);
    },
    () => { /* no-op */ },
  );
}

function _pauseInputMagicList() {
  const list = getCastableKnownSpells(ps.jobIdx, ps.knownSpells);
  const k = keys;
  const maxVisible = Math.floor((HUD_VIEW_H - 16) / 14);
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.magicCursor < list.length - 1) {
      pauseSt.magicCursor++;
      if (pauseSt.magicCursor - pauseSt.magicScroll >= maxVisible) pauseSt.magicScroll = pauseSt.magicCursor - maxVisible + 1;
      playSFX(SFX.CURSOR);
    }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.magicCursor > 0) {
      pauseSt.magicCursor--;
      if (pauseSt.magicCursor < pauseSt.magicScroll) pauseSt.magicScroll = pauseSt.magicCursor;
      playSFX(SFX.CURSOR);
    }
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

  // Cure status items (Antidote, Eye Drops, etc.) — applies to self OR roster
  // target if one is picked. Routes through `applyMagicCureStatus` so this
  // matches the in-battle path. Real-player target also wire-relays the cure.
  if (eff === 'cure_status') {
    const flag = STATUS_NAME_TO_FLAG[item.cures];
    const itemId = pauseSt.useItemId;
    if (pauseSt.invAllyTarget >= 0) {
      const rp = rosterTargets[pauseSt.invAllyTarget];
      if (!rp) { playSFX(SFX.ERROR); return; }
      if (flag && rp.status) applyMagicCureStatus(rp, flag);
      removeItem(itemId); playSFX(SFX.CURE);
      if (rp.isReal && rp.userId) sendNetGiveItem(rp.userId, itemId);
      pauseSt.healNum = { value: 0, timer: 0, rosterIdx: pauseSt.invAllyTarget, itemId };
    } else {
      if (flag) applyMagicCureStatus(ps, flag);
      removeItem(itemId); playSFX(SFX.CURE);
      pauseSt.healNum = { value: 0, timer: 0, itemId };
    }
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
    // Wire-give: real player target → relay so their client also applies the
    // heal to their own `ps` (the local `rp` mutation only touches our roster
    // snapshot; without this, the partner's actual HP stays the same on their
    // screen). v1.7.416.
    if (rp.isReal && rp.userId) sendNetGiveItem(rp.userId, itemId);
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
      addItem(id, 1, { bypass: true });   // never destroy gear on job-change unequip
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
      if (curId !== 0) addItem(curId, 1, { bypass: true });
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
    if (curId !== 0) addItem(curId, 1, { bypass: true });
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
        if (oldId !== 0) addItem(oldId, 1, { bypass: true });
      } else {
        setEquipSlotId(pauseSt.eqSlotIdx, pick.id);
        removeItem(pick.id);
        if (oldId !== 0) addItem(oldId, 1, { bypass: true });
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

function _changePlayerColor(dir) {
  ps.palIdx = (ps.palIdx + dir + PALETTE_SLOTS) % PALETTE_SLOTS;
  swapBattleSprites(ps.jobIdx, ps.palIdx);   // live repaint: walk + battle/HUD
  playSFX(SFX.CURSOR);
}

function _changeVolume(key, dir, apply) {
  const next = Math.max(0, Math.min(VOL_MAX, getSetting(key) + dir));
  if (next === getSetting(key)) return;     // already at the rail — no SFX double-blip
  setSetting(key, next);
  apply();                                  // live: re-read setting → master gain
  playSFX(SFX.CURSOR);                       // also lets the player hear the new SFX level
}

function _changeBattleSpeed(dir) {
  const next = Math.max(0, Math.min(2, getSetting('battleSpeed') + dir));
  if (next === getSetting('battleSpeed')) return;
  setSetting('battleSpeed', next);
  playSFX(SFX.CURSOR);
}

function _pauseInputOptions() {
  if (pauseSt.state !== 'options') return false;
  const k = keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.optCursor = (pauseSt.optCursor + 1) % OPT_ROW_COUNT; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.optCursor = (pauseSt.optCursor + OPT_ROW_COUNT - 1) % OPT_ROW_COUNT; playSFX(SFX.CURSOR); }
  const left = k['ArrowLeft'], right = k['ArrowRight'];
  if (pauseSt.optCursor === 0) {           // Color — left/right cycles slots; Z cycles forward
    if (left)  { k['ArrowLeft'] = false;  _changePlayerColor(-1); }
    if (right) { k['ArrowRight'] = false; _changePlayerColor(1); }
    if (_zPressed()) _changePlayerColor(1);
  } else if (pauseSt.optCursor === 1) {    // Music volume
    if (left)  { k['ArrowLeft'] = false;  _changeVolume('musicVol', -1, applyMusicVolume); }
    if (right) { k['ArrowRight'] = false; _changeVolume('musicVol', 1, applyMusicVolume); }
  } else if (pauseSt.optCursor === 2) {    // SFX volume
    if (left)  { k['ArrowLeft'] = false;  _changeVolume('sfxVol', -1, applySfxVolume); }
    if (right) { k['ArrowRight'] = false; _changeVolume('sfxVol', 1, applySfxVolume); }
  } else if (pauseSt.optCursor === 3) {    // Battle speed (Slow/Norm/Fast)
    if (left)  { k['ArrowLeft'] = false;  _changeBattleSpeed(-1); }
    if (right) { k['ArrowRight'] = false; _changeBattleSpeed(1); }
  } else {                                  // CRT — either direction or Z toggles
    if (left || right) { k['ArrowLeft'] = false; k['ArrowRight'] = false; _toggleCrt(); playSFX(SFX.CONFIRM); }
    if (_zPressed()) { _toggleCrt(); playSFX(SFX.CONFIRM); }
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'options-out'; pauseSt.timer = 0;
    saveSlotsToDB();   // persist palIdx (slot bake + server POST); profile poll rebroadcasts
  }
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

// Wire-give receiver — partner used a heal / cure item on us from their pause
// menu. Mirror the local `_applyPauseItemUse` apply path on our `ps` so HP /
// status reflects what the sender just spent the item on. Chat-only feedback
// (no msgbox interrupt) so the receiver doesn't get yanked out of whatever
// they're doing; HUD HP bar already animates the change. The next poll-loop
// tick fires the `update` wire diff so every other player's roster row
// transitions out of the low-HP kneel pose. v1.7.416.
setNetGiveItemHandler((msg) => {
  if (!msg || !msg.itemId) return;
  const item = ITEMS.get(msg.itemId);
  if (!item) return;
  const eff = item.effect || (item.type === 'consumable' ? 'heal' : null);
  let applied = false;
  if (eff === 'cure_status') {
    const flag = STATUS_NAME_TO_FLAG[item.cures];
    if (flag && ps.status) { applyMagicCureStatus(ps, flag); applied = true; }
  } else if (eff === 'heal' || eff === 'full_heal' || eff === 'restore_hp') {
    const healPower = eff === 'full_heal' ? 9999 : (item.power || item.value || 50);
    applyMagicHeal(ps, healPower);
    applied = true;
  }
  if (!applied) return;
  playSFX(SFX.CURE);
  // 550 ms heal-sparkle on the player portrait — same duration as the
  // pause-menu inv-heal timer so the visual cadence matches the sender side.
  hudSt.giveItemHealTimer = BATTLE_DMG_SHOW_MS;
  const itemName = ITEM_NAMES_SHRINES.get(msg.itemId) || 'an item';
  const fromName = msg.fromName || 'Someone';
  addChatMessage('* ' + fromName + ' sent you ' + itemName, 'system');
  saveSlotsToDB();
});
