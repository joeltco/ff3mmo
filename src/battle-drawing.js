// Battle drawing functions — extracted from game.js (pure rendering, no state mutation except critFlashTimer)

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_TEXT_STEPS } from './battle-state.js';
import { drawText } from './font-renderer.js';
import { _makeFadedPal } from './palette.js';
import { _dmgBounceY } from './data/animation-tables.js';
import { DMG_NUM_PAL, HEAL_NUM_PAL, drawBattleNum as _drawBattleNumCtx, drawDmgPopup } from './damage-numbers.js';
import { getBossBattleCanvas } from './boss-sprites.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { encounterGridLayout, pvpEnemyCellCenterLocal } from './battle-grid.js';
import { drawEncounterBox, drawBossSpriteBox } from './battle-draw-encounter.js';
import { SPELLS } from './data/spells.js';
import { PLAYER_PALETTES, MONK_PALETTES, BLACK_MAGE_PALETTES, RED_MAGE_PALETTES } from './data/players.js';

export function _jobPalette(jobIdx, palIdx) {
  const pool = jobIdx === 2 ? MONK_PALETTES
             : jobIdx === 4 ? BLACK_MAGE_PALETTES
             : jobIdx === 5 ? RED_MAGE_PALETTES
             : PLAYER_PALETTES;
  return pool[palIdx] || pool[0];
}

import { _nameToBytes } from './text-utils.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { bsc } from './battle-sprite-cache.js';
import { drawSpellThrow } from './combatant-cast.js';
import { drawBattleMenu, drawVictoryBox } from './battle-draw-menu.js';
import { drawBattleAllies } from './battle-draw-allies.js';
import { drawBattlePortrait, drawBattleCritFlash, drawBattleStrobeFlash } from './battle-draw-player.js';
import { getSpellAnim, getSpellAnimForItem, getSpellAnimFrame } from './spell-anim.js';
import { getProjectileTile } from './projectile-anim.js';
import { getEnemyDmgNum, getPlayerDamageNum, getPlayerHealNum, getEnemyHealNum,
         getSwDmgNums } from './damage-numbers.js';
import { getBattleMsgCurrent, getBattleMsgTimer, computeMsgTimings,
         MSG_FADE_IN_MS, MSG_FADE_OUT_MS,
         MSG_STRIP_X, MSG_STRIP_Y, MSG_STRIP_W,
         MSG_SCROLL_PAUSE_MS, MSG_SCROLL_SPEED_PX_MS } from './battle-msg.js';
// (weapon canvas selection moved to combatant-pose.js — pickAttackWeaponSpec handles all blade/fist getters)
import { clipToViewport, grayViewport } from './hud-drawing.js';
import { ui } from './ui-state.js';
import { isVictoryBattleState as _isVictoryBattleState } from './battle-update.js';

function _cursorTileCanvas() { return ui.cursorTileCanvas; }

const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const HUD_RIGHT_X = 144, HUD_RIGHT_W = 112;
const CANVAS_W = 256;
const ROSTER_ROW_H = 32;

// (Ally portrait pose map moved to combatant-pose.js — `pickCombatantBody('ally', ...)`
//  is the single source of truth for both ally portraits and opp full-bodies as of v1.7.161.)
// BATTLE_TEXT_STEPS imported from battle-state.js (single source, v1.7.217 dedup).
const BATTLE_FLASH_FRAME_MS = 16.67;
const BOSS_PREFLASH_MS = 133;
const BOSS_BLOCK_SIZE = 16;
const BOSS_BLOCK_COLS = 3;
const BOSS_BLOCKS = 9;
const BOSS_DISSOLVE_STEPS = 8;
const BOSS_DISSOLVE_FRAME_MS = 16.67;
const MONSTER_SLIDE_MS = 267;
// SLASH_FRAME_MS / SLASH_FRAMES imported from slash-effects.js (single source).
// Local copy of SLASH_FRAMES was dead pre-v1.7.217 — removed.
const DEFEND_SPARKLE_FRAME_MS = 133;


function drawSWExplosion() {
  // PVP opponent South Wind — explosion centered on current target (player or ally)
  if (!pvpSt.isPVPBattle || battleSt.battleState !== 'pvp-opp-sw-hit' || battleSt.battleTimer >= 400) return;
  if (!bsc.swPhaseCanvases.length) return;
  const phase = Math.min(2, Math.floor(battleSt.battleTimer / 133));
  const canvas = bsc.swPhaseCanvases[phase];
  if (!canvas) return;
  const targets = pvpSt._oppSWTargets;
  const tidx = targets ? targets[pvpSt._oppSWHitIdx] : -1;
  let cx, cy;
  if (tidx === -1) {
    cx = HUD_RIGHT_X + 8 + 8;
    cy = HUD_VIEW_Y + 8 + 12;
  } else {
    const panelTop = HUD_VIEW_Y + 32;
    cx = HUD_RIGHT_X + 8 + 8;
    cy = panelTop + tidx * ROSTER_ROW_H + 8 + 8;
  }
  const half = canvas.width / 2;
  ui.ctx.save();
  ui.ctx.beginPath(); ui.ctx.rect(0, HUD_VIEW_Y, CANVAS_W, HUD_VIEW_H); ui.ctx.clip();
  ui.ctx.imageSmoothingEnabled = false;
  ui.ctx.drawImage(canvas, cx - half, cy - half);
  ui.ctx.restore();
}

function drawSWDamageNumbers() {
  // No state gate — swDmgNums is per-target with its own timer (auto-clears at
  // SW_DMG_SHOW_MS), so it should render whenever entries exist. Originally
  // gated on magic-hit/ally-magic-hit because those were the only writers;
  // poison ticks now route here too (battle-turn.js _applyEndOfRoundPoison).
  if (pvpSt.isPVPBattle) {
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const { x: cx, y: cy } = pvpEnemyCellCenterLocal(parseInt(k));
      const by = _dmgBounceY(cy + 12, dn.timer);
      drawDmgPopup(ui.ctx, dn, cx + 8, by);
    }
    return;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const { count, boxX, boxY, sprH, row0H, row1H, gridPos: swGridPos } = encounterGridLayout();
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const idx = parseInt(k);
      if (idx >= swGridPos.length) continue;
      const tp = swGridPos[idx];
      const m = battleSt.encounterMonsters[idx];
      const mcv = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
      const rH = idx < 2 ? (row0H || sprH) : (row1H || sprH);
      const mw = mcv ? mcv.width : 32;
      const bx = tp.x + mw - 4;
      const baseY = tp.y + rH - 8;
      const by = _dmgBounceY(baseY, dn.timer);
      drawDmgPopup(ui.ctx, dn, bx, by);
    }
  } else {
    // Boss — damage number on bottom-right of boss sprite
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    for (const [k, dn] of Object.entries(getSwDmgNums())) {
      const bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
      const baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
      const by = _dmgBounceY(baseY, dn.timer);
      drawDmgPopup(ui.ctx, dn, bx, by);
    }
  }
}

// Pick the right on-target sparkle frames for an item being used. Routes via
// the item's declared `animSpellId` through spell-anim.js; items whose spell
// animation hasn't been captured yet fall back to the legacy 4-corner Cure
// sparkle from sprite-init.js.
export function _itemSparkleFrames(itemId) {
  const bundle = getSpellAnimForItem(itemId);
  if (bundle && bundle.frames && bundle.frames.length === 2) return bundle.frames;
  return bsc.cureSparkleFrames && bsc.cureSparkleFrames.length === 2 ? bsc.cureSparkleFrames : null;
}

function drawBattle() {
  if (battleSt.battleState === 'none') return;
  drawBattleCritFlash();
  drawBattlePortrait();
  drawBattleStrobeFlash();
  drawEncounterBox();
  drawBossSpriteBox();
  _drawPlayerSpellTargetSparkleOnEnemy();
  _drawPVPEnemyOffensiveCast();
  _drawAllyOffensiveCast();
  drawBattleMenu();
  drawVictoryBox();
  drawBattleMessageStrip();
  drawDamageNumbers();
}

// ── Centralized magic render helpers ─────────────────────────────────────
//
// These are the SINGLE source of truth for cast / projectile / on-target
// rendering during magic-cast / magic-hit phases. All three render paths
// (player, ally, PVP enemy) call into them so adding a new spell or
// adjusting a phase only requires editing one site.
//
// Faction-axis projectile rule (the user's standing rule): a projectile
// renders only when caster.faction !== target.faction (cross-faction).
// Same-faction casts (heal on self, ally) skip the projectile and jump
// straight to the on-target effect.

// Cast render helpers `drawCasterCastBehind` / `drawCasterCastFront` are
// imported from cast-anim.js — single source of truth, no per-render-site
// reimplementation. Called below by player + ally + (PVP via pvp.js).

// Status overlay — single source for the 16×8 status sprite drawn above a
// combatant's body. Player + roster ally + PVP enemy all route here so the
// priority order, frame cadence, and tile cache lookup live in one place.
//
// Priority order: petrify > sleep > confuse > paralysis > silence > blind > poison.
// Highest-priority active flag wins; lower flags don't draw concurrently.
//
// `mirror=true` h-flips the sprite around its 16-px width — used for PVP
// enemy bodies (which face right, opposite the player party). Status sprite
// tiles are asymmetric (the sleep "Z"s are slanted), so PVP must flip to
// match the body orientation.
const _STATUS_PRIO = [0x40, 0x100, 0x200, 0x01, 0x10, 0x04, 0x02];
export function drawStatusSpriteAbove(ctx, statusObj, x, y, mirror = false) {
  if (!statusObj || !statusObj.mask || !bsc.statusSpriteMap) return;
  for (const flag of _STATUS_PRIO) {
    if (!(statusObj.mask & flag)) continue;
    const frames = bsc.statusSpriteMap.get(flag);
    if (!frames || frames.length !== 2) return;
    const f = frames[Math.floor(Date.now() / 133) & 1];
    if (mirror) {
      ctx.save();
      ctx.translate(x + f.width, y);
      ctx.scale(-1, 1);
      ctx.drawImage(f, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(f, x, y);
    }
    return;
  }
}

// Resolve the (x, y) center of a magic target. Used by the projectile fan
// and on-target effect helpers. Returns null if the target can't be
// resolved (dead enemy, missing layout data).
function _getMagicTargetCenter(tgt) {
  if (!tgt) return null;
  if (tgt.type === 'player') {
    return { x: HUD_RIGHT_X + 8 + 8, y: HUD_VIEW_Y + 8 + 8 };
  }
  if (tgt.type === 'ally') {
    const panelTop = HUD_VIEW_Y + 32;
    const ppy = panelTop + tgt.index * ROSTER_ROW_H + 8;
    return { x: HUD_RIGHT_X + 8 + 8, y: ppy + 8 };
  }
  // tgt.type === 'enemy'
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    const m = battleSt.encounterMonsters[tgt.index];
    if (!m) return null;
    const { sprH, row0H, row1H, gridPos } = encounterGridLayout();
    if (tgt.index >= gridPos.length) return null;
    const pos = gridPos[tgt.index];
    const mc = getMonsterCanvas(m.monsterId, battleSt.goblinBattleCanvas);
    const mw = mc ? mc.width : 32;
    const mh = mc ? mc.height : sprH;
    const rH = tgt.index < 2 ? (row0H || sprH) : (row1H || sprH);
    return {
      x: pos.x + Math.floor(mw / 2),
      y: pos.y + (rH - mh) + Math.floor(mh / 2),
    };
  }
  if (pvpSt.isPVPBattle) {
    // pvpEnemyCellCenter returns the 24×32 CELL center; the body inside is
    // 16×24 starting 4 px from cell top, so body center is 4 px below cell
    // center. Aim the projectile + burst at body center for vertical
    // alignment with the PVP-side cast halo (which centers on the body).
    const { x, y } = pvpEnemyCellCenterLocal(tgt.index);
    return { x, y: y + 4 };
  }
  // Boss
  return {
    x: HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2),
    y: HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2),
  };
}

// Caster faction: player + ally = 'party'; pvp-enemy + encounter-enemy = 'foe'.
// Same-faction caster→target skips projectile.
function _isCrossFaction(casterFaction, tgt) {
  if (!tgt) return false;
  const tgtFaction = (tgt.type === 'enemy') ? 'foe' : 'party';
  return casterFaction !== tgtFaction;
}

// Draw a projectile fan-out from caster center to each target center.
// Renders ONLY for cross-faction targets (same-faction targets render no
// projectile per the user's standing rule). The $58 tile has a directional
// trailing flame — canonical capture is right→left (player→enemy), so we
// auto-h-flip when the projectile travels left→right (e.g. a PVP enemy
// casting toward the player party). Per-target hflip means a multi-target
// fan can mix directions if the layout demands.
export function drawProjectileFan(ctx, sx, sy, casterFaction, targets, spellId, spell, t01) {
  if (t01 < 0 || t01 > 1) return;
  for (const tgt of targets) {
    if (!_isCrossFaction(casterFaction, tgt)) continue;
    const tc = _getMagicTargetCenter(tgt);
    if (!tc) continue;
    const hflip = sx < tc.x;
    const tile = getProjectileTile(spellId, spell, hflip);
    if (!tile) continue;
    const x = sx + (tc.x - sx) * t01;
    const y = sy + (tc.y - sy) * t01;
    ctx.drawImage(tile, Math.round(x - 4), Math.round(y - 4));
  }
}

// Draw the on-target spell-anim effect at every target. Bundles can be
// 'portrait-2frame' (16×16, anchored at portrait top-left) or
// 'burst-strip-2frame' (variable size, anchored at sprite center).
export function drawSpellEffectAtTargets(ctx, targets, spellId, elapsedMs) {
  const bundle = getSpellAnim(spellId);
  if (!bundle) return;
  const frame = getSpellAnimFrame(bundle, elapsedMs);
  if (!frame) return;
  for (const tgt of targets) {
    const tc = _getMagicTargetCenter(tgt);
    if (!tc) continue;
    if (bundle.kind === 'portrait-2frame') {
      // Portrait-anchored 16×16: draw at (centerX - 8, centerY - 8) which
      // matches portrait top-left (since portrait is 16×16 centered on tc).
      ctx.drawImage(frame, tc.x - 8, tc.y - 8);
    } else if (bundle.kind === 'burst-strip-2frame') {
      ctx.drawImage(frame, tc.x - Math.floor(bundle.width / 2),
                           tc.y - Math.floor(bundle.height / 2));
    } else if (bundle.kind === 'aoe-3phase') {
      // 3-phase expanding burst — each phase has a different canvas size, so
      // center per-frame (frame.width / 2) rather than from the bundle.
      ctx.drawImage(frame, tc.x - Math.floor(frame.width / 2),
                           tc.y - Math.floor(frame.height / 2));
    }
  }
}

// Player-cast magic targeting an enemy — render the projectile fan +
// on-target burst on every cross-faction target. Same-faction targets
// (player-self, ally) render their on-target effect via portrait overlay
// helpers in _drawPortraitOverlays / _drawAllyRow.
// Spell-ID source: getCurrentSpellId() (player-cast). Ally-cast and
// PVP-cast versions read from battleSt.allyMagicSpellId / pvpSt.pvpMagicSpellId
// when offensive magic ships for those paths.
function _drawPlayerSpellTargetSparkleOnEnemy() {
  // All player throw flows (item-use, thrown, heal-style) resolved inside
  // `drawSpellThrow('player', ...)`. Caster = player portrait center.
  const sx = HUD_RIGHT_X + 8 + 8;
  const sy = HUD_VIEW_Y + 8 + 8;
  drawSpellThrow('player', ui.ctx, { x: sx, y: sy, faction: 'party' }, null);
}

// PVP-enemy offensive cast — mirror of `_drawPlayerSpellTargetSparkleOnEnemy`
// for the opposite direction. When a fake-player BM/RM in PVP casts Fire /
// Blizzard / Sleep on the player party, this renders the projectile fan
// (parallel) and impact burst (single target — current AI picks one) using
// the same `drawProjectileFan` + `drawSpellEffectAtTargets` helpers. The
// helpers auto-handle hflip via sx vs tx, so the trailing flame stays
// behind the orb regardless of travel direction.
function _drawPVPEnemyOffensiveCast() {
  if (!pvpSt.isPVPBattle) return;
  if (pvpSt.pvpMagicCasterCellIdx < 0) return;
  if (pvpSt.pvpMagicPartyTargetIdx <= -100) return;
  // Caller resolves caster position + target spec; the shared `drawSpellThrow`
  // helper in combatant-cast.js handles state gating, projectile/impact phase
  // split, spell-anim dispatch.
  const cc = pvpEnemyCellCenterLocal(pvpSt.pvpMagicCasterCellIdx);
  const partyIdx = pvpSt.pvpMagicPartyTargetIdx;
  const target = partyIdx === -1
    ? { type: 'player' }
    : { type: 'ally', index: partyIdx };
  drawSpellThrow('pvp-enemy', ui.ctx, { x: cc.x, y: cc.y, faction: 'foe' }, target);
}

// Roster-ally offensive cast — Fire / Bzzard / Sleep on an encounter monster
// or PVP-enemy cell. Mirror of `_drawPVPEnemyOffensiveCast` for the ally
// caster on the player side. Source = ally portrait center (right column,
// row N); target = `{type:'enemy', index}` which `_getMagicTargetCenter`
// resolves to encounterMonsters[idx] OR pvpEnemyCellCenterLocal(idx) (idx 0 =
// opponent, 1+ = enemy ally idx-1) — same convention used everywhere else.
function _drawAllyOffensiveCast() {
  if (battleSt.allyMagicCasterIdx < 0) return;
  // Caller resolves caster position; shared `drawSpellThrow` does the rest.
  const panelTop = HUD_VIEW_Y + 32;
  const sx = HUD_RIGHT_X + 8 + 8;
  const sy = panelTop + battleSt.allyMagicCasterIdx * ROSTER_ROW_H + 8 + 8;
  const target = { type: 'enemy', index: battleSt.allyMagicTargetIdx };
  drawSpellThrow('ally', ui.ctx, { x: sx, y: sy, faction: 'party' }, target);
}





function _encounterMonsterPos(idx) {
  const { sprH: dSprH, row0H, row1H, gridPos } = encounterGridLayout();
  if (gridPos.length === 0) return { bx: 0, baseY: 0 };  // empty layout — caller will draw at (0,0); same guard rail as the other gridPos sites.
  const safeIdx = (idx >= 0 && idx < gridPos.length) ? idx : 0;
  const pos = gridPos[safeIdx];
  const m = battleSt.encounterMonsters[safeIdx];
  const mc = getMonsterCanvas(m?.monsterId, battleSt.goblinBattleCanvas);
  const rH = safeIdx < 2 ? (row0H || dSprH) : (row1H || dSprH);
  const mh = mc ? mc.height : rH;
  const mw = mc ? mc.width : 32;
  return { bx: pos.x + mw - 4, baseY: pos.y + rH - 8 };
}
function _drawBossDmgNum() {
  if (!getEnemyDmgNum() || (battleSt.enemyDefeated && !battleSt.isRandomEncounter)) return;
  let bx, baseY;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(inputSt.targetIndex));
  } else if (pvpSt.isPVPBattle) {
    const tidx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
    const { x: cx, y: cy } = pvpEnemyCellCenterLocal(tidx);
    bx = cx + 8;
    baseY = cy + 12;
  } else {
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
  }
  const by = _dmgBounceY(baseY, getEnemyDmgNum().timer);
  clipToViewport();
  drawDmgPopup(ui.ctx, getEnemyDmgNum(), bx, by);
  ui.ctx.restore();
}

function _drawEnemyHealNum() {
  if (!getEnemyHealNum()) return;
  let bx, baseY;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    ({ bx, baseY } = _encounterMonsterPos(getEnemyHealNum().index));
  } else if (pvpSt.isPVPBattle) {
    const cellIdx = getEnemyHealNum().index || 0;
    const { x: cx, y: cy } = pvpEnemyCellCenterLocal(cellIdx);
    bx = cx + 8;
    baseY = cy + 12;
  } else {
    const bc = getBossBattleCanvas();
    const bw = bc ? bc.width : 48;
    const bh = bc ? bc.height : 48;
    bx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2) + Math.floor(bw / 2) - 4;
    baseY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2) + Math.floor(bh / 2) - 8;
  }
  const hy = _dmgBounceY(baseY, getEnemyHealNum().timer);
  clipToViewport();
  _drawBattleNum(bx, hy, getEnemyHealNum().value, HEAL_NUM_PAL);
  ui.ctx.restore();
}

function _drawBattleNum(bx, by, value, pal) {
  _drawBattleNumCtx(ui.ctx, bx, by, value, pal);
}
function drawDamageNumbers() {
  _drawBossDmgNum();

  // Player damage number — bounces on right side of portrait
  if (getPlayerDamageNum()) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, getPlayerDamageNum().timer);
    drawDmgPopup(ui.ctx, getPlayerDamageNum(), px, py);
  }

  // Player heal number — green bounce on right side of portrait during item-use
  if (getPlayerHealNum()) {
    const px = HUD_RIGHT_X + 20;
    const baseY = HUD_VIEW_Y + 16;
    const py = _dmgBounceY(baseY, getPlayerHealNum().timer);
    _drawBattleNum(px, py, getPlayerHealNum().value, HEAL_NUM_PAL);
  }

  _drawEnemyHealNum();
}

// Battle message strip — renders in right panel where chat tabs normally are.
// Layout + timings come from battle-msg.js so update + render share one source.

function drawBattleMessageStrip() {
  const msg = getBattleMsgCurrent();
  if (!msg) return;
  const t = getBattleMsgTimer();
  const { overflow, scrollMs, hold } = computeMsgTimings(msg);
  let fadeStep = 0;
  if (msg.persist && battleSt.battleState === 'victory-text-out') {
    fadeStep = Math.min(Math.floor(battleSt.battleTimer / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (t < MSG_FADE_IN_MS) {
    fadeStep = BATTLE_TEXT_STEPS - Math.min(Math.floor(t / (MSG_FADE_IN_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  } else if (msg.waitForZ || msg.persist || t < MSG_FADE_IN_MS + hold) {
    fadeStep = 0; // waitForZ/persist: stay solid after fade-in
  } else {
    fadeStep = Math.min(Math.floor((t - MSG_FADE_IN_MS - hold) / (MSG_FADE_OUT_MS / BATTLE_TEXT_STEPS)), BATTLE_TEXT_STEPS);
  }
  if (fadeStep >= BATTLE_TEXT_STEPS) return;
  const pal = _makeFadedPal(fadeStep);
  const y = MSG_STRIP_Y + 4;
  if (overflow === 0) {
    drawText(ui.ctx, MSG_STRIP_X, y, msg.bytes, pal);
  } else {
    const holdT = t - MSG_FADE_IN_MS;
    let scrollX = 0;
    if (holdT < MSG_SCROLL_PAUSE_MS) scrollX = 0;
    else if (holdT < MSG_SCROLL_PAUSE_MS + scrollMs) scrollX = (holdT - MSG_SCROLL_PAUSE_MS) * MSG_SCROLL_SPEED_PX_MS;
    else scrollX = overflow;
    ui.ctx.save();
    ui.ctx.beginPath();
    ui.ctx.rect(MSG_STRIP_X, MSG_STRIP_Y, MSG_STRIP_W, 16);
    ui.ctx.clip();
    drawText(ui.ctx, MSG_STRIP_X - scrollX, y, msg.bytes, pal);
    ui.ctx.restore();
  }
}

export { drawBattle, drawBattleAllies, drawSWExplosion, drawSWDamageNumbers };
