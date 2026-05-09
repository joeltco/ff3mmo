// PVP duel system — state, AI logic, rendering

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { clipToViewport, drawBorderedBox } from './hud-drawing.js';
import { getPlayerLocation } from './roster.js';
// (weapon canvas selection moved to combatant-pose.js — opponent now uses pickAttackWeaponSpec)
import { getAllyDamageNums, getPlayerDamageNum, setPlayerDamageNum, getEnemyHealNum, setEnemyHealNum } from './damage-numbers.js';
import { getSpellTargets } from './spell-cast.js';
import { ui } from './ui-state.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { updateBattleAlly } from './battle-ally.js';
import { resetBattleVars, isTeamWiped, updateBattleTimers, updatePoisonTick,
         updateBattlePlayerAttack, updateBattleDefendItem, updateBattleEndSequence,
         tryJoinPlayerAlly, advancePVPTargetOrVictory } from './battle-update.js';
import { playSFX, stopSFX, SFX, pauseMusic, playTrack, TRACKS } from './music.js';
import { rollHits, calcPotentialHits, BOSS_HIT_RATE, GOBLIN_HIT_RATE } from './battle-math.js';
import { ITEMS, isWeapon, weaponSubtype } from './data/items.js';
import { PLAYER_POOL, PLAYER_PALETTES, MONK_PALETTES, BLACK_MAGE_PALETTES, RED_MAGE_PALETTES, generateAllyStats } from './data/players.js';

function _jobPalette(jobIdx, palIdx) {
  const pool = jobIdx === 2 ? MONK_PALETTES
             : jobIdx === 4 ? BLACK_MAGE_PALETTES
             : jobIdx === 5 ? RED_MAGE_PALETTES
             : PLAYER_PALETTES;
  return pool[palIdx] || pool[0];
}
import { JOBS } from './data/jobs.js';
import { MONSTERS } from './data/monsters.js';
import { ps } from './player-stats.js';
import { inputSt } from './input-handler.js';
import { getShieldEvade } from './player-stats.js';
import { pvpGridLayout, PVP_CELL_W, PVP_CELL_H } from './pvp-math.js';
import { playSlashSFX } from './battle-sfx.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { drawSlashOverlay, resetSlashScatterCache, shouldDrawSlash, SWING_HOLD_MS } from './slash-effects.js';
import { removeStatus, hasStatus, STATUS } from './status-effects.js';
import { _nameToBytes } from './text-utils.js';
import { getSpellNameClean } from './text-decoder.js';
import { queueBattleMsg, replaceBattleMsg } from './battle-msg.js';
import { BATTLE_FOE } from './data/strings.js';
import { tickHealNums, clearHealNums } from './damage-numbers.js';
import { SPELLS } from './data/spells.js';
import { drawCasterCastBehind, drawCasterCastFront, jobToCastKey, CAST_PHASE_MS_THROW } from './cast-anim.js';
import { drawCastWindup, applyMagicDamage, applyMagicStatus, applyMagicHeal,
         applyMagicCureStatus, applyMagicSight } from './combatant-cast.js';
import { getSpellAnim, getSpellAnimForItem } from './spell-anim.js';
import { drawStatusSpriteAbove } from './battle-drawing.js';
import { fakePlayerFullBodyCanvases, fakePlayerHitFullBodyCanvases,
         fakePlayerKneelFullBodyCanvases, fakePlayerVictoryFullBodyCanvases,
         fakePlayerDeathFrames } from './fake-player-sprites.js';
import { pickAttackPoseKey, pickAttackWeaponSpec, attackWeaponLayer, pickCombatantBody, IDLE_FRAME_MS } from './combatant-pose.js';

// (Opponent body pose map moved to combatant-pose.js — `pickCombatantBody('opp', key, jobIdx, palIdx)`
//  is the single source of truth for both ally portraits and opp full-bodies as of v1.7.161.)

function _cursorTileCanvas() { return ui.cursorTileCanvas; }
function _buildAndProcessNextTurn() { battleSt.turnQueue = buildTurnOrder(); processNextTurn(); }

// ── Local constants (mirrors game.js values — keep in sync) ──────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_PREFLASH_MS       = 133;
const BOSS_BOX_EXPAND_MS     = 300;
const PVP_BOX_RESIZE_MS      = 300;
const BATTLE_SHAKE_MS        = 300;
const BATTLE_DMG_SHOW_MS     = 550;
const SLASH_FRAMES           = 3;
const BOSS_ATK               = (MONSTERS.get(0xCC) || { atk: 8 }).atk;
const BATTLE_FLASH_FRAMES    = 65;
const BATTLE_FLASH_FRAME_MS  = 16.67;
const BATTLE_TEXT_STEPS      = 4;
const BATTLE_TEXT_STEP_MS    = 50;
const MONSTER_DEATH_MS       = 250;
const DEFEND_SPARKLE_FRAME_MS = 133;
const DEFEND_SPARKLE_TOTAL_MS = 533;
// Slash phase dwell unified via SWING_HOLD_MS from slash-effects.js.

// ── Mutable PVP state (imported directly by main.js) ─────────────────────────
export const pvpSt = {
  isPVPBattle:            false,
  pvpOpponent:            null,   // PLAYER_POOL entry being dueled
  pvpOpponentStats:       null,   // {hp, maxHP, atk, def, agi, level, name, palIdx, weaponId}
  pvpOpponentIsDefending: false,  // AI defend state — halves incoming player/ally damage this round
  pvpPendingTargetAlly:   -1,     // saved targeting decision during pvp-defend-anim
  pvpOpponentShakeTimer:      0,      // drives opponent left-shake on damage (mirrors battleShakeTimer)
  pvpEnemyHitResults:     [],     // pre-rolled hits for current enemy combo
  pvpEnemyHitIdx:         0,      // current hit index in enemy combo
  pvpEnemyDualWield:      false,  // true if current attacker is dual-wielding
  pvpEnemyUnarmed:        false,  // true if current attacker has no weapons (alternates R/L per OAM)
  pvpPendingAttack:       null,   // {miss, shieldBlock, dmg} — staged during pvp-enemy-slash, applied at end
  pvpPreflashDecided:     false,  // true after defend/item/attack decision made for current enemy-flash
  pvpEnemyAllies:         [],     // fake players who join opponent's side
  pvpCurrentEnemyAllyIdx:-1,      // -1 = main opponent, >=0 = pvpEnemyAllies[i]
  pvpPlayerTargetIdx:    -1,      // which enemy the player is currently fighting (-1=main opp, >=0=pvpEnemyAllies[i])
  pvpBoxResizeFromW:      0,
  pvpBoxResizeFromH:      0,
  pvpBoxResizeStartTime:  0,
  pvpEnemySlidePosFrom:   [],
  pvpDyingMap:            new Map(), // enemyIdx → startDelayMs for staggered death wipe
  // Opponent South Wind multi-target state
  _oppSWTargets:          [],       // target indices: -1=player, 0+=ally index
  _oppSWHitIdx:           0,        // current target in sequence
  _oppSWPerDmg:           0,        // pre-rolled damage per target
  _swDmgApplied:          false,    // damage applied this cycle
  _oppSWExplosionPlayed:  false,    // explosion SFX played this target
  // PVP enemy magic — mirror of ally-magic-cast / ally-magic-hit on the enemy side.
  // Cell-idx convention: 0 = main opponent, 1+ = pvpEnemyAllies[cellIdx-1].
  pvpMagicCasterCellIdx:  -1,
  pvpMagicTargetCellIdx:  -1,    // for heal/cure-status (target on enemy team)
  pvpMagicSpellId:        0,
  pvpMagicHealAmount:     0,
  pvpMagicEffectApplied:  false,
  pvpMagicSfxPlayed:      false,  // gated SFX at impact start (separate from apply timing)
  // Offensive cast — when an enemy BM/RM casts Fire / Blizzard / Sleep on the
  // player party. -1 = player, 0+ = battleAllies[idx]. Mutually exclusive
  // with pvpMagicTargetCellIdx (heal-style); whichever is set drives apply.
  pvpMagicPartyTargetIdx: -100,   // -100 = no party target; -1 = player; 0+ = ally
  pvpMagicDamageRoll:     0,
  // PVP enemy item — generalized version of the old self-only potion path.
  // Active during pvp-opp-potion. Target cell drives sparkle + heal-num placement.
  pvpItemCasterCellIdx:   -1,
  pvpItemTargetCellIdx:   -1,
  pvpItemKind:            null,    // 'potion' | 'antidote'
  pvpItemId:              -1,      // item ID (drives animation lookup via items.animSpellId)
};

// ── Shared context ────────────────────────────────────────────────────────────
// _s bag retired — direct imports + injected callbacks above
// _playSlashSFX moved to battle-sfx.js → playSlashSFX

// ── Init / teardown ───────────────────────────────────────────────────────────
export function startPVPBattle(target) {
  pvpSt.isPVPBattle             = true;
  pvpSt.pvpOpponent             = target;
  pvpSt.pvpOpponentStats        = generateAllyStats(target);
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpPendingTargetAlly    = -1;
  pvpSt.pvpOpponentShakeTimer       = 0;
  pvpSt.pvpEnemyHitResults      = [];
  pvpSt.pvpEnemyHitIdx          = 0;
  pvpSt.pvpPendingAttack        = null;
  pvpSt.pvpPreflashDecided      = false;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
  pvpSt.pvpBoxResizeStartTime   = 0;
  setEnemyHP(pvpSt.pvpOpponentStats.maxHP);
  battleSt.enemyDefeated = false;
  battleSt.isRandomEncounter = false;
  battleSt.preBattleTrack    = TRACKS.CRYSTAL_CAVE;
  battleSt.battleState  = 'flash-strobe';
  battleSt.battleTimer  = 0;
  playSFX(SFX.BATTLE_SWIPE);
  resetBattleVars();
  pauseMusic(); // pause map music now; battle track plays when box expands
}

export function resetPVPState() {
  pvpSt.isPVPBattle             = false;
  pvpSt.pvpOpponent             = null;
  pvpSt.pvpOpponentStats        = null;
  pvpSt.pvpOpponentIsDefending  = false;
  pvpSt.pvpPendingTargetAlly    = -1;
  pvpSt.pvpOpponentShakeTimer       = 0;
  pvpSt.pvpEnemyAllies          = [];
  pvpSt.pvpCurrentEnemyAllyIdx  = -1;
  pvpSt.pvpPlayerTargetIdx      = -1;
  pvpSt.pvpDyingMap             = new Map();
  pvpSt.pvpPreflashDecided      = false;
  pvpSt.pvpEnemyHitResults      = [];
  pvpSt.pvpEnemyHitIdx          = 0;
  pvpSt.pvpEnemyDualWield       = false;
  pvpSt.pvpEnemyUnarmed         = false;
  pvpSt._oppSWTargets           = [];
  pvpSt._oppSWHitIdx            = 0;
  pvpSt._oppSWPerDmg            = 0;
  pvpSt._swDmgApplied           = false;
  pvpSt._oppSWExplosionPlayed   = false;
  pvpSt.pvpMagicCasterCellIdx   = -1;
  pvpSt.pvpMagicTargetCellIdx   = -1;
  pvpSt.pvpMagicSpellId         = 0;
  pvpSt.pvpMagicHealAmount      = 0;
  pvpSt.pvpMagicEffectApplied   = false;
  pvpSt.pvpMagicPartyTargetIdx  = -100;
  pvpSt.pvpMagicDamageRoll      = 0;
  pvpSt.pvpItemCasterCellIdx    = -1;
  pvpSt.pvpItemTargetCellIdx    = -1;
  pvpSt.pvpItemKind             = null;
  pvpSt.pvpItemId               = -1;
}

// ── Ally joining ──────────────────────────────────────────────────────────────
export function tryJoinPVPEnemyAlly() {
  if (!pvpSt.isPVPBattle || pvpSt.pvpEnemyAllies.length >= 3) return false;
  const loc = getPlayerLocation();
  const inBattle = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
    ...battleSt.battleAllies.map(a => a.name),
  ]);
  const eligible = PLAYER_POOL.filter(p => p.loc === loc && !inBattle.has(p.name));
  if (eligible.length === 0 || Math.random() >= 0.3) return false;
  const pick = eligible[Math.floor(Math.random() * eligible.length)];
  const oldTotal = 1 + pvpSt.pvpEnemyAllies.length;
  const { cols: oldCols, rows: oldRows, gridPos: oldGP } = pvpGridLayout(oldTotal);
  pvpSt.pvpBoxResizeFromW = oldCols * PVP_CELL_W + 16;
  pvpSt.pvpBoxResizeFromH = oldRows * PVP_CELL_H + 16;
  const _cx = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const _cy = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  pvpSt.pvpEnemySlidePosFrom = Array.from({length: oldTotal}, (_, i) => {
    const [gr, gc] = oldGP[i] || [0, 0];
    return { x: _cx - oldCols*12 + gc*PVP_CELL_W + 4, y: _cy - oldRows*16 + gr*PVP_CELL_H + 4 };
  });
  pvpSt.pvpEnemyAllies.push(generateAllyStats(pick));
  battleSt.battleState = 'pvp-ally-appear';
  battleSt.battleTimer = 0;
  return true;
}

// ── Full PVP battle update (called from game.js updateBattle when isPVPBattle) ─
function _updatePVPOpening() {
  const bs = battleSt.battleState;
  if (bs === 'flash-strobe') {
    if (battleSt.battleTimer >= BATTLE_FLASH_FRAMES * BATTLE_FLASH_FRAME_MS) {
      battleSt.battleState = 'enemy-box-expand'; battleSt.battleTimer = 0;
      playTrack(TRACKS.BATTLE); // map music already paused in startPVPBattle
    }
  } else if (bs === 'enemy-box-expand') {
    // Skip boss-appear (land turtle) — PVP box goes straight to battle-fade-in
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) { battleSt.battleState = 'battle-fade-in'; battleSt.battleTimer = 0; }
  } else if (bs === 'battle-fade-in') {
    if (battleSt.battleTimer >= (BATTLE_TEXT_STEPS + 1) * BATTLE_TEXT_STEP_MS) { battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0; }
  } else { return false; }
  return true;
}
function _updatePVPMenuConfirm() {
  const bs = battleSt.battleState;
  if (bs === 'confirm-pause') {
    if (battleSt.battleTimer >= 150) {
      battleSt.allyJoinRound++;
      if (tryJoinPVPEnemyAlly()) return true;
      if (tryJoinPlayerAlly()) return true;
      _buildAndProcessNextTurn();
    }
  } else { return false; }
  return true;
}
function _updatePVPAllyAppear() {
  if (battleSt.battleState !== 'pvp-ally-appear') return false;
  if (battleSt.battleTimer >= PVP_BOX_RESIZE_MS) _buildAndProcessNextTurn();
  return true;
}
function _buildPVPDyingMap() {
  // Current target: main opponent (grid idx 0) or the ally the player just defeated
  const dyingIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
  pvpSt.pvpDyingMap = new Map([[dyingIdx, 0]]);
}
function _updatePVPDissolve() {
  if (battleSt.battleState !== 'pvp-dissolve') return false;
  if (pvpSt.pvpDyingMap.size === 0) _buildPVPDyingMap();
  const _maxDelay = pvpSt.pvpDyingMap.size > 0 ? Math.max(...pvpSt.pvpDyingMap.values()) : 0;
  if (battleSt.battleTimer >= MONSTER_DEATH_MS + _maxDelay) {
    pvpSt.pvpDyingMap = new Map();
    battleSt.battleTimer = 0;
    advancePVPTargetOrVictory();
  }
  return true;
}
export function updatePVPBattle(dt) {
  updateBattleTimers(dt);
  updatePoisonTick()             ||
  _updatePVPOpening()         ||
  _updatePVPMenuConfirm()     ||
  _updatePVPAllyAppear()      ||
  _updatePVPDissolve()        ||
  updateBattlePlayerAttack()     ||
  updateBattleDefendItem(dt)     ||
  updateBattleAlly(dt)           ||
  updateBattleEnemyTurn(dt) ||
  updateBattleEndSequence(dt);
}

// ── Enemy turn update ─────────────────────────────────────────────────────────
function updateBattleEnemyTurn(dt) {
  if (_processEnemyFlash()) return true;
  if (_processPVPDefendAnim()) return true;
  if (_processPVPEnemySlash()) return true;
  if (_processPVPOppPotion()) return true;
  if (_processPVPEnemyMagic(dt)) return true;
  if (_processPVPOppSWThrow()) return true;
  if (_processPVPOppSWHit()) return true;
  if (battleSt.battleState === 'enemy-attack') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'enemy-damage-show') { _processEnemyDamageShow();
  } else if (battleSt.battleState === 'pvp-second-windup') { _processPVPSecondWindup();
  } else { return false; }
  return true;
}

function _pvpAttackerSFX(weaponId) {
  const sub = weaponSubtype(weaponId);
  return (sub === 'knife' || sub === 'sword') ? SFX.KNIFE_HIT : SFX.ATTACK_HIT;
}

function _runEnemyAttack(targetAlly) {
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // (Actor name is queued at turn dispatch — battle-turn.js — so its fade-in
  // overlaps the BOSS_PREFLASH_MS window and is visible by the time the swing lands.)
  // Stage hit-by-hit combo for both player and ally targets so multi-hit attacks
  // (especially unarmed R/L alternation) actually animate per strike.
  battleSt.enemyTargetAllyIdx = targetAlly; // -1 for player, >=0 for ally
  pvpSt.pvpPendingAttack = pvpSt.pvpEnemyHitResults[0] || { miss: true, shieldBlock: false, dmg: 0, crit: false };
  const pendingCrit = pvpSt.pvpPendingAttack && pvpSt.pvpPendingAttack.crit;
  const wId = attackerStats ? attackerStats.weaponId : null;
  if (wId != null) playSlashSFX(wId, pendingCrit); else playSFX(SFX.ATTACK_HIT);
  resetSlashScatterCache();
  battleSt.battleState = 'pvp-enemy-slash'; battleSt.battleTimer = 0;
}

function _processEnemyFlash() {
  if (battleSt.battleState !== 'enemy-flash') return false;

  // On first tick of enemy-flash, decide the action for the active caster.
  // Cell 0 = main opp, 1+ = enemy allies. Mage AI (Cure/Poisona) runs for
  // ANY caster with knownSpells — this is what lets a fake-player WM/RM heal
  // teammates across the whole board (incl. casting on a downed-low ally
  // even when they're cell 1/2/3, not just self). Main-opp-specific actions
  // (defend / potion / SW-throw) stay gated below so allies don't trigger
  // the SouthWind throw or shield-defend stance.
  if (!pvpSt.pvpPreflashDecided && pvpSt.isPVPBattle) {
    pvpSt.pvpPreflashDecided = true;
    const casterCellIdx = pvpSt.pvpCurrentEnemyAllyIdx < 0
      ? 0
      : pvpSt.pvpCurrentEnemyAllyIdx + 1;
    const caster = _pvpEnemyByCellIdx(casterCellIdx);
    // Mage AI — heal an injured teammate (Cure), cure poison (Poisona),
    // or cast offensive (Fire/Blizzard/Sleep) on the player party. Heal
    // takes priority so a mage with Cure tends to stabilize the team
    // before pivoting to offense. RM with both schools naturally covers
    // both — Cure when team is hurt, BM-Lv1 otherwise.
    if (caster && Array.isArray(caster.knownSpells) && caster.knownSpells.length > 0) {
      if (_tryPVPEnemyCure(caster, casterCellIdx)) return true;
      if (_tryPVPEnemyPoisona(caster, casterCellIdx)) return true;
      if (_tryPVPEnemyOffensiveCast(caster, casterCellIdx)) return true;
    }
    // Main opp only: defend / potion / SouthWind throw decisions.
    if (pvpSt.pvpCurrentEnemyAllyIdx < 0) {
      if (Math.random() < 0.30) {
        pvpSt.pvpOpponentIsDefending = true;
        pvpSt.pvpPendingTargetAlly = -1;
        playSFX(SFX.DEFEND_HIT);
        battleSt.battleState = 'pvp-defend-anim'; battleSt.battleTimer = 0;
        return true;
      }
      const maxHP = pvpSt.pvpOpponentStats.maxHP;
      const curHP = pvpSt.pvpOpponentStats.hp;
      const heal = Math.min(50, maxHP - curHP);
      if (curHP < maxHP * 0.5 && heal > 0 && Math.random() < 0.25) {
        pvpSt.pvpOpponentStats.hp = curHP + heal;
        setEnemyHealNum({ value: heal, timer: 0 });
        playSFX(SFX.CURE);
        battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
        return true;
      }
      if (Math.random() < 0.15) {
        battleSt.battleState = 'pvp-opp-sw-throw'; battleSt.battleTimer = 0;
        return true;
      }
    }
    // Decided: will attack — fall through to windup animation
  }

  // OAM-canonical: unarmed opponents skip the wind-up wait — straight to the strike.
  const _earlyAttacker = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  const _earlyUnarmed = !!(_earlyAttacker && !isWeapon(_earlyAttacker.weaponId) && !isWeapon(_earlyAttacker.weaponL));
  if (!_earlyUnarmed && battleSt.battleTimer < BOSS_PREFLASH_MS) return false;

  // Pre-flash elapsed — resolve attack
  const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  if (livingAllies.length > 0) {
    const allyOptions = battleSt.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (ps.hp <= 0) {
      // Player dead — must target a living ally
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
    }
  }
  pvpSt.pvpOpponentIsDefending = false;

  // Roll multi-hit combo for PVP attacker
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  const atk = attackerStats ? attackerStats.atk : BOSS_ATK;
  const hitRate = attackerStats?.hitRate || BOSS_HIT_RATE;
  // Unarmed = dual fists. Single dualWield flag drives both hit count and visual alternation,
  // matching player + ally paths so we don't end up with bespoke per-call-site logic.
  const aRw = !!(attackerStats && isWeapon(attackerStats.weaponId));
  const aLw = !!(attackerStats && isWeapon(attackerStats.weaponL));
  const isUnarmed = !aRw && !aLw;
  const dualWield = (aRw && aLw) || isUnarmed;
  const potentialHits = calcPotentialHits(attackerStats?.level || 1, attackerStats?.agi || 5, dualWield);

  pvpSt.pvpEnemyHitIdx = 0;
  pvpSt.pvpEnemyDualWield = dualWield;
  pvpSt.pvpEnemyUnarmed = isUnarmed; // still needed by renderer to pick fist canvas vs blade
  const def = targetAlly >= 0 ? battleSt.battleAllies[targetAlly].def : ps.def;
  const attackerJob = JOBS[attackerStats?.jobIdx || 0] || {};
  const baseOpts = { critPct: attackerJob.critPct || 0, critBonus: attackerJob.critBonus || 0 };
  const opts = targetAlly >= 0 ? {
    // PVP enemy hits one of player's roster allies — apply that ally's shield/evade
    // (matches battle-enemy.js path for monster-vs-ally; was being skipped here so
    // ally shields and evade armor did nothing in PVP).
    ...baseOpts,
    shieldEvade: battleSt.battleAllies[targetAlly].shieldEvade || 0,
    evade: battleSt.battleAllies[targetAlly].evade || 0,
  } : {
    ...baseOpts,
    shieldEvade: getShieldEvade(ITEMS),
    evade: ps.evade,
    defendHalve: battleSt.isDefending,
    targetProtected: !!(ps.buffs && ps.buffs.protect),
  };
  const raw = rollHits(atk, def, hitRate, potentialHits, opts);
  // Map to PVP result format: { miss, shieldBlock, dmg, crit }
  pvpSt.pvpEnemyHitResults = raw.map(h => {
    if (h.shieldBlock) return { miss: false, shieldBlock: true, dmg: 0, crit: false };
    if (h.miss) return { miss: true, shieldBlock: false, dmg: 0, crit: false };
    return { miss: false, shieldBlock: false, dmg: h.damage, crit: h.crit };
  });

  _runEnemyAttack(targetAlly);
  return true;
}

function _processPVPDefendAnim() {
  if (battleSt.battleState !== 'pvp-defend-anim') return false;
  if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) processNextTurn(); // defend is the full action
  return true;
}

function _processPVPOppPotion() {
  if (battleSt.battleState !== 'pvp-opp-potion') return false;
  if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
    setEnemyHealNum(null);
    pvpSt.pvpItemCasterCellIdx = -1;
    pvpSt.pvpItemTargetCellIdx = -1;
    pvpSt.pvpItemKind = null;
    pvpSt.pvpItemId = -1;
    processNextTurn();
  }
  return true;
}

// ── PVP enemy item AI (cure potion / antidote) ──────────────────────────────
// Generalized form of the old main-opp self-only potion roll. Any caster cell
// (0=main, 1+=allies) can use one item per turn on any teammate. Priority:
// poisoned teammate (antidote) → lowest-HP teammate <50% (potion). Same
// sparkle animation as before; renders over the TARGET cell, not the caster.
function _tryPVPEnemyItem(casterCellIdx) {
  // 25% activation chance — matches the original main-opp potion rate.
  if (Math.random() >= 0.25) return false;
  // Antidote: any teammate with POISON
  for (const cellIdx of _pvpEnemyTeamCellIdxs()) {
    const t = _pvpEnemyByCellIdx(cellIdx);
    if (!t || !t.status) continue;
    if (hasStatus(t.status, STATUS.POISON)) {
      removeStatus(t.status, STATUS.POISON);
      pvpSt.pvpItemCasterCellIdx = casterCellIdx;
      pvpSt.pvpItemTargetCellIdx = cellIdx;
      pvpSt.pvpItemKind = 'antidote';
      pvpSt.pvpItemId = 0xaf;
      setEnemyHealNum({ value: 0, timer: 0, index: cellIdx });
      playSFX(SFX.CURE);
      battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
      return true;
    }
  }
  // Cure Potion: lowest-HP teammate below 50%
  let bestCellIdx = -1, bestPct = 1;
  for (const cellIdx of _pvpEnemyTeamCellIdxs()) {
    const t = _pvpEnemyByCellIdx(cellIdx);
    if (!t || !t.maxHP) continue;
    const pct = t.hp / t.maxHP;
    if (pct < bestPct) { bestPct = pct; bestCellIdx = cellIdx; }
  }
  if (bestCellIdx < 0 || bestPct >= 0.5) return false;
  const t = _pvpEnemyByCellIdx(bestCellIdx);
  const heal = Math.min(50, (t.maxHP || t.hp) - t.hp);
  if (heal <= 0) return false;
  t.hp += heal;
  pvpSt.pvpItemCasterCellIdx = casterCellIdx;
  pvpSt.pvpItemTargetCellIdx = bestCellIdx;
  pvpSt.pvpItemKind = 'potion';
  pvpSt.pvpItemId = 0xa6;
  setEnemyHealNum({ value: heal, timer: 0, index: bestCellIdx });
  playSFX(SFX.CURE);
  battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
  return true;
}

// ── PVP enemy magic AI ───────────────────────────────────────────────────────
// Mirror of _tryAllyCure / _tryAllyPoisona in battle-turn.js, scoped to the
// PVP enemy team (main opp + their allies). Cell-idx convention: 0 = main
// opponent, 1+ = pvpEnemyAllies[cellIdx-1]. Same animation pipeline as the
// ally cast (600ms windup → 1000ms hit, effect at 400ms), but the caster pose
// + flame + sparkle are rendered on the enemy side.
// Cast windup matches the player thrown-spell buildup so the BM/RM halo +
// flame size-cycle has time to play out fully (was 600 ms — truncated the
// pulse). Hit phase + effect timing unchanged.
// PVP-enemy magic timing — all derived from `CAST_PHASE_MS_THROW` to match
// the player throw pipeline byte-for-byte. See `battle-ally.js` for the full
// frame-timeline breakdown; PVP-enemy mirrors it (just with mirror=true on
// the cast windup since opponents face right).
const PVP_MAGIC_CAST_MS   = CAST_PHASE_MS_THROW.buildup;        // 800
// SFX at IMPACT START — same rule as player + ally throw paths.
const PVP_MAGIC_SFX_MS    = CAST_PHASE_MS_THROW.projectile +    // 250
                            CAST_PHASE_MS_THROW.preImpactGap;
// Effect at end of postImpactGap — burst fully plays out, beat, then damage pops.
const PVP_MAGIC_EFFECT_MS = CAST_PHASE_MS_THROW.projectile +    // 900
                            CAST_PHASE_MS_THROW.preImpactGap +
                            CAST_PHASE_MS_THROW.impact +
                            CAST_PHASE_MS_THROW.postImpactGap;
const PVP_MAGIC_HIT_MS    = PVP_MAGIC_EFFECT_MS +                // 1067
                            CAST_PHASE_MS_THROW.ret;

function _pvpEnemyByCellIdx(idx) {
  if (idx === 0) return pvpSt.pvpOpponentStats;
  return pvpSt.pvpEnemyAllies[idx - 1] || null;
}
function _pvpEnemyTeamCellIdxs() {
  const out = [];
  if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) out.push(0);
  for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
    const a = pvpSt.pvpEnemyAllies[i];
    if (a && a.hp > 0) out.push(i + 1);
  }
  return out;
}

function _tryPVPEnemyCure(caster, casterCellIdx) {
  if (!caster || !caster.knownSpells || !caster.knownSpells.includes(0x34)) return false;
  // Build candidates among living enemy teammates with maxHP set.
  const candidates = [];
  for (const cellIdx of _pvpEnemyTeamCellIdxs()) {
    const t = _pvpEnemyByCellIdx(cellIdx);
    if (!t || !t.maxHP) continue;
    candidates.push({ cellIdx, pct: t.hp / t.maxHP });
  }
  candidates.sort((a, b) => a.pct - b.pct);
  const lowest = candidates[0];
  if (!lowest || lowest.pct >= 0.6) return false;
  // Cure power 42 — same formula as ally Cure
  const mnd = caster.mnd || 5;
  const atk = Math.floor(mnd / 2) + 42;
  const heal = atk + Math.floor(Math.random() * (Math.floor(atk / 2) + 1));
  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = lowest.cellIdx;
  pvpSt.pvpMagicSpellId        = 0x34;
  pvpSt.pvpMagicHealAmount     = heal;
  pvpSt.pvpMagicEffectApplied  = false;
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameClean(0x34));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'pvp-enemy-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// PVP enemy offensive cast — BM/RM on the enemy team picks a target on the
// player party (player or living ally) and casts one of Fire/Blizzard/Sleep
// from their knownSpells list. Pre-rolls damage so the apply path can pop
// the damage number without re-rolling. Returns true when a cast was queued
// (caller should `return true` from the dispatch).
function _tryPVPEnemyOffensiveCast(caster, casterCellIdx) {
  if (!caster || !Array.isArray(caster.knownSpells)) return false;
  // Activation gate — keep casts feeling like a "sometimes" choice, not the
  // default. WMs without offensive spells fall through to attack as before.
  const offensive = caster.knownSpells.filter(s => s === 0x31 || s === 0x32 || s === 0x33);
  if (offensive.length === 0) return false;
  if (Math.random() >= 0.45) return false;
  // Pick a target on the player party — player + living roster allies. Skip
  // the player when KO'd. Random pick among the alive set for variety.
  const partyTargets = [];
  if (ps.hp > 0) partyTargets.push(-1);
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const a = battleSt.battleAllies[i];
    if (a && a.hp > 0) partyTargets.push(i);
  }
  if (partyTargets.length === 0) return false;
  const targetIdx = partyTargets[Math.floor(Math.random() * partyTargets.length)];
  const spellId = offensive[Math.floor(Math.random() * offensive.length)];
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  // Damage roll — Fire/Blizzard use INT (NES FF3 black-magic formula). RM's
  // INT is W=2 (~67% of a pure BM at the same level) so an RM-cast Fire
  // hits noticeably softer than a BM-cast Fire. Sleep is status (power=0);
  // skip the damage roll for it.
  let dmg = 0;
  if (spell.power > 0) {
    const stat = caster.int || 5;
    const baseAtk = Math.floor(stat / 2) + spell.power;
    dmg = baseAtk + Math.floor(Math.random() * (Math.floor(baseAtk / 2) + 1));
    dmg = Math.max(1, dmg);
  }
  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = -1;
  pvpSt.pvpMagicPartyTargetIdx = targetIdx;
  pvpSt.pvpMagicSpellId        = spellId;
  pvpSt.pvpMagicHealAmount     = 0;
  pvpSt.pvpMagicDamageRoll     = dmg;
  pvpSt.pvpMagicEffectApplied  = false;
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameClean(spellId));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'pvp-enemy-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

function _tryPVPEnemyPoisona(caster, casterCellIdx) {
  if (!caster || !caster.knownSpells || !caster.knownSpells.includes(0x35)) return false;
  // Priority: self → other teammates (in cell-idx order).
  let targetCellIdx = -1;
  if (caster.status && hasStatus(caster.status, STATUS.POISON)) {
    targetCellIdx = casterCellIdx;
  } else {
    for (const cellIdx of _pvpEnemyTeamCellIdxs()) {
      if (cellIdx === casterCellIdx) continue;
      const t = _pvpEnemyByCellIdx(cellIdx);
      if (!t || !t.status) continue;
      if (hasStatus(t.status, STATUS.POISON)) { targetCellIdx = cellIdx; break; }
    }
  }
  if (targetCellIdx < 0) return false;
  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = targetCellIdx;
  pvpSt.pvpMagicSpellId        = 0x35;
  pvpSt.pvpMagicHealAmount     = 0;
  pvpSt.pvpMagicEffectApplied  = false;
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameClean(0x35));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'pvp-enemy-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

function _applyPVPEnemyMagicEffect() {
  // Offensive cast on player party — Fire / Blizzard / Sleep targeting the
  // player or a roster ally. Routed via pvpMagicPartyTargetIdx (-1 = player,
  // 0+ = ally). Mutually exclusive with the heal-style path below.
  const partyIdx = pvpSt.pvpMagicPartyTargetIdx;
  if (partyIdx > -100) {
    const sid = pvpSt.pvpMagicSpellId;
    const partyTgt = partyIdx === -1 ? ps : (battleSt.battleAllies[partyIdx] || null);
    if (!partyTgt || partyTgt.hp <= 0) {
      pvpSt.pvpMagicPartyTargetIdx = -100;
      return;
    }
    // Damage / status routes through the SHARED applyMagicDamage / applyMagicStatus
    // helpers in combatant-cast.js — same pattern player + ally use. Per-role
    // callbacks handle role-specific damage-num + shake placement (player has
    // its own damage num, allies have an indexed map).
    const setDmgNum = (n) => {
      if (partyIdx === -1) setPlayerDamageNum({ ...n, timer: 0 });
      else getAllyDamageNums()[partyIdx] = { ...n, timer: 0 };
    };
    const triggerShake = () => {
      if (partyIdx === -1) battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      else battleSt.allyShakeTimer[partyIdx] = BATTLE_SHAKE_MS;
    };
    // SFX already fired at impact start (engine timer-driven); helpers don't double-fire.
    if (sid === 0x33) {
      const spell = SPELLS.get(0x33);
      applyMagicStatus(partyTgt, 'sleep', spell ? spell.hit : 15, {
        onStatusMsg: replaceBattleMsg,
        onMiss: () => setDmgNum({ miss: true }),
      });
    } else {
      const spell = SPELLS.get(sid);
      applyMagicDamage(partyTgt, pvpSt.pvpMagicDamageRoll | 0, spell, {
        onDmgNum: (dmg) => setDmgNum({ value: dmg }),
        onShake: triggerShake,
      });
    }
    // Death trigger — roster ally KO from a spell needs the same death-anim
    // hookup the SouthWind path uses (pvp.js:816). `deathTimer` drives the
    // fall/fade; pulling the turn from `turnQueue` stops the dead ally from
    // taking actions. Without this, ally HP drops to 0 but they keep standing
    // and the game still hands them turns. Player KO (partyIdx === -1) is
    // handled by the existing top-level death timer in `hudSt`, no-op here.
    if (partyIdx >= 0) {
      const ally = battleSt.battleAllies[partyIdx];
      if (ally && ally.hp <= 0 && ally.deathTimer == null) {
        ally.deathTimer = 0;
        battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === partyIdx));
      }
    }
    pvpSt.pvpMagicPartyTargetIdx = -100;
    return;
  }

  // Heal / cure-status — target on the enemy team (cell-idx). Routes through
  // the shared helpers (combatant-cast.js) — same path player + ally use.
  const target = _pvpEnemyByCellIdx(pvpSt.pvpMagicTargetCellIdx);
  if (!target) return;
  const cellIdx = pvpSt.pvpMagicTargetCellIdx;
  const onHealNum = (n) => setEnemyHealNum({ value: n, timer: 0, index: cellIdx });

  if (pvpSt.pvpMagicSpellId === 0x36) {
    applyMagicSight({ sfx: SFX.SIGHT });
    return;
  }
  if (pvpSt.pvpMagicSpellId === 0x35) {
    applyMagicCureStatus(target, STATUS.POISON, {
      sfx: SFX.CURE,
      onSparkle: () => onHealNum(0),
    });
    return;
  }
  // 0x34 Cure
  applyMagicHeal(target, pvpSt.pvpMagicHealAmount, {
    sfx: SFX.CURE,
    onHealNum,
  });
}

function _processPVPEnemyMagic(dt) {
  if (battleSt.battleState === 'pvp-enemy-magic-cast') {
    if (battleSt.battleTimer >= PVP_MAGIC_CAST_MS) {
      battleSt.battleState = 'pvp-enemy-magic-hit';
      battleSt.battleTimer = 0;
      pvpSt.pvpMagicEffectApplied = false;
      pvpSt.pvpMagicSfxPlayed = false;
    }
    return true;
  }
  if (battleSt.battleState === 'pvp-enemy-magic-hit') {
    tickHealNums(dt);
    // Impact SFX at IMPACT START — same rule as player + ally.
    if (!pvpSt.pvpMagicSfxPlayed && battleSt.battleTimer >= PVP_MAGIC_SFX_MS) {
      const sid = pvpSt.pvpMagicSpellId;
      const sfx = sid === 0x31 ? SFX.FIRE_BOOM
                : sid === 0x32 ? SFX.SW_HIT
                : sid === 0x33 ? SFX.SLEEP_PUFF
                : null;
      if (sfx != null) playSFX(sfx);
      pvpSt.pvpMagicSfxPlayed = true;
    }
    if (!pvpSt.pvpMagicEffectApplied && battleSt.battleTimer >= PVP_MAGIC_EFFECT_MS) {
      _applyPVPEnemyMagicEffect();
      pvpSt.pvpMagicEffectApplied = true;
    }
    if (battleSt.battleTimer >= PVP_MAGIC_HIT_MS) {
      clearHealNums();
      pvpSt.pvpMagicCasterCellIdx = -1;
      pvpSt.pvpMagicTargetCellIdx = -1;
      pvpSt.pvpMagicPartyTargetIdx = -100;
      pvpSt.pvpMagicSpellId = 0;
      pvpSt.pvpMagicDamageRoll = 0;
      processNextTurn();
    }
    return true;
  }
  return false;
}

function _processPVPOppSWThrow() {
  if (battleSt.battleState !== 'pvp-opp-sw-throw') return false;
  if (battleSt.battleTimer >= 250) {
    // Build target list: player + living allies
    const targets = [];
    if (ps.hp > 0) targets.push(-1);
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (battleSt.battleAllies[i].hp > 0) targets.push(i);
    }
    if (targets.length === 0) { processNextTurn(); return true; }
    // Roll damage using INT (5 + level), matching player formula (no defense calc)
    const int = 5 + (pvpSt.pvpOpponentStats.level || 1);
    const swAtk = Math.floor(int / 2) + 55;
    const swBase = Math.floor((swAtk + Math.floor(Math.random() * Math.floor(swAtk / 2 + 1))) / 2);
    pvpSt._oppSWTargets = targets;
    pvpSt._oppSWHitIdx = 0;
    pvpSt._oppSWPerDmg = Math.max(1, Math.floor(swBase / targets.length));
    pvpSt._swDmgApplied = false;
    battleSt.battleState = 'pvp-opp-sw-hit'; battleSt.battleTimer = 0;
  }
  return true;
}

function _processPVPOppSWHit() {
  if (battleSt.battleState !== 'pvp-opp-sw-hit') return false;
  const targets = pvpSt._oppSWTargets;
  if (!targets || targets.length === 0) { processNextTurn(); return true; }
  const tidx = targets[pvpSt._oppSWHitIdx];
  // At 0ms: explosion SFX
  if (!pvpSt._oppSWExplosionPlayed) {
    pvpSt._oppSWExplosionPlayed = true;
    playSFX(SFX.SW_HIT);
  }
  // At 400ms: apply damage + hit SFX
  if (battleSt.battleTimer >= 400 && !pvpSt._swDmgApplied) {
    const dmg = pvpSt._oppSWPerDmg;
    if (tidx === -1) {
      ps.hp = Math.max(0, ps.hp - dmg);
      setPlayerDamageNum({ value: dmg, timer: 0 });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      const ally = battleSt.battleAllies[tidx];
      if (ally && ally.hp > 0) {
        ally.hp = Math.max(0, ally.hp - dmg);
        getAllyDamageNums()[tidx] = { value: dmg, timer: 0 };
        battleSt.allyShakeTimer[tidx] = BATTLE_SHAKE_MS;
      }
    }
    playSFX(SFX.ATTACK_HIT);
    pvpSt._swDmgApplied = true;
  }
  // At 1100ms: next target or done
  if (battleSt.battleTimer >= 1100) {
    if (tidx === -1) setPlayerDamageNum(null);
    pvpSt._oppSWHitIdx++;
    pvpSt._swDmgApplied = false;
    pvpSt._oppSWExplosionPlayed = false;
    if (pvpSt._oppSWHitIdx < targets.length) {
      battleSt.battleTimer = 0;
    } else {
      pvpSt._oppSWTargets = [];
      pvpSt._oppSWHitIdx = 0;
      // Trigger death animations for killed allies
      for (let i = 0; i < battleSt.battleAllies.length; i++) {
        const ally = battleSt.battleAllies[i];
        if (ally.hp <= 0 && ally.deathTimer == null) {
          ally.deathTimer = 0;
          battleSt.turnQueue = battleSt.turnQueue.filter(t => !(t.type === 'ally' && t.index === i));
        }
      }
      if (isTeamWiped()) {
        battleSt.isDefending = false;
        battleSt.battleState = 'enemy-box-close';
        battleSt.battleTimer = 0;
      } else {
        processNextTurn();
      }
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (battleSt.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (isTeamWiped()) {
    battleSt.isDefending = false;
    battleSt.battleState = 'enemy-box-close';
    battleSt.battleTimer = 0;
  } else { processNextTurn(); }
}

function _processPVPSecondWindup() {
  // Hand-change inter-hit gap: hold idle for IDLE_FRAME_MS so R↔L combo transitions read cleanly,
  // THEN show the back-swing for BOSS_PREFLASH_MS (armed). Without the trailing back-swing, dual-wield
  // L-hand hits jumped straight from idle to fwd-strike — looked like the back-swing was missing.
  // Unarmed has no distinct back-swing pose, so handChange wait stays at IDLE_FRAME_MS only.
  const preflash = pvpSt.pvpEnemyUnarmed ? 0 : BOSS_PREFLASH_MS;
  const handChange = pvpSt.pvpEnemyDualWield && pvpSt.pvpEnemyHitIdx > 0;
  const requiredWait = handChange ? (IDLE_FRAME_MS + preflash) : preflash;
  if (battleSt.battleTimer < requiredWait) return;
  // Stage next pre-rolled hit from combo
  const hit = pvpSt.pvpEnemyHitResults[pvpSt.pvpEnemyHitIdx];
  pvpSt.pvpPendingAttack = hit || { miss: true, shieldBlock: false, dmg: 0, crit: false };
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // Hand selection: dual or unarmed → alternate per hit; single weapon → that hand only
  const rW = attackerStats && isWeapon(attackerStats.weaponId);
  const lW = attackerStats && isWeapon(attackerStats.weaponL);
  const isLeftHit = (rW && lW) || (!rW && !lW)
    ? (pvpSt.pvpEnemyHitIdx % 2 === 1)
    : !rW;
  const wId = isLeftHit ? (attackerStats ? attackerStats.weaponL : null) : (attackerStats ? attackerStats.weaponId : null);
  if (wId != null) playSlashSFX(wId, hit && hit.crit); else playSFX(SFX.ATTACK_HIT);
  resetSlashScatterCache();
  battleSt.battleState = 'pvp-enemy-slash'; battleSt.battleTimer = 0;
}

function _processPVPEnemySlash() {
  if (battleSt.battleState !== 'pvp-enemy-slash') return false;
  if (battleSt.battleTimer < SWING_HOLD_MS) return true;
  const pending = pvpSt.pvpPendingAttack;
  pvpSt.pvpPendingAttack = null;
  const targetAlly = battleSt.enemyTargetAllyIdx; // -1 = player, >=0 = ally
  // Apply this hit's damage immediately (sum at end for the popup number)
  if (pending && !pending.miss && !pending.shieldBlock) {
    if (targetAlly >= 0) {
      const ally = battleSt.battleAllies[targetAlly];
      if (ally) ally.hp = Math.max(0, ally.hp - pending.dmg);
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
    } else {
      ps.hp = Math.max(0, ps.hp - pending.dmg);
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    }
    if (pending.crit) battleSt.critFlashTimer = 0;
  }
  // Advance combo
  if (pvpSt.pvpEnemyHitIdx + 1 < pvpSt.pvpEnemyHitResults.length) {
    pvpSt.pvpEnemyHitIdx++;
    battleSt.battleState = 'pvp-second-windup'; battleSt.battleTimer = 0;
  } else {
    // Finalize — sum all hits into one damage number
    let totalDmg = 0, anyCrit = false, allMiss = true;
    for (const h of pvpSt.pvpEnemyHitResults) {
      if (!h.miss && !h.shieldBlock) { totalDmg += h.dmg; allMiss = false; if (h.crit) anyCrit = true; }
    }
    if (targetAlly >= 0) {
      getAllyDamageNums()[targetAlly] = allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 };
      battleSt.battleState = allMiss ? 'ally-damage-show-enemy' : 'ally-hit';
      battleSt.battleTimer = 0;
    } else {
      setPlayerDamageNum(allMiss ? { miss: true, timer: 0 } : { value: totalDmg, crit: anyCrit, timer: 0 });
      battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
    }
  }
  return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
// Mirrors game.js _drawSparkleCorners but uses ui.ctx. Wraps a 16×24 body at (sprX, sprY).
function _drawSparkleAtCorners(sprX, sprY, frame) {
  const ctx = ui.ctx;
  ctx.drawImage(frame, sprX - 8, sprY - 7);
  ctx.save(); ctx.scale(-1, 1); ctx.drawImage(frame, -(sprX + 23), sprY - 7); ctx.restore();
  ctx.save(); ctx.scale(1, -1); ctx.drawImage(frame, sprX - 8, -(sprY + 32)); ctx.restore();
  ctx.save(); ctx.scale(-1, -1); ctx.drawImage(frame, -(sprX + 23), -(sprY + 32)); ctx.restore();
}

export function drawBossSpriteBoxPVP(centerX, centerY) {
  const bs = battleSt.battleState;
  const isExpand = bs === 'enemy-box-expand';
  const isClose  = bs === 'enemy-box-close';
  const totalEnemies = 1 + pvpSt.pvpEnemyAllies.length;
  const { cols, rows, gridPos } = pvpGridLayout(totalEnemies);
  const pvpBoxW = cols * PVP_CELL_W + 16;
  const pvpBoxH = rows * PVP_CELL_H + 16;

  clipToViewport();
  ui.ctx.imageSmoothingEnabled = false;

  let drawW = pvpBoxW, drawH = pvpBoxH, resizeT = 1;
  if (isExpand) {
    const t = Math.min(battleSt.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (isClose) {
    const t = 1 - Math.min(battleSt.battleTimer / BOSS_BOX_EXPAND_MS, 1);
    drawW = Math.max(16, Math.ceil(pvpBoxW * t / 8) * 8);
    drawH = Math.max(16, Math.ceil(pvpBoxH * t / 8) * 8);
  } else if (bs === 'pvp-ally-appear') {
    resizeT = Math.min(battleSt.battleTimer / PVP_BOX_RESIZE_MS, 1);
    drawW = Math.round(pvpSt.pvpBoxResizeFromW + (pvpBoxW - pvpSt.pvpBoxResizeFromW) * resizeT);
    drawH = Math.round(pvpSt.pvpBoxResizeFromH + (pvpBoxH - pvpSt.pvpBoxResizeFromH) * resizeT);
  }
  drawBorderedBox(centerX - Math.floor(drawW / 2), centerY - Math.floor(drawH / 2), drawW, drawH, false, true);

  const visibleAllies = resizeT >= 1 ? pvpSt.pvpEnemyAllies.length : pvpSt.pvpEnemyAllies.length - 1;
  if (!isExpand && !isClose) {
    const intLeft = centerX - cols * Math.floor(PVP_CELL_W / 2);
    const intTop  = centerY - rows * Math.floor(PVP_CELL_H / 2);
    const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies.slice(0, visibleAllies)];
    allEnemies.forEach((enemy, idx) => {
      if (enemy) _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, PVP_CELL_W, PVP_CELL_H, resizeT);
    });
    // Target cursor during target-select or item-target-select
    if ((bs === 'target-select' || (bs === 'item-target-select' && inputSt.itemTargetType === 'enemy')) && _cursorTileCanvas()) {
      // Fight cursor uses pvpPlayerTargetIdx; item cursor uses itemTargetIndex (grid index directly)
      if (bs === 'item-target-select' && inputSt.itemTargetMode !== 'single') {
        // Multi-target: draw blinking cursors on all targeted enemies
        if (Math.floor(Date.now() / 133) & 1) {
          const allEnemies = [pvpSt.pvpOpponentStats, ...pvpSt.pvpEnemyAllies];
          for (let ei = 0; ei < allEnemies.length; ei++) {
            if (!allEnemies[ei] || allEnemies[ei].hp <= 0) continue;
            if (inputSt.itemTargetMode !== 'all') {
              // col mode: check if this enemy is in the target column
              const [er, ec] = gridPos[ei] || [0, 0];
              const isLeft = ec === 0;
              if (inputSt.itemTargetMode === 'col-left' && !isLeft) continue;
              if (inputSt.itemTargetMode === 'col-right' && isLeft) continue;
            }
            const [gr, gc] = gridPos[ei] || [0, 0];
            const tx = intLeft + gc * PVP_CELL_W + 4;
            const ty = intTop  + gr * PVP_CELL_H + 4;
            ui.ctx.drawImage(_cursorTileCanvas(), tx - 14, ty + 4);
          }
        }
      } else {
        const tIdx = bs === 'item-target-select'
          ? inputSt.itemTargetIndex
          : (pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1);
        const [gr, gc] = gridPos[tIdx] || gridPos[0];
        const tx = intLeft + gc * PVP_CELL_W + 4;
        const ty = intTop  + gr * PVP_CELL_H + 4;
        ui.ctx.drawImage(_cursorTileCanvas(), tx - 14, ty + 4);
      }
    }
  }
  ui.ctx.restore();
}

function _drawPVPEnemyCell(enemy, idx, gridPos, intLeft, intTop, cellW, cellH, resizeT) {
  const bs = battleSt.battleState;
  const [gr, gc] = gridPos[idx] || [0, 0];
  const targetX = intLeft + gc * cellW + 4;
  const targetY = intTop  + gr * cellH + 4;
  let sprX = targetX, sprY = targetY;
  if (bs === 'pvp-ally-appear' && pvpSt.pvpEnemySlidePosFrom[idx]) {
    const from = pvpSt.pvpEnemySlidePosFrom[idx];
    sprX = Math.round(from.x + (targetX - from.x) * resizeT);
    sprY = Math.round(from.y + (targetY - from.y) * resizeT);
  }
  const isMain = idx === 0;
  const palIdx = enemy.palIdx;
  const _ej = enemy.jobIdx || 0;
  const _fpb = (map) => (map[_ej] || map[0])[palIdx];
  const fullBody = _fpb(fakePlayerFullBodyCanvases) || (fakePlayerFullBodyCanvases[0] || [])[0];
  if (!fullBody) return;
  // Hide dead enemies — but keep visible during dissolve, attack, and magic-hit sequences.
  const isDying = pvpSt.pvpDyingMap.has(idx) && bs === 'pvp-dissolve';
  const isCurrentTarget = isMain ? pvpSt.pvpPlayerTargetIdx < 0 : (idx - 1) === pvpSt.pvpPlayerTargetIdx;
  const isBeingKilled = isCurrentTarget && (bs === 'player-slash' || bs === 'player-hit-show' ||
    bs === 'player-damage-show' || bs === 'ally-slash' || bs === 'ally-damage-show');
  // Magic-hit kills: keep this PVP cell rendered through the impact burst window
  // even after HP hits 0, so the target doesn't vanish mid-animation. Player
  // cast → check `getSpellTargets` (idx convention 0 = opponent, 1+ = enemy
  // ally idx-1). Ally cast → check `battleSt.allyMagicTargetType === 'pvp-enemy'`
  // with the same idx convention.
  const isMagicHitKill = bs === 'magic-hit' && getSpellTargets().some(t => t.type === 'enemy' && t.index === idx);
  const isAllyMagicHitKill = bs === 'ally-magic-hit' &&
    battleSt.allyMagicTargetType === 'pvp-enemy' &&
    battleSt.allyMagicTargetIdx === idx;
  const keepVisible = isDying || isBeingKilled || isMagicHitKill || isAllyMagicHitKill;
  if (isMain && (battleSt.enemyDefeated || (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp <= 0)) && !keepVisible) return;
  if (!isMain && (battleSt.enemyDefeated || enemy.hp <= 0) && !keepVisible) return;
  // Shake left when taking damage (mirrors player's right-shake on hit)
  if (isCurrentTarget && pvpSt.pvpOpponentShakeTimer > 0) {
    sprX += (Math.floor(pvpSt.pvpOpponentShakeTimer / 67) & 1) ? -2 : 2;
  }
  const isThisAttacking = isMain
    ? pvpSt.pvpCurrentEnemyAllyIdx < 0
    : pvpSt.pvpCurrentEnemyAllyIdx === idx - 1;
  // Hit pose: only during the slash impact and brief flinch — NOT the full 700ms damage display
  const playerHitLanded = bs === 'player-slash' &&
    inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss;
  const allyHitLanded = bs === 'ally-slash' && battleSt.allyHitResult && !battleSt.allyHitResult.miss;
  const playerHitShowLanded = bs === 'player-hit-show' && inputSt.hitResults && inputSt.hitResults[battleSt.currentHitIdx] && !inputSt.hitResults[battleSt.currentHitIdx].miss;
  const isOppHit = isCurrentTarget && (playerHitLanded || playerHitShowLanded || allyHitLanded ||
    (bs === 'ally-damage-show' && battleSt.allyHitResult && !battleSt.allyHitResult.miss));
  const blinkHidden = isCurrentTarget && (playerHitLanded || allyHitLanded) && (Math.floor(battleSt.battleTimer / 60) & 1);
  const isWindUp = isThisAttacking && ((bs === 'enemy-flash' && (pvpSt.pvpPreflashDecided || !isMain)) || bs === 'pvp-second-windup');
  if (blinkHidden) return;

  // Which hand is this enemy using right now?
  // Even hit index = right hand, odd = left hand (if dual-wielding)
  const isAttackState = isThisAttacking && (bs === 'enemy-attack' || bs === 'pvp-enemy-slash' || bs === 'ally-hit');
  // Hand selection: dual or unarmed → alternate per hit; single weapon → that hand only.
  // Drives off isThisAttacking (not isMain) so PVP enemy allies also alternate when unarmed.
  const eRw = enemy && isWeapon(enemy.weaponId);
  const eLw = enemy && isWeapon(enemy.weaponL);
  const altByHit = (eRw && eLw) || (!eRw && !eLw);
  const _altIsL = altByHit ? (pvpSt.pvpEnemyHitIdx % 2 === 1) : !eRw;
  const isLeftHandWind = isThisAttacking && bs === 'pvp-second-windup' && _altIsL;
  const isLeftHandAtk  = isThisAttacking && isAttackState && _altIsL;
  const activeWeaponId = (isLeftHandWind || isLeftHandAtk)
    ? (enemy.weaponL != null ? enemy.weaponL : enemy.weaponId)
    : enemy.weaponId;
  const wpn = weaponSubtype(activeWeaponId);

  // Body canvas — drawn directly (pre-h-flipped canvases face right, matching the player).
  // Mirroring rule lives in pickAttackPoseKey via mirror:true — it inverts L↔R so the swinging
  // hand renders with the opposite hand's pose tiles (visually correct after the pre-flip).
  const oppHP   = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.hp : getEnemyHP()) : (enemy.hp != null ? enemy.hp : 0);
  const oppMaxHP = isMain ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : (enemy.maxHP || 1);
  const isNearFatalOpp = oppHP > 0 && oppHP <= Math.floor(oppMaxHP / 4);
  const isOppVictory = false;
  const isOppDefending = isMain && pvpSt.pvpOpponentIsDefending && bs === 'pvp-defend-anim';
  // Caster victory pose: any cell that's the active item caster during pvp-opp-potion,
  // any cell that's the active magic caster during pvp-enemy-magic-cast/hit, OR main
  // opp during the legacy SW-throw / SW-hit paths. Mirrors the ally-magic caster pose.
  const isPotionCaster = bs === 'pvp-opp-potion' && pvpSt.pvpItemCasterCellIdx === idx;
  const isMagicCaster  = (bs === 'pvp-enemy-magic-cast' || bs === 'pvp-enemy-magic-hit') &&
                          pvpSt.pvpMagicCasterCellIdx === idx;
  const isLegacySWUse  = isMain && (bs === 'pvp-opp-sw-throw' || bs === 'pvp-opp-sw-hit');
  const isOppItemUse   = isPotionCaster || isMagicCaster || isLegacySWUse;
  // Hand-change inter-hit gap (during wind-up of a subsequent hit when hand swaps): render idle body
  // for the first IDLE_FRAME_MS only, then transition to back-swing pose for the remaining wind-up.
  const oppHandChangeGap = isWindUp && isThisAttacking && pvpSt.pvpEnemyDualWield
    && pvpSt.pvpEnemyHitIdx > 0 && battleSt.battleTimer < IDLE_FRAME_MS;
  let body = fullBody;
  if (isOppHit && _fpb(fakePlayerHitFullBodyCanvases)) {
    body = _fpb(fakePlayerHitFullBodyCanvases);
  } else if (oppHandChangeGap) {
    body = fullBody; // idle pose during the gap
  } else if (isWindUp || isAttackState) {
    // Centralized pose-pick. Mirror rule (opponent face-right pre-flipped canvas) lives in pickAttackPoseKey;
    // unarmed-no-windup rule lives there too — both render the strike pose for back & fwd phases.
    const handIsL = isWindUp ? isLeftHandWind : isLeftHandAtk;
    const key = pickAttackPoseKey({
      weaponSubtype: wpn,
      isUnarmed: !!pvpSt.pvpEnemyUnarmed,
      hand: handIsL ? 'L' : 'R',
      attackPhase: isWindUp ? 'back' : 'fwd',
      mirror: true,
    });
    body = pickCombatantBody('opp', key, _ej, palIdx) || fullBody;
  } else if (isOppDefending || isOppItemUse) {
    body = _fpb(fakePlayerVictoryFullBodyCanvases) || fullBody;
  } else if (isOppVictory && (Math.floor(Date.now() / 250) & 1)) {
    body = _fpb(fakePlayerVictoryFullBodyCanvases) || fullBody;
  } else if (isNearFatalOpp && !isOppVictory) {
    body = _fpb(fakePlayerKneelFullBodyCanvases) || fullBody;
  }

  // Opponent face-right pre-flipped canvas — pickAttackWeaponSpec returns offsets in post-flip space.
  // Suppressed entirely during the hand-change idle gap.
  const _phase = oppHandChangeGap ? null : (isWindUp ? 'back' : (isAttackState ? 'fwd' : null));
  const _handIsL = isWindUp ? isLeftHandWind : isLeftHandAtk;
  const weaponSpec = _phase ? pickAttackWeaponSpec({
    weaponId: activeWeaponId,
    weaponSubtype: wpn,
    isUnarmed: !!pvpSt.pvpEnemyUnarmed,
    hand: _handIsL ? 'L' : 'R',
    attackPhase: _phase,
    mirror: true,
    fistPalette: _jobPalette(_ej, palIdx),
    fistTimerMs: battleSt.battleTimer,
  }) : null;
  const _weaponLayer = _phase ? attackWeaponLayer({ attackPhase: _phase, hand: _handIsL ? 'L' : 'R', mirror: true }) : null;
  const drawBlade = () => {
    if (!weaponSpec) return;
    const ctx = ui.ctx;
    ctx.save();
    ctx.translate(sprX + 16, sprY);
    ctx.scale(-1, 1);
    ctx.drawImage(weaponSpec.canvas, weaponSpec.dx, weaponSpec.dy);
    ctx.restore();
  };

  // Layer: 'behind' draws before body, 'front' draws after.
  if (weaponSpec && _weaponLayer === 'behind') drawBlade();
  // Cast windup BEHIND — same `drawCastWindup` helper player + ally use.
  // mirror=true since PVP opponents face right.
  drawCastWindup('behind', ui.ctx, 'pvp-enemy', idx, sprX + 8, sprY + 12, true);
  if (isDying) {
    const delay = pvpSt.pvpDyingMap.get(idx) || 0;
    const deathFrames = _fpb(fakePlayerDeathFrames);
    if (deathFrames && deathFrames.length) {
      const progress = Math.min(Math.max(0, battleSt.battleTimer - delay) / MONSTER_DEATH_MS, 1);
      const fi = Math.min(deathFrames.length - 1, Math.floor(progress * deathFrames.length));
      ui.ctx.drawImage(deathFrames[fi], sprX, sprY);
    }
  } else {
    ui.ctx.drawImage(body, sprX, sprY);
  }
  if (weaponSpec && _weaponLayer === 'front') drawBlade();

  // Near-fatal sweat — h-flipped to match opponent facing left
  if (isNearFatalOpp && !isOppVictory && !isDying && bsc.sweatFrames && bsc.sweatFrames.length === 2) {
    const sf = bsc.sweatFrames[Math.floor(Date.now() / 133) & 1];
    const ctx = ui.ctx;
    ctx.save();
    ctx.translate(sprX + sf.width, sprY - 3);
    ctx.scale(-1, 1);
    ctx.drawImage(sf, 0, 0);
    ctx.restore();
  }

  // Status sprite — h-flipped to match the body's right-facing orientation.
  // Same single-source helper as player + ally; only the mirror flag differs.
  if (!isDying) drawStatusSpriteAbove(ui.ctx, enemy && enemy.status, sprX, sprY - 4, true);

  // Defend sparkle — 4 frames cycling over 533ms, full-body corners
  if (isOppDefending && bsc.defendSparkleFrames && bsc.defendSparkleFrames.length === 4) {
    const fi = Math.min(3, Math.floor(battleSt.battleTimer / DEFEND_SPARKLE_FRAME_MS));
    _drawSparkleAtCorners(sprX, sprY, bsc.defendSparkleFrames[fi]);
  }
  // Cure sparkle — drawn on the TARGET cell during item use AND during the hit
  // phase of an enemy magic cast. Item routes via the item's `animSpellId`
  // (declarative on the item record); magic routes by `pvpMagicSpellId` via
  // the per-spell bundle.
  const isPotionTarget = bs === 'pvp-opp-potion' && pvpSt.pvpItemTargetCellIdx === idx;
  const isMagicTarget  = bs === 'pvp-enemy-magic-hit' && pvpSt.pvpMagicTargetCellIdx === idx;
  if (isPotionTarget || isMagicTarget) {
    let _frames = null;
    if (isPotionTarget) {
      const _b = getSpellAnimForItem(pvpSt.pvpItemId);
      _frames = (_b && _b.kind === 'portrait-2frame') ? _b.frames : null;
    } else {
      const _b = getSpellAnim(pvpSt.pvpMagicSpellId);
      _frames = (_b && _b.kind === 'portrait-2frame') ? _b.frames : null;
    }
    if (!(_frames && _frames.length === 2)) _frames = bsc.cureSparkleFrames;
    if (_frames && _frames.length === 2) {
      const fi = Math.floor(battleSt.battleTimer / 67) & 1;
      _drawSparkleAtCorners(sprX, sprY, _frames[fi]);
    }
  }

  // Slash effect overlays on the current target
  if (isCurrentTarget) {
    if (bs === 'player-slash' && bsc.slashFrames && battleSt.slashFrame < SLASH_FRAMES && playerHitLanded) {
      ui.ctx.drawImage(bsc.slashFrames[battleSt.slashFrame], sprX + battleSt.slashOffX, sprY + battleSt.slashOffY);
    }
    if (bs === 'ally-slash' && allyHitLanded) {
      const ally = battleSt.battleAllies[battleSt.currentAllyAttacker];
      const isLeft = battleSt.allyHitIsLeft;
      const activeWpnId = ally ? (isLeft ? ally.weaponL : ally.weaponId) : 0;
      const aSlashF = ally ? getSlashFramesForWeapon(activeWpnId, !isLeft) : bsc.slashFramesR;
      const af = Math.min(Math.floor(battleSt.battleTimer / 30), 2);
      drawSlashOverlay(ui.ctx, aSlashF && aSlashF[af], af, sprX, sprY, { weaponId: activeWpnId || 0, hit: battleSt.allyHitResult });
    }
  }

  // Cast windup FRONT — same shared helper.
  drawCastWindup('front', ui.ctx, 'pvp-enemy', idx, sprX + 8, sprY + 12, true);
}
