// battle-update.js — battle state machine: opening, player attack, defend/item,
// run, boss dissolve, victory, defeat, and main updateBattle() loop.

import { battleSt, getEnemyHP, setEnemyHP, BOSS_MAX_HP,
         BATTLE_SHAKE_MS, MONSTER_DEATH_MS } from './battle-state.js';
import { inputSt } from './input-handler.js';
import { pvpSt, resetPVPState, updatePVPBattle } from './pvp.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { ps, grantExp, grantCP, getHitWeapon, isHitRightHand, gainJobJP } from './player-stats.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { updateBattleAlly } from './battle-ally.js';
import { updateBattleEnemyTurn } from './battle-enemy.js';
import { resetBattleItemVars, updateMagicItemThrowHit } from './battle-items.js';
import { replaceBattleMsg, updateBattleMsg as _updateBattleMsg, clearBattleMsgQueue,
         queueVictoryRewards as _queueVictoryRewards, getBattleMsgCurrent,
         getBattleMsgQueue, setBattleMsgCurrent } from './battle-msg.js';
import { resetAllDmgNums, tickDmgNums, tickHealNums, clearHealNums,
         setEnemyDmgNum } from './damage-numbers.js';
import { playSFX, stopMusic, pauseMusic, resumeMusic, playTrack, TRACKS, SFX } from './music.js';
import { ITEMS, isBladedWeapon } from './data/items.js';
import { MONSTERS } from './data/monsters.js';
import { PLAYER_POOL, generateAllyStats } from './data/players.js';
import { BATTLE_ROAR, BATTLE_CANT_ESCAPE, BATTLE_CRITICAL } from './data/strings.js';
import { showMsgBox } from './message-box.js';
import { triggerWipe, findWorldExitIndex } from './map-triggers.js';
import { loadWorldMapAt, loadWorldMapAtPosition } from './map-loading.js';
import { _nameToBytes } from './text-utils.js';
import { getPlayerLocation } from './roster.js';
import { DIR_DOWN } from './sprite.js';
import { tryInflictStatus, wakeOnHit, STATUS_NAME_BYTES } from './status-effects.js';
import { playSlashSFX } from './battle-sfx.js';
import { saveSlotsToDB } from './save-state.js';

// ── Constants ──────────────────────────────────────────────────────────────
const BATTLE_TEXT_STEP_MS      = 50;
const BATTLE_TEXT_STEPS        = 4;
const BATTLE_FLASH_FRAMES      = 65;
const BATTLE_FLASH_FRAME_MS    = 16.67;
const BATTLE_MSG_HOLD_MS       = 1200;
const BOSS_BOX_EXPAND_MS       = 300;
const BOSS_BLOCKS              = 9;
const BOSS_DISSOLVE_STEPS      = 8;
const BOSS_DISSOLVE_FRAME_MS   = 16.67;
const MONSTER_SLIDE_MS         = 267;
const SLASH_FRAME_MS           = 30;
const SLASH_FRAMES             = 3;
const BACK_SWING_MS            = 80;
const FWD_SWING_MS             = 80;
const HIT_PAUSE_MS             = 100;
const HIT_COMBO_PAUSE_MS       = 30;
const MISS_SHOW_MS             = 300;
const PLAYER_DMG_SHOW_MS       = 700;
const DEFEND_SPARKLE_TOTAL_MS  = 533;
const TURN_TIME_MS             = 10000;
const VICTORY_BOX_ROWS         = 8;
const VICTORY_ROW_FRAME_MS     = 16.67;
const POISON_TICK_MS           = 500;

// ── Injected by initBattleUpdate() ─────────────────────────────────────────
let _keys = {};
let _getSprite = () => null;
let _addItem = () => {};
let _buildItemSelectList = () => [];

export function initBattleUpdate({ keys, getSprite, addItem, buildItemSelectList }) {
  _keys = keys;
  _getSprite = getSprite;
  _addItem = addItem;
  _buildItemSelectList = buildItemSelectList;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _zPressed() { if (!_keys['z'] && !_keys['Z']) return false; _keys['z'] = false; _keys['Z'] = false; return true; }

// ── Exported utilities ─────────────────────────────────────────────────────

export function resetBattleVars() {
  inputSt.battleCursor = 0; battleSt.battleMessage = null;
  resetAllDmgNums();
  battleSt.encounterDropItem = null; battleSt.bossFlashTimer = 0; battleSt.battleShakeTimer = 0;
  battleSt.isDefending = false; battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
  battleSt.currentAllyAttacker = -1; battleSt.allyTargetIndex = -1; battleSt.allyHitResult = null; battleSt.allyHitIsLeft = false;
  battleSt.allyShakeTimer = {}; battleSt.enemyTargetAllyIdx = -1; battleSt.allyExitTimer = 0;
  resetBattleItemVars();
  hudSt.playerDeathTimer = null; battleSt._teamWipeMsgShown = false;
  inputSt.battleActionCount = 0;
  clearBattleMsgQueue();
}

export function isTeamWiped() {
  if (ps.hp > 0) return false;
  return battleSt.battleAllies.every(a => a.hp <= 0);
}

export function isVictoryBattleState() {
  return battleSt.battleState === 'victory-celebrate' ||
    battleSt.battleState === 'exp-text-in' || battleSt.battleState === 'exp-hold' || battleSt.battleState === 'exp-fade-out' ||
    battleSt.battleState === 'gil-text-in' || battleSt.battleState === 'gil-hold' || battleSt.battleState === 'gil-fade-out' ||
    battleSt.battleState === 'cp-text-in' || battleSt.battleState === 'cp-hold' || battleSt.battleState === 'cp-fade-out' ||
    battleSt.battleState === 'item-text-in' || battleSt.battleState === 'item-hold' || battleSt.battleState === 'item-fade-out' ||
    battleSt.battleState === 'levelup-text-in' || battleSt.battleState === 'levelup-hold' || battleSt.battleState === 'levelup-fade-out' ||
    battleSt.battleState === 'joblv-text-in' || battleSt.battleState === 'joblv-hold' || battleSt.battleState === 'joblv-fade-out' ||
    battleSt.battleState === 'victory-text-out' || battleSt.battleState === 'victory-menu-fade' || battleSt.battleState === 'victory-box-close';
}

export function startBattle() {
  battleSt.battleState = 'roar-hold';
  battleSt.battleTimer = 0;
  showMsgBox(BATTLE_ROAR, () => { battleSt.battleState = 'flash-strobe'; battleSt.battleTimer = 0; playSFX(SFX.BATTLE_SWIPE); });
  resetBattleVars();
  battleSt.enemyHP = BOSS_MAX_HP;
  playSFX(SFX.EARTHQUAKE);
}

export function executeBattleCommand(index) {
  if (index === 0) {
    // Fight — go to target select (cursor on enemy)
    playSFX(SFX.CONFIRM);
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      inputSt.targetIndex = battleSt.encounterMonsters.findIndex(m => m.hp > 0);
    }
    battleSt.battleState = 'target-select';
    battleSt.battleTimer = 0;
  } else if (index === 1) {
    // Defend
    playSFX(SFX.CONFIRM);
    battleSt.isDefending = true;
    inputSt.playerActionPending = { command: 'defend' };
    battleSt.battleState = 'confirm-pause';
    battleSt.battleTimer = 0;
  } else if (index === 2) {
    // Item
    playSFX(SFX.CONFIRM);
    inputSt.itemSelectList = _buildItemSelectList();
    inputSt.itemHeldIdx = -1;
    inputSt.itemPage = 1;
    inputSt.itemPageCursor = 0;
    inputSt.itemSlideDir = 0;
    inputSt.itemSlideCursor = 0;
    battleSt.battleState = 'item-menu-out';
    battleSt.battleTimer = 0;
  } else {
    // Run
    if (battleSt.isRandomEncounter) {
      playSFX(SFX.CONFIRM);
      battleSt.isDefending = false;
      inputSt.playerActionPending = { command: 'run' };
      battleSt.battleState = 'confirm-pause';
      battleSt.battleTimer = 0;
    } else {
      playSFX(SFX.ERROR);
      battleSt.battleMessage = BATTLE_CANT_ESCAPE;
      battleSt.battleState = 'message-hold';
      battleSt.battleTimer = 0;
    }
  }
}

// ── Battle timer updates ───────────────────────────────────────────────────

export function updateBattleTimers(dt) {
  if (battleSt.bossFlashTimer > 0) battleSt.bossFlashTimer = Math.max(0, battleSt.bossFlashTimer - dt);
  if (battleSt.battleShakeTimer > 0) battleSt.battleShakeTimer = Math.max(0, battleSt.battleShakeTimer - dt);
  if (pvpSt.pvpOpponentShakeTimer > 0) pvpSt.pvpOpponentShakeTimer = Math.max(0, pvpSt.pvpOpponentShakeTimer - dt);

  tickDmgNums(dt);
  for (const idx in battleSt.allyShakeTimer) {
    if (battleSt.allyShakeTimer[idx] > 0) battleSt.allyShakeTimer[idx] = Math.max(0, battleSt.allyShakeTimer[idx] - dt);
  }
  // Start player death animation on first frame of hp=0
  if (ps.hp <= 0 && hudSt.playerDeathTimer == null && battleSt.battleState !== 'none') { hudSt.playerDeathTimer = 0; }
  if (hudSt.playerDeathTimer != null) hudSt.playerDeathTimer += dt;
  for (const ally of battleSt.battleAllies) {
    if (ally.deathTimer != null) ally.deathTimer += dt;
  }

  _updateTurnTimer(dt);
  _updateAllyExitFade(dt);
}

function _updateTurnTimer(dt) {
  const isPlayerDeciding = battleSt.battleState === 'menu-open' || battleSt.battleState === 'target-select' ||
    battleSt.battleState === 'item-select' || battleSt.battleState === 'item-target-select' || battleSt.battleState === 'item-slide';
  if (!isPlayerDeciding) return;
  battleSt.turnTimer += dt;
  if (battleSt.turnTimer >= TURN_TIME_MS) {
    battleSt.turnTimer = 0; inputSt.itemHeldIdx = -1;
    inputSt.playerActionPending = { command: 'skip' }; battleSt.battleState = 'confirm-pause'; battleSt.battleTimer = 0;
  }
}

function _updateAllyExitFade(dt) {
  if (battleSt.battleAllies.length === 0) return;
  const isVicState = isVictoryBattleState() && battleSt.battleState !== 'victory-box-close';
  if (!isVicState) return;
  const ALLY_EXIT_DELAY_MS = 1500, ALLY_EXIT_STEP_MS = 100;
  battleSt.allyExitTimer += dt;
  if (battleSt.allyExitTimer >= ALLY_EXIT_DELAY_MS) {
    const stepsDone = Math.floor((battleSt.allyExitTimer - ALLY_EXIT_DELAY_MS) / ALLY_EXIT_STEP_MS);
    const targetFade = Math.min(4, stepsDone);
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (battleSt.battleAllies[i].fadeStep < targetFade) battleSt.battleAllies[i].fadeStep = targetFade;
    }
  }
}

// ── Battle opening ─────────────────────────────────────────────────────────

function _updateBattleOpening() {
  if (battleSt.battleState === 'roar-hold') {
    // waits for msgBox Z dismiss → callback sets flash-strobe
  } else if (battleSt.battleState === 'flash-strobe') {
    if (battleSt.battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      if (battleSt.isRandomEncounter) {
        battleSt.battleState = 'encounter-box-expand'; battleSt.battleTimer = 0; pauseMusic(); playTrack(TRACKS.BATTLE);
      } else {
        battleSt.battleState = 'enemy-box-expand'; battleSt.battleTimer = 0; pauseMusic(); playTrack(TRACKS.BOSS_BATTLE);
      }
    }
  } else if (battleSt.battleState === 'encounter-box-expand') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) { battleSt.battleState = 'monster-slide-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'monster-slide-in') {
    if (battleSt.battleTimer >= MONSTER_SLIDE_MS) { battleSt.battleState = 'battle-fade-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'enemy-box-expand') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) { battleSt.battleState = 'boss-appear'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'boss-appear') {
    if (battleSt.battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) { battleSt.battleState = 'battle-fade-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'battle-fade-in') {
    if (battleSt.battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; }
  } else { return false; }
  return true;
}

// ── Ally join ──────────────────────────────────────────────────────────────

export function tryJoinPlayerAlly() {
  if (battleSt.battleAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const pvpNames = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
  ].filter(Boolean));
  const eligible = PLAYER_POOL.filter(p =>
    p.loc === loc &&
    !battleSt.battleAllies.some(a => a.name === p.name) &&
    !pvpNames.has(p.name)
  );
  if (eligible.length === 0 || Math.random() >= 0.5) return false;
  battleSt.battleAllies.push(generateAllyStats(eligible[Math.floor(Math.random() * eligible.length)]));
  battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0;
  return true;
}

// ── Menu confirm ───────────────────────────────────────────────────────────

function _updateBattleMenuConfirm() {
  if (battleSt.battleState === 'message-hold') {
    if (battleSt.battleTimer >= BATTLE_MSG_HOLD_MS) { battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; battleSt.battleMessage = null; }
  } else if (battleSt.battleState === 'confirm-pause') {
    if (battleSt.battleTimer >= 150) {
      battleSt.allyJoinRound++;
      if (tryJoinPlayerAlly()) return true;
      battleSt.turnQueue = buildTurnOrder(); processNextTurn();
    }
  } else { return false; }
  return true;
}

// ── Player attack chain ────────────────────────────────────────────────────

function _finalizeComboHits() {
  let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
  for (const h of inputSt.hitResults) {
    if (!h.miss) { totalDmg += h.damage; allMiss = false; hitsLanded++; if (h.crit) anyCrit = true; }
  }
  setEnemyDmgNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
  if (pvpSt.isPVPBattle && !allMiss) pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
  // Replace strip message: status > crit > multi-hit
  if (!allMiss) {
    if (battleSt.comboStatusInflicted && STATUS_NAME_BYTES[battleSt.comboStatusInflicted]) {
      replaceBattleMsg(STATUS_NAME_BYTES[battleSt.comboStatusInflicted]);
    } else if (anyCrit) {
      replaceBattleMsg(BATTLE_CRITICAL);
    } else if (hitsLanded > 1) {
      replaceBattleMsg(_nameToBytes(hitsLanded + ' hits!'));
    }
  }
  battleSt.comboStatusInflicted = 0;
  battleSt.battleState = 'player-damage-show';
  battleSt.battleTimer = 0;
}

function _advanceHitCombo() {
  if (battleSt.currentHitIdx + 1 < inputSt.hitResults.length) {
    battleSt.currentHitIdx++;
    battleSt.slashFrame = 0;
    const handWeapon = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
    bsc.slashFrames = getSlashFramesForWeapon(handWeapon, isHitRightHand(battleSt.currentHitIdx, inputSt.rHandHitCount));
    if (isBladedWeapon(handWeapon)) { battleSt.slashOffX = 8; battleSt.slashOffY = -8; }
    else { battleSt.slashOffX = Math.floor(Math.random() * 40) - 20; battleSt.slashOffY = Math.floor(Math.random() * 40) - 20; }
    battleSt.battleState = 'attack-back';
    battleSt.battleTimer = 0;
  } else {
    _finalizeComboHits();
  }
}

function _updatePlayerAttackBack() {
  if (battleSt.battleState !== 'attack-back') return false;
  if (battleSt.currentHitIdx === 0) battleSt.comboStatusInflicted = 0;
  const delay = battleSt.currentHitIdx === 0 ? BACK_SWING_MS : HIT_COMBO_PAUSE_MS;
  if (battleSt.battleTimer >= delay) {
    battleSt.battleState = 'attack-fwd';
    battleSt.battleTimer = 0;
  }
  return true;
}

function _updatePlayerAttackFwd() {
  if (battleSt.battleState !== 'attack-fwd') return false;
  if (battleSt.battleTimer >= FWD_SWING_MS) {
    const hw0 = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
    const isCrit0 = inputSt.hitResults[battleSt.currentHitIdx] && inputSt.hitResults[battleSt.currentHitIdx].crit;
    playSlashSFX(hw0, isCrit0);
    battleSt.battleState = 'player-slash';
    battleSt.battleTimer = 0;
  }
  return true;
}

function _updatePlayerSlash() {
  if (battleSt.battleState !== 'player-slash') return false;
  const frame = Math.floor(battleSt.battleTimer / SLASH_FRAME_MS);
  if (frame !== battleSt.slashFrame && frame < SLASH_FRAMES) {
    battleSt.slashFrame = frame;
    const handWeapon = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
    if (isBladedWeapon(handWeapon)) {
      battleSt.slashOffX = 8 - battleSt.slashFrame * 8;
      battleSt.slashOffY = -8 + battleSt.slashFrame * 8;
    } else {
      battleSt.slashOffX = Math.floor(Math.random() * 40) - 20;
      battleSt.slashOffY = Math.floor(Math.random() * 40) - 20;
    }
  }
  if (battleSt.battleTimer >= SLASH_FRAMES * SLASH_FRAME_MS) {
    const hit = inputSt.hitResults[battleSt.currentHitIdx];
    if (!hit.miss) {
      if (pvpSt.isPVPBattle && pvpSt.pvpOpponentIsDefending)
        hit.damage = Math.max(1, Math.floor(hit.damage / 2));
      if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
        const targetMon = battleSt.encounterMonsters[inputSt.targetIndex];
        targetMon.hp = Math.max(0, targetMon.hp - hit.damage);
        // Physical hit wakes sleeping targets
        if (targetMon.status) wakeOnHit(targetMon.status);
        // Weapon on-hit status infliction
        if (targetMon.status && targetMon.hp > 0) {
          const wpnId = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
          const wpnData = ITEMS.get(wpnId);
          if (wpnData && wpnData.status) {
            const arr = Array.isArray(wpnData.status) ? wpnData.status : [wpnData.status];
            for (const s of arr) {
              const applied = tryInflictStatus(targetMon.status, s, wpnData.hit || 50);
              if (applied) battleSt.comboStatusInflicted = applied;
            }
          }
        }
      } else {
        setEnemyHP(Math.max(0, getEnemyHP() - hit.damage));
      }
      if (hit.crit) battleSt.critFlashTimer = 0;
    }
    battleSt.battleState = 'player-hit-show';
    battleSt.battleTimer = 0;
  }
  return true;
}

function _updatePlayerHitShow() {
  if (battleSt.battleState !== 'player-hit-show') return false;
  const hitPause = (battleSt.currentHitIdx + 1 < inputSt.hitResults.length) ? HIT_COMBO_PAUSE_MS : HIT_PAUSE_MS;
  if (battleSt.battleTimer >= hitPause) _advanceHitCombo();
  return true;
}

function _updatePlayerMissShow() {
  if (battleSt.battleState !== 'player-miss-show') return false;
  if (battleSt.battleTimer >= MISS_SHOW_MS) _advanceHitCombo();
  return true;
}

function _updatePlayerDamageShow() {
  if (battleSt.battleState !== 'player-damage-show') return false;
  if (battleSt.battleTimer >= PLAYER_DMG_SHOW_MS) {
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters && battleSt.encounterMonsters[inputSt.targetIndex].hp <= 0) {
      battleSt.dyingMonsterIndices = new Map([[inputSt.targetIndex, 0]]);
      battleSt.battleState = 'monster-death';
      battleSt.battleTimer = 0;
      playSFX(SFX.MONSTER_DEATH);
    } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
      if (pvpSt.isPVPBattle) {
        battleSt.battleState = 'pvp-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
      } else { battleSt.battleState = 'boss-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
    } else {
      if (getBattleMsgCurrent()) { battleSt.battleState = 'msg-wait'; battleSt.battleTimer = 0; }
      else processNextTurn();
    }
  }
  return true;
}

export function updateBattlePlayerAttack() {
  return _updatePlayerAttackBack() ||
         _updatePlayerAttackFwd() ||
         _updatePlayerSlash() ||
         _updatePlayerHitShow() ||
         _updatePlayerMissShow() ||
         _updatePlayerDamageShow() ||
         _updateMonsterDeath();
}

// ── PVP target / victory ───────────────────────────────────────────────────

export function advancePVPTargetOrVictory() {
  if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) {
    pvpSt.pvpPlayerTargetIdx = -1;
    processNextTurn();
    return;
  }
  const aliveAllyIdx = pvpSt.pvpEnemyAllies.findIndex(a => a.hp > 0);
  if (aliveAllyIdx >= 0) {
    pvpSt.pvpPlayerTargetIdx = aliveAllyIdx;
    processNextTurn();
  } else {
    _triggerPVPVictory();
  }
}

function _triggerPVPVictory() {
  const oppLv = pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.level : 1;
  const rawPvpExp = 5 * oppLv;
  grantExp(rawPvpExp);
  battleSt.encounterExpGained = Math.max(1, Math.floor(rawPvpExp / 4));
  battleSt.encounterGilGained = Math.max(1, Math.floor(10 * oppLv / 4));
  battleSt.encounterCpGained = Math.max(1, Math.floor(oppLv / 4)); grantCP(battleSt.encounterCpGained);
  ps.gil += battleSt.encounterGilGained;
  battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
  inputSt.battleActionCount = 0;
  saveSlotsToDB();
  _queueVictoryRewards();
  battleSt.enemyDefeated = true;
  battleSt.isDefending = false; battleSt.battleState = 'victory-name-out'; battleSt.battleTimer = 0;
  playSFX(SFX.BOSS_DEATH);
}

// ── Monster death ──────────────────────────────────────────────────────────

function _updateMonsterDeath() {
  if (battleSt.battleState !== 'monster-death') return false;
  const _maxDelay = battleSt.dyingMonsterIndices.size > 0 ? Math.max(...battleSt.dyingMonsterIndices.values()) : 0;
  if (battleSt.battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
    battleSt.dyingMonsterIndices = new Map();
    const allDead = battleSt.encounterMonsters.every(m => m.hp <= 0);
    if (allDead) {
      const rawExp = battleSt.encounterMonsters.reduce((sum, m) => sum + m.exp, 0);
      grantExp(rawExp);
      battleSt.encounterExpGained = Math.max(1, Math.floor(rawExp / 4));
      battleSt.encounterGilGained = Math.max(1, Math.floor(battleSt.encounterMonsters.reduce((sum, m) => sum + (m.gil || 0), 0) / 4));
      battleSt.encounterCpGained = Math.max(1, Math.floor(battleSt.encounterMonsters.reduce((sum, m) => sum + (m.cp || 1), 0) / 4)); grantCP(battleSt.encounterCpGained);
      ps.gil += battleSt.encounterGilGained;
      battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
      inputSt.battleActionCount = 0;
      battleSt.encounterDropItem = null;
      for (const m of battleSt.encounterMonsters) {
        const mData = MONSTERS.get(m.monsterId);
        if (mData && mData.drops && mData.drops.length && Math.random() < 0.25) {
          battleSt.encounterDropItem = mData.drops[Math.floor(Math.random() * mData.drops.length)];
          break;
        }
      }
      if (battleSt.encounterDropItem !== null) _addItem(battleSt.encounterDropItem, 1);
      saveSlotsToDB();
      _queueVictoryRewards();
      battleSt.isDefending = false;
      battleSt.battleState = 'victory-name-out';
      battleSt.battleTimer = 0;
    } else {
      processNextTurn();
    }
  }
  return true;
}

// ── Defend / Item ──────────────────────────────────────────────────────────

export function updateBattleDefendItem(dt) {
  if (battleSt.battleState === 'defend-anim') {
    if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      if (getBattleMsgCurrent()) { battleSt.battleState = 'msg-wait'; battleSt.battleTimer = 0; }
      else processNextTurn();
    }
  } else if (battleSt.battleState === 'item-use') {
    tickHealNums(dt);
    if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      clearHealNums();
      processNextTurn();
    }
  } else if (battleSt.battleState === 'sw-throw' || battleSt.battleState === 'sw-hit') {
    return updateMagicItemThrowHit();
  } else if (_updateItemMenuFades()) {
    return true;
  } else { return false; }
  return true;
}

function _updateItemMenuFades() {
  const FADE_DUR = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleSt.battleState === 'item-menu-out') {
    if (battleSt.battleTimer >= FADE_DUR) { battleSt.battleState = 'item-list-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-list-in') {
    if (battleSt.battleTimer >= FADE_DUR) { battleSt.battleState = 'item-select'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-slide') {
    if (battleSt.battleTimer >= 200) {
      inputSt.itemPage += (inputSt.itemSlideDir < 0) ? 1 : -1;
      inputSt.itemSlideDir = 0; inputSt.itemPageCursor = inputSt.itemSlideCursor; inputSt.itemSlideCursor = 0;
      battleSt.battleState = 'item-select'; battleSt.battleTimer = 0;
    }
  } else if (battleSt.battleState === 'item-cancel-out') {
    if (battleSt.battleTimer >= FADE_DUR) { battleSt.battleState = 'item-cancel-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-cancel-in') {
    if (battleSt.battleTimer >= FADE_DUR) { inputSt.itemPage = 1; battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-list-out') {
    if (battleSt.battleTimer >= FADE_DUR) { battleSt.battleState = 'item-use-menu-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-use-menu-in') {
    if (battleSt.battleTimer >= FADE_DUR) { battleSt.battleState = 'confirm-pause'; battleSt.battleTimer = 0; }
  } else { return false; }
  return true;
}

// ── Run ────────────────────────────────────────────────────────────────────

function _updateBattleRun() {
  if (battleSt.battleState === 'run-fail') {
    if (!getBattleMsgCurrent() && getBattleMsgQueue().length === 0) {
      processNextTurn();
    }
    return true;
  }
  if (battleSt.battleState === 'run-success') {
    if (!getBattleMsgCurrent() && getBattleMsgQueue().length === 0) {
      battleSt.runSlideBack = true; battleSt.battleState = 'encounter-box-close'; battleSt.battleTimer = 0;
    }
    return true;
  }
  return false;
}

// ── Boss dissolve ──────────────────────────────────────────────────────────

function _updateBossDissolve(dt) {
  if (battleSt.battleState !== 'boss-dissolve') return false;
  const dFrame = Math.floor(battleSt.battleTimer / BOSS_DISSOLVE_FRAME_MS);
  const dBlock = Math.floor(dFrame / BOSS_DISSOLVE_STEPS);
  const prevBlock = Math.floor(Math.floor((battleSt.battleTimer - dt) / BOSS_DISSOLVE_FRAME_MS) / BOSS_DISSOLVE_STEPS);
  if (dBlock !== prevBlock && dBlock > 0 && (dBlock & 3) === 0) playSFX(SFX.BOSS_DEATH);
  if (battleSt.battleTimer >= BOSS_BLOCKS * BOSS_DISSOLVE_STEPS * BOSS_DISSOLVE_FRAME_MS) {
    battleSt.enemyDefeated = true; mapSt.bossSprite = null;
    ps.unlockedJobs |= 0x3E; // Wind Crystal: bits 1-5 (Warrior, Monk, White Mage, Black Mage, Red Mage)
    const _bossData = MONSTERS.get(0xCC);
    const rawBossExp = _bossData?.exp || 132;
    grantExp(rawBossExp);
    battleSt.encounterExpGained = Math.max(1, Math.floor(rawBossExp / 4));
    battleSt.encounterGilGained = Math.max(1, Math.floor((_bossData?.gil || 500) / 4));
    ps.gil += battleSt.encounterGilGained;
    battleSt.encounterCpGained = Math.max(1, Math.floor((_bossData?.cp || 10) / 4)); grantCP(battleSt.encounterCpGained);
    battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
    inputSt.battleActionCount = 0;
    saveSlotsToDB();
    _queueVictoryRewards();
    battleSt.isDefending = false; battleSt.battleState = 'victory-name-out'; battleSt.battleTimer = 0;
  }
  return true;
}

// ── Victory sequence ───────────────────────────────────────────────────────

function _updateVictorySequence() {
  const _textMs = (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS;
  if (battleSt.battleState === 'victory-name-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'victory-celebrate'; battleSt.battleTimer = 0; playTrack(TRACKS.VICTORY); }
  } else if (battleSt.battleState === 'victory-celebrate') {
    if (battleSt.battleTimer >= 400) { battleSt.battleState = 'exp-text-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'exp-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'exp-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'exp-hold') {
  } else if (battleSt.battleState === 'exp-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'gil-text-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'gil-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'gil-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'gil-hold') {
  } else if (battleSt.battleState === 'gil-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'cp-text-in'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'cp-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'cp-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'cp-hold') {
  } else if (battleSt.battleState === 'cp-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = battleSt.encounterDropItem !== null ? 'item-text-in' : ps.leveledUp ? 'levelup-text-in' : battleSt.encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'item-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-hold') {
  } else if (battleSt.battleState === 'item-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = ps.leveledUp ? 'levelup-text-in' : battleSt.encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'levelup-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'levelup-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'levelup-hold') {
  } else if (battleSt.battleState === 'levelup-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = battleSt.encounterJobLevelUp ? 'joblv-text-in' : 'victory-text-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'joblv-text-in') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'joblv-hold'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'joblv-hold') {
  } else if (battleSt.battleState === 'joblv-fade-out') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'victory-text-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'victory-text-out') {
    if (battleSt.battleTimer >= _textMs) { setBattleMsgCurrent(null); battleSt.battleState = 'victory-menu-fade'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'victory-menu-fade') {
    if (battleSt.battleTimer >= _textMs) { battleSt.battleState = 'victory-box-close'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'victory-box-close') {
    if (battleSt.battleTimer >= VICTORY_BOX_ROWS * VICTORY_ROW_FRAME_MS) {
      battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close'; battleSt.battleTimer = 0;
    }
  } else { return false; }
  return true;
}

// ── Box close ──────────────────────────────────────────────────────────────

function _updateBoxClose() {
  if (battleSt.battleState === 'encounter-box-close') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) {
      battleSt.battleState = 'none'; battleSt.battleTimer = 0; battleSt.runSlideBack = false;
      _getSprite().setDirection(DIR_DOWN); battleSt.isRandomEncounter = false; battleSt.encounterMonsters = null;
      battleSt.dyingMonsterIndices = new Map(); battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
      stopMusic(); resumeMusic();
    }
    return true;
  }
  if (battleSt.battleState === 'enemy-box-close') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) {
      const wasPVP = pvpSt.isPVPBattle;
      resetPVPState();
      battleSt.battleState = 'none'; battleSt.battleTimer = 0; _getSprite().setDirection(DIR_DOWN);
      battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
      if (!wasPVP) playTrack(TRACKS.CRYSTAL_ROOM);
      else resumeMusic();
    }
    return true;
  }
  return false;
}

// ── Defeat ─────────────────────────────────────────────────────────────────

function _updateDefeatStates() {
  if (battleSt.battleState === 'team-wipe') {
    if (!battleSt._teamWipeMsgShown) { battleSt._teamWipeMsgShown = true; }
    if (battleSt.battleTimer >= 1200 || _zPressed()) {
      battleSt.battleState = 'defeat-close'; battleSt.battleTimer = 0;
    }
    return true;
  }
  if (battleSt.battleState === 'defeat-monster-fade') {
    stopMusic();
    if (battleSt.battleTimer >= 500) { battleSt.battleState = 'defeat-text'; battleSt.battleTimer = 0; }
    return true;
  }
  if (battleSt.battleState === 'defeat-text') return true; // Z to dismiss handled in handleInput
  if (battleSt.battleState === 'defeat-close') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) {
      resetPVPState();
      battleSt.battleState = 'none'; battleSt.battleTimer = 0;
      battleSt.isRandomEncounter = false;
      battleSt.encounterMonsters = null; battleSt.turnQueue = []; battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
      hudSt.playerDeathTimer = null; battleSt._teamWipeMsgShown = false;
      ps.hp = ps.stats ? ps.stats.maxHP : 28;
      ps.mp = ps.stats ? ps.stats.maxMP : 0;
      const worldEntry = mapSt.mapStack.slice().reverse().find(e => e.mapId === 'world');
      triggerWipe(() => {
        mapSt.dungeonFloor = -1; mapSt.encounterSteps = 0; mapSt.mapStack = [];
        if (worldEntry) {
          loadWorldMapAtPosition(worldEntry.x, worldEntry.y);
        } else {
          loadWorldMapAt(findWorldExitIndex(mapSt.currentMapId, mapSt.worldMapData));
        }
      }, 'world');
    }
    return true;
  }
  return false;
}

export function updateBattleEndSequence(dt) {
  return _updateBossDissolve(dt) || _updateVictorySequence() || _updateBoxClose() || _updateDefeatStates();
}

// ── Poison tick ────────────────────────────────────────────────────────────

function _updatePoisonTick() {
  if (battleSt.battleState !== 'poison-tick') return false;
  if (battleSt.battleTimer >= POISON_TICK_MS) { processNextTurn(); }
  return true;
}

// ── Main update ────────────────────────────────────────────────────────────

export function updateBattle(dt) {
  if (battleSt.battleState === 'none') return;
  battleSt.battleTimer += Math.min(dt, 33);
  _updateBattleMsg(dt);
  if (battleSt.battleState === 'msg-wait') { if (!getBattleMsgCurrent()) processNextTurn(); return; }
  if (pvpSt.isPVPBattle) { updatePVPBattle(dt); return; }
  updateBattleTimers(dt);
  _updatePoisonTick()              ||
  _updateBattleOpening()           ||
  _updateBattleMenuConfirm()       ||
  updateBattlePlayerAttack()       ||
  updateBattleDefendItem(dt)       ||
  _updateBattleRun()               ||
  updateBattleAlly()               ||
  updateBattleEnemyTurn()          ||
  updateBattleEndSequence(dt);
}
