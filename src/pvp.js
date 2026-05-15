// PVP duel system — state, AI logic, rendering

import { battleSt, setEnemyHP, BATTLE_TEXT_STEPS, BATTLE_TEXT_STEP_MS, setActiveCast, setEnemyAttackerTarget } from './battle-state.js';
import { getPlayerLocation } from './roster.js';
import { getAllyDamageNums, setPlayerDamageNum, setEnemyHealNum, makeHealNumCallback } from './damage-numbers.js';
import { ui } from './ui-state.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { updateBattleAlly } from './battle-ally.js';
import { resetBattleVars, isTeamWiped, updateBattleTimers, updatePoisonTick,
         updateBattlePlayerAttack, updateBattleDefendItem, updateBattleEndSequence,
         tryJoinPlayerAlly, advancePVPTargetOrVictory } from './battle-update.js';
import { playSFX, stopSFX, SFX, pauseMusic, playTrack, TRACKS } from './music.js';
import { rollHits, calcPotentialHits, BOSS_HIT_RATE, GOBLIN_HIT_RATE, summarizeHits, isLeftHandHit } from './battle-math.js';
import { reseedFromEntropy, seed as seedRng } from './rng.js';
import { setNetPVPActionHandler, sendNetPVPEnd, sendNetPVPResult } from './net.js';
import { dispatchDelta } from './deltas.js';
import { canCastBasic, canCastAny, pickHealTarget, pickPoisonedTarget,
         pickRandomLivingTarget, pickOffensiveSpell, rollOffensiveDamage,
         rollCureAmount, rollActivation,
         SPELL_CURE, SPELL_POISONA, AI_HEAL_THRESHOLD, AI_POTION_THRESHOLD,
         AI_OFFENSIVE_GATE, AI_ITEM_GATE,
         AI_PVP_DEFEND_GATE, AI_PVP_SW_GATE } from './combatant-ai.js';
import { ITEMS, isWeapon, weaponSubtype } from './data/items.js';
import { PLAYER_POOL, generateAllyStats } from './data/players.js';
import { JOBS } from './data/jobs.js';
import { MONSTERS } from './data/monsters.js';
import { ps } from './player-stats.js';
import { getShieldEvade } from './player-stats.js';
import { pvpGridLayout, PVP_CELL_W, PVP_CELL_H } from './pvp-math.js';
import { playSlashSFX } from './battle-sfx.js';
import { resetSlashScatterCache, SWING_HOLD_MS } from './slash-effects.js';
import { removeStatus, hasStatus, STATUS, blindHitPenalty, miniToadAtkMult, canCastMagic, createStatusState } from './status-effects.js';
import { _nameToBytes } from './text-utils.js';
import { getSpellNameShrinesClean } from './text-decoder.js';
import { queueBattleMsg, replaceBattleMsg } from './battle-msg.js';
import { BATTLE_FOE, BATTLE_REFLECT } from './data/strings.js';
import { hasBuff, BUFF_REFLECT } from './buffs.js';
import { tickHealNums, clearHealNums, DMG_SHOW_MS } from './damage-numbers.js';
import { SPELLS } from './data/spells.js';
import { CAST_PHASE_MS_THROW, CAST_PHASE_MS_HEAL } from './cast-anim.js';
import { applyMagicDamage, applyMagicStatus, applyMagicHeal,
         applyMagicCureStatus, applyMagicSight, playSpellImpactSFX } from './combatant-cast.js';
import { IDLE_FRAME_MS } from './combatant-pose.js';

function _cursorTileCanvas() { return ui.cursorTileCanvas; }
function _buildAndProcessNextTurn() { battleSt.turnQueue = buildTurnOrder(); processNextTurn(); }

// Single source for "PVP enemy action complete — advance turn unless the
// player team is wiped". Pre-v1.7.225 the physical-hit and SouthWind paths
// inlined this check, but the spell-cast path (`_processPVPEnemyMagic`)
// called `processNextTurn()` unconditionally — so a spell that dropped
// the player to 0 HP left the battle running until the next physical
// hit landed and caught the wipe. Route every "end of PVP-enemy action"
// site through this helper.
function _advancePVPTurnOrEnd() {
  if (isTeamWiped()) {
    battleSt.isDefending = false;
    battleSt.battleState = 'enemy-box-close';
    battleSt.battleTimer = 0;
  } else {
    processNextTurn();
  }
}

// ── Local constants (mirrors game.js values — keep in sync) ──────────────────
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_PREFLASH_MS       = 133;
const BOSS_BOX_EXPAND_MS     = 300;
const PVP_BOX_RESIZE_MS      = 300;
const BATTLE_SHAKE_MS        = 300;
const BATTLE_DMG_SHOW_MS     = 550;
const BOSS_ATK               = (MONSTERS.get(0xCC) || { atk: 8 }).atk;
const BATTLE_FLASH_FRAMES    = 65;
const BATTLE_FLASH_FRAME_MS  = 16.67;
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
// MP Step 4 part 2 + party-ally PvP — incoming opponent actions. Now a
// queue (FIFO) since party-PvP has multiple actors per side and actions
// arrive in turn order. Drained by `_processEnemyFlash` whenever a
// pvp-enemy cell takes its turn; the head of the queue must match
// `casterCellIdx === action.actor.idx`.
const _wireOpponentActions = [];
// Pending physical-attack target — `_applyWireOpponentAction` stashes this
// when kind='attack' so the existing post-preflash attack flow can read it
// instead of running the AI target-pick.
let _wirePendingAttackTargetAlly = -1;
setNetPVPActionHandler((msg) => {
  if (!pvpSt.isWirePVP) return;
  // Flee ends the battle for both sides immediately, regardless of whose
  // turn was about to fire. Short-circuit the normal queue dispatch and
  // transition straight to `enemy-box-close` (which runs `resetPVPState`
  // + reports `outcome: 'fled'` server-side). Sender's local
  // `_playerTurnRun` lands on `run-success` → same `enemy-box-close`.
  if (msg && msg.kind === 'run') {
    const oppName = pvpSt.pvpOpponent && pvpSt.pvpOpponent.name;
    queueBattleMsg(_nameToBytes((oppName ? oppName + ' fled!' : 'Foe fled!')));
    playSFX(SFX.RUN_AWAY);
    // Drain any pending wire actions — they're moot once the battle ends.
    _wireOpponentActions.length = 0;
    battleSt.battleState = 'enemy-box-close';
    battleSt.battleTimer = 0;
    return;
  }
  // Partner's WS dropped mid-battle. Server pushes this synthetic action
  // so the remaining client doesn't soft-freeze waiting for input that
  // will never come. Treat as a forced flee — no XP/Gil rewards (the
  // existing `resetPVPState` outcome logic reports `fled` since opp.hp
  // stays > 0), no opponent-died animation. v1.7.383 — pre-fix used
  // `opponentStats.hp = 0` which dropped the loser through the death
  // path and granted unearned XP.
  if (msg && msg.kind === 'disconnect') {
    const oppName = pvpSt.pvpOpponent && pvpSt.pvpOpponent.name;
    queueBattleMsg(_nameToBytes((oppName ? oppName + ' lost link' : 'Foe lost link')));
    playSFX(SFX.RUN_AWAY);
    _wireOpponentActions.length = 0;
    battleSt.battleState = 'enemy-box-close';
    battleSt.battleTimer = 0;
    return;
  }
  _wireOpponentActions.push(msg);
});

// Translate a wire target — sender's perspective — into the receiver's
// engine refs. Sender's 'me' = receiver's 'opp' (pvp-enemy cell idx).
// Sender's 'opp' = receiver's 'me' (player side; partyIdx 0=player, 1+=allyCell).
// Returns { side: 'enemy'|'player', cellIdx?, partyIdx? } where:
//   side='enemy' + cellIdx = receiver's pvp-enemy cell (0=main, 1+=pvpEnemyAllies[N-1])
//   side='player' + partyIdx = receiver's player side (-1=ps, 0+=battleAllies[N])
function _wireTargetToEngineRef(target) {
  if (!target) return { side: 'enemy', cellIdx: 0 };
  if (target.side === 'me') {
    return { side: 'enemy', cellIdx: target.idx | 0 };
  }
  // 'opp' on sender = 'me' on receiver → player side. idx 0=player, N>=1=ally(N-1).
  if (target.idx === 0) return { side: 'player', partyIdx: -1 };
  return { side: 'player', partyIdx: (target.idx | 0) - 1 };
}

export function startPVPBattle(target, opts) {
  // MP Step 4 — when both players have a server-broadcast `seed`, use it so
  // every roll (initiative / damage variance / hit / crit / AI pick) lands on
  // the same value on both clients. Falls back to local entropy for fake-PvP
  // and offline play.
  const hasSeed = opts && typeof opts.seed === 'number';
  if (hasSeed) seedRng(opts.seed);
  else reseedFromEntropy();
  // Part 2 — wire-PvP flag drives the opponent-turn FSM to wait for wire
  // actions instead of running local AI. Set whenever the server provided a
  // seed (only happens on wire-driven `pvp-match` paths).
  pvpSt.isWirePVP               = !!hasSeed;
  _wireOpponentActions.length   = 0;
  _wirePendingAttackTargetAlly  = -1;
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
  // MP party-PvP — populate pvpEnemyAllies from the wire-delivered roster.
  // The wire entries arrive in already-derived `generateAllyStats` shape so
  // they drop straight in; only `status` (omitted on send) needs to be
  // initialized fresh. Fake-PvP and 1v1 wire (no allies) fall through to
  // empty array. Cap at 2 — engine assumes ≤3 combatants per side.
  pvpSt.pvpEnemyAllies          = Array.isArray(target.allies)
    ? target.allies.slice(0, 2).map(a => ({ ...a, status: createStatusState() }))
    : [];
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
  // MP Step 4 part 2/3 — report outcome + end-of-battle to the server. The
  // partner pair clears once both sides report. Outcome is inferred from
  // the live state: opponent HP 0 = we won; player HP 0 = we lost;
  // everything else (player ran / fake-roster cancel) = fled. Safe to call
  // when not wire-PvP (the send helpers return false silently).
  if (pvpSt.isWirePVP) {
    const oppHP = pvpSt.pvpOpponentStats ? (pvpSt.pvpOpponentStats.hp | 0) : 0;
    const outcome = ps.hp <= 0 ? 'lost' : (oppHP <= 0 ? 'won' : 'fled');
    sendNetPVPResult(outcome);
    sendNetPVPEnd();
  }
  pvpSt.isWirePVP               = false;
  _wireOpponentActions.length   = 0;
  _wirePendingAttackTargetAlly  = -1;
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
  // MP wire-PvP — opponent's allies are fixed at match start from the
  // wire-delivered roster. Fake-roster joins from the local PLAYER_POOL
  // would diverge per-client (each client picks independently). Skip
  // entirely; server-arbitrated dynamic joins are a future extension.
  if (pvpSt.isWirePVP) return false;
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
function _updatePVPDissolve() {
  if (battleSt.battleState !== 'pvp-dissolve') return false;
  // pvpDyingMap is populated explicitly by every caller that transitions
  // into pvp-dissolve (spell-cast.js, battle-update.js, battle-ally.js).
  // Pre-v1.7.213 this was a lazy `_buildPVPDyingMap` fallback that read
  // `pvpPlayerTargetIdx`, which baked a single-target assumption into a
  // map data structure and would have rendered the wrong cell for any
  // future AoE that killed off-target.
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
  setEnemyAttackerTarget(attackerStats, targetAlly); // -1 for player, >=0 for ally
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
    if (pvpSt.isWirePVP) {
      // MP Step 4 part 2 — opponent is a real player. Hold the preflash state
      // until their client relays the chosen action via WS. Queue head must
      // match the current pvp-enemy cell; out-of-order delivery is a desync.
      if (_wireOpponentActions.length === 0) return false;
      const casterCellIdx = pvpSt.pvpCurrentEnemyAllyIdx < 0
        ? 0
        : pvpSt.pvpCurrentEnemyAllyIdx + 1;
      const head = _wireOpponentActions[0];
      const actorIdx = (head && head.actor && head.actor.idx) | 0;
      if (actorIdx !== casterCellIdx) {
        // Skip — wait for matching action (queue may include actions for a
        // different cell that arrived early). For strict-alternating turn
        // order this shouldn't happen; flag if it does.
        console.warn('[pvp-action] actor mismatch:',
                     'expected casterCellIdx=' + casterCellIdx,
                     'queue head actor.idx=' + actorIdx);
        return false;
      }
      const action = _wireOpponentActions.shift();
      pvpSt.pvpPreflashDecided = true;
      // _applyWireOpponentAction returns true when it transitioned to a
      // non-attack state (defend / magic / item). Returns false for 'attack'
      // — fall through to the regular attack windup, with the target stashed
      // in `_wirePendingAttackTargetAlly`.
      if (_applyWireOpponentAction(action, casterCellIdx)) return true;
    } else {
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
      // Main opp only: defend / potion / SouthWind throw decisions. Activation
      // rates pulled from `combatant-ai.js` so future balance lives in one place.
      if (pvpSt.pvpCurrentEnemyAllyIdx < 0) {
        if (rollActivation(AI_PVP_DEFEND_GATE)) {
          pvpSt.pvpOpponentIsDefending = true;
          pvpSt.pvpPendingTargetAlly = -1;
          playSFX(SFX.DEFEND_HIT);
          battleSt.battleState = 'pvp-defend-anim'; battleSt.battleTimer = 0;
          return true;
        }
        const maxHP = pvpSt.pvpOpponentStats.maxHP;
        const curHP = pvpSt.pvpOpponentStats.hp;
        const heal = Math.min(50, maxHP - curHP);
        if (curHP < maxHP * 0.5 && heal > 0 && rollActivation(AI_ITEM_GATE)) {
          pvpSt.pvpOpponentStats.hp = curHP + heal;
          setEnemyHealNum({ value: heal, timer: 0 });
          playSFX(SFX.CURE);
          battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
          return true;
        }
        if (rollActivation(AI_PVP_SW_GATE)) {
          battleSt.battleState = 'pvp-opp-sw-throw'; battleSt.battleTimer = 0;
          return true;
        }
      }
      // Decided: will attack — fall through to windup animation
    }
  }

  // OAM-canonical: unarmed opponents skip the wind-up wait — straight to the strike.
  const _earlyAttacker = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  const _earlyUnarmed = !!(_earlyAttacker && !isWeapon(_earlyAttacker.weaponId) && !isWeapon(_earlyAttacker.weaponL));
  if (!_earlyUnarmed && battleSt.battleTimer < BOSS_PREFLASH_MS) return false;

  // Pre-flash elapsed — resolve attack
  let targetAlly = -1;
  if (pvpSt.isWirePVP) {
    // Wire-driven attack — target was stashed by `_applyWireOpponentAction`.
    // Validate the picked target is still alive; if not, fall through to
    // player. (Server should send a fresh wire action on stale picks but
    // belt-and-braces here.)
    targetAlly = _wirePendingAttackTargetAlly;
    if (targetAlly >= 0) {
      const a = battleSt.battleAllies[targetAlly];
      if (!a || a.hp <= 0) targetAlly = -1;
    }
    _wirePendingAttackTargetAlly = -1;
  } else {
    const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
    if (livingAllies.length > 0) {
      const allyOptions = battleSt.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
      if (ps.hp <= 0) {
        // Player dead — must target a living ally
        targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
      } else if (Math.random() >= 1 / (1 + livingAllies.length)) {
        targetAlly = allyOptions[Math.floor(Math.random() * allyOptions.length)];
      }
    }
  }
  pvpSt.pvpOpponentIsDefending = false;

  // Roll multi-hit combo for PVP attacker
  const attackerStats = pvpSt.pvpCurrentEnemyAllyIdx >= 0
    ? pvpSt.pvpEnemyAllies[pvpSt.pvpCurrentEnemyAllyIdx]
    : pvpSt.pvpOpponentStats;
  // Apply Mini/Toad (zeroes atk) and Blind (halves hit rate) at roll time.
  // Matches player + ally path; previously skipped so PVP-enemy with these
  // statuses attacked at full effectiveness.
  const pvpAtkMult = (attackerStats && attackerStats.status) ? miniToadAtkMult(attackerStats.status) : 1;
  const pvpBlindMult = (attackerStats && attackerStats.status) ? blindHitPenalty(attackerStats.status) : 1;
  const displayAtk = (attackerStats ? attackerStats.atk : BOSS_ATK) * pvpAtkMult;
  const hitRate = (attackerStats?.hitRate || BOSS_HIT_RATE) * pvpBlindMult;
  // Unarmed = dual fists. Single dualWield flag drives both hit count and visual alternation,
  // matching player + ally paths so we don't end up with bespoke per-call-site logic.
  const aRw = !!(attackerStats && isWeapon(attackerStats.weaponId));
  const aLw = !!(attackerStats && isWeapon(attackerStats.weaponL));
  const isUnarmed = !aRw && !aLw;
  const dualWield = (aRw && aLw) || isUnarmed;
  const potentialHits = calcPotentialHits(attackerStats?.level || 1, attackerStats?.agi || 5, dualWield);
  // Per-hand ATK split (v1.7.322): attackerStats.atk is the DISPLAY sum
  // (rWpn+lWpn+str/2). Strip the weapon component to recover str/2, then add
  // each hand's own weapon ATK back. RRLL split inside rollHits via opts.lAtk
  // + splitRH. BOSS_ATK has no weapon decomposition — falls through with
  // rAtk == lAtk == displayAtk.
  const pvpRWpnAtk = aRw ? (ITEMS.get(attackerStats.weaponId)?.atk || 0) : 0;
  const pvpLWpnAtk = aLw ? (ITEMS.get(attackerStats.weaponL)?.atk || 0) : 0;
  const pvpBaseAtk = displayAtk - pvpRWpnAtk - pvpLWpnAtk;
  const pvpRAtk = pvpBaseAtk + pvpRWpnAtk;
  const pvpLAtk = pvpBaseAtk + pvpLWpnAtk;
  const pvpMainAtk = dualWield ? pvpRAtk : (aRw ? pvpRAtk : pvpLAtk);

  pvpSt.pvpEnemyHitIdx = 0;
  pvpSt.pvpEnemyDualWield = dualWield;
  pvpSt.pvpEnemyUnarmed = isUnarmed; // still needed by renderer to pick fist canvas vs blade
  const def = targetAlly >= 0 ? battleSt.battleAllies[targetAlly].def : ps.def;
  const attackerJob = JOBS[attackerStats?.jobIdx || 0] || {};
  const baseOpts = {
    critPct: attackerJob.critPct || 0,
    critBonus: attackerJob.critBonus || 0,
    lAtk: pvpLAtk,
    splitRH: dualWield,
  };
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
  const raw = rollHits(pvpMainAtk, def, hitRate, potentialHits, opts);
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
  if (!rollActivation(AI_ITEM_GATE)) return false;

  const team = _buildPVPEnemyTeam();

  // Antidote: scan team in cell-idx order, take first poisoned teammate.
  const poisoned = pickPoisonedTarget(team);
  if (poisoned) {
    const t = _pvpEnemyByCellIdx(poisoned.ref.cellIdx);
    removeStatus(t.status, STATUS.POISON);
    pvpSt.pvpItemCasterCellIdx = casterCellIdx;
    pvpSt.pvpItemTargetCellIdx = poisoned.ref.cellIdx;
    pvpSt.pvpItemKind = 'antidote';
    pvpSt.pvpItemId = 0xaf;
    setEnemyHealNum({ value: 0, timer: 0, index: poisoned.ref.cellIdx });
    playSFX(SFX.CURE);
    battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
    return true;
  }

  // Cure Potion: lowest-HP teammate below 50%.
  const wounded = pickHealTarget(team, AI_POTION_THRESHOLD);
  if (!wounded) return false;
  const t = _pvpEnemyByCellIdx(wounded.ref.cellIdx);
  const heal = Math.min(50, (t.maxHP || t.hp) - t.hp);
  if (heal <= 0) return false;
  dispatchDelta({ type: 'hp', target: t, amount: heal });
  pvpSt.pvpItemCasterCellIdx = casterCellIdx;
  pvpSt.pvpItemTargetCellIdx = wounded.ref.cellIdx;
  pvpSt.pvpItemKind = 'potion';
  pvpSt.pvpItemId = 0xa6;
  setEnemyHealNum({ value: heal, timer: 0, index: wounded.ref.cellIdx });
  playSFX(SFX.CURE);
  battleSt.battleState = 'pvp-opp-potion'; battleSt.battleTimer = 0;
  return true;
}

// MP Step 4 part 2 — translate a wire-delivered opponent action into the
// equivalent state-bag write + battleState transition that the local AI
// would have produced. Returns true if it transitioned to a non-attack
// state (defend / magic / item); false to fall through to the regular
// attack-windup flow (kind === 'attack', and any unhandled kind).
//
// `action.target` is the SENDER's perspective: 'me' = the sender's own
// player (which is the pvp-enemy on our side), 'opp' = the sender's
// opponent (which is the player on our side). For 1v1 only — ally
// targeting is a part-2.5+ extension.
function _applyWireOpponentAction(action, casterCellIdx) {
  if (!action || !action.kind) return false;
  const caster = _pvpEnemyByCellIdx(casterCellIdx);

  if (action.kind === 'run') {
    // Wire-arrival site short-circuits flee to `enemy-box-close` (see
    // `setNetPVPActionHandler`). A run action in the queue here is
    // unreachable today; if it ever shows up (out-of-order delivery,
    // race), no-op so we don't accidentally treat flee as an attack.
    return false;
  }

  if (action.kind === 'attack') {
    // Stash the wire target so the existing post-preflash attack flow
    // (`_processEnemyFlash` below) uses it instead of the AI random pick.
    // Sender's `target.side === 'opp'` → receiver's player side, where
    // idx 0 = ps (-1 in `targetAlly` convention), idx N >= 1 = ally cell N-1.
    const t = action.target;
    if (!t || t.side !== 'opp') {
      _wirePendingAttackTargetAlly = -1;
    } else if ((t.idx | 0) === 0) {
      _wirePendingAttackTargetAlly = -1;
    } else {
      _wirePendingAttackTargetAlly = (t.idx | 0) - 1;
    }
    return false;
  }

  if (action.kind === 'disconnect') {
    // Wire-arrival site short-circuits disconnect to `enemy-box-close` with
    // a "lost link" message (see `setNetPVPActionHandler`). A disconnect
    // action in the queue here is unreachable today; if it ever shows up
    // (out-of-order delivery, race), no-op so we don't accidentally treat
    // it as an attack or unearned victory.
    return false;
  }

  if (action.kind === 'defend') {
    if (casterCellIdx === 0) {
      pvpSt.pvpOpponentIsDefending = true;
      pvpSt.pvpPendingTargetAlly = -1;
    }
    playSFX(SFX.DEFEND_HIT);
    battleSt.battleState = 'pvp-defend-anim';
    battleSt.battleTimer = 0;
    return true;
  }

  if (action.kind === 'magic' && typeof action.spellId === 'number') {
    const spell = SPELLS.get(action.spellId);
    if (!spell) return false;
    // Wire target shape: { side: 'me'|'opp', idx }. After perspective swap,
    // sender's 'me' → receiver's pvp-enemy cell (cellIdx = target.idx).
    // sender's 'opp' → receiver's player side (partyIdx = target.idx === 0 ? -1 : target.idx - 1).
    const ref = _wireTargetToEngineRef(action.target);
    // Same RNG calls the AI path would have made — with synced seed, both
    // clients land on the same roll.
    let heal = 0, dmg = 0;
    if (spell.element === 'recovery' || spell.target === 'cure_status') {
      heal = (spell.power > 0) ? rollCureAmount(caster) : 0;
    } else {
      dmg = rollOffensiveDamage(caster, spell);
    }
    pvpSt.pvpMagicCasterCellIdx = casterCellIdx;
    if (ref.side === 'enemy') {
      // Same-team (pvp-enemy → pvp-enemy) — Cure / Poisona on teammate.
      pvpSt.pvpMagicTargetCellIdx  = ref.cellIdx;
      pvpSt.pvpMagicPartyTargetIdx = -1;
    } else {
      // Cross-faction (pvp-enemy → player side) — offensive cast.
      pvpSt.pvpMagicTargetCellIdx  = -1;
      pvpSt.pvpMagicPartyTargetIdx = ref.partyIdx;
    }
    pvpSt.pvpMagicSpellId        = action.spellId;
    pvpSt.pvpMagicHealAmount     = heal;
    pvpSt.pvpMagicDamageRoll     = dmg;
    pvpSt.pvpMagicEffectApplied  = false;
    setActiveCast({
      caster: { faction: 'pvp-enemy', idx: casterCellIdx },
      spellId: action.spellId,
      targets: [{
        faction: ref.side === 'enemy' ? 'pvp-enemy' : 'player',
        idx:     ref.side === 'enemy' ? ref.cellIdx : ref.partyIdx,
      }],
      healAmount: heal,
      damageRoll: dmg,
    });
    queueBattleMsg(caster?.name ? _nameToBytes(caster.name) : BATTLE_FOE);
    replaceBattleMsg(getSpellNameShrinesClean(action.spellId));
    playSFX(SFX.MAGIC_CAST);
    battleSt.battleState = 'pvp-enemy-magic-cast';
    battleSt.battleTimer = 0;
    return true;
  }

  if (action.kind === 'item') {
    // MVP — opponent's item use is a potion on themselves (match the AI's
    // existing behavior in `_tryPVPEnemyItem`). Targeted PvP item-use is a
    // part-2.5 extension.
    if (casterCellIdx === 0 && pvpSt.pvpOpponentStats) {
      const maxHP = pvpSt.pvpOpponentStats.maxHP;
      const curHP = pvpSt.pvpOpponentStats.hp;
      const heal = Math.min(50, maxHP - curHP);
      if (heal > 0) {
        pvpSt.pvpOpponentStats.hp = curHP + heal;
        setEnemyHealNum({ value: heal, timer: 0 });
      }
    }
    playSFX(SFX.CURE);
    battleSt.battleState = 'pvp-opp-potion';
    battleSt.battleTimer = 0;
    return true;
  }

  return false;
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
// PVP-enemy magic timing — derived from `CAST_PHASE_MS_THROW` (offensive,
// cross-faction) and `CAST_PHASE_MS_HEAL` (same-team, no projectile) to
// match the player + ally pipelines byte-for-byte. See `battle-ally.js` for
// the full frame-timeline breakdown; PVP-enemy mirrors it (just with
// mirror=true on the cast windup since opponents face right).
const PVP_MAGIC_CAST_MS   = CAST_PHASE_MS_THROW.buildup;        // 800

// Throw-style (offensive Fire / Bzzard / Sleep on player party) ────────────
// SFX at IMPACT START — same rule as player + ally throw paths.
const PVP_THROW_SFX_MS    = CAST_PHASE_MS_THROW.projectile +    // 250
                            CAST_PHASE_MS_THROW.preImpactGap;
// Effect at end of postImpactGap — burst fully plays out, beat, then damage pops.
const PVP_THROW_EFFECT_MS = CAST_PHASE_MS_THROW.projectile +    // 900
                            CAST_PHASE_MS_THROW.preImpactGap +
                            CAST_PHASE_MS_THROW.impact +
                            CAST_PHASE_MS_THROW.postImpactGap;
const PVP_THROW_HIT_MS    = PVP_THROW_EFFECT_MS + DMG_SHOW_MS;   // 1650

// Heal-style (same-team Cure / Poisona on opponent or PVP-enemy ally) ──────
// No projectile. Sparkle is the spell anim. Sequence: cast → preImpactGap →
// sparkle → postImpactGap → apply (heal-num + SFX) → bounce.
const PVP_HEAL_EFFECT_MS  = CAST_PHASE_MS_HEAL.preImpactGap +    // 483
                            CAST_PHASE_MS_HEAL.impact +
                            CAST_PHASE_MS_HEAL.postImpactGap;
const PVP_HEAL_HIT_MS     = PVP_HEAL_EFFECT_MS + DMG_SHOW_MS;    // 1233

// Spell IDs that route through the heal pipeline (same-team).
function _isPVPMagicHealSpell(spellId) {
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  return spell.element === 'recovery'
      || spell.target === 'ally'
      || spell.target === 'cure_status'
      || spell.target === 'revive';
}

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
  if (!canCastBasic(caster, SPELL_CURE)) return false;

  const team = _buildPVPEnemyTeam();
  const target = pickHealTarget(team, AI_HEAL_THRESHOLD);
  if (!target) return false;

  const heal = rollCureAmount(caster);
  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = target.ref.cellIdx;
  pvpSt.pvpMagicSpellId        = SPELL_CURE;
  pvpSt.pvpMagicHealAmount     = heal;
  pvpSt.pvpMagicEffectApplied  = false;
  setActiveCast({
    caster: { faction: 'pvp-enemy', idx: casterCellIdx },
    spellId: SPELL_CURE,
    targets: [{ faction: 'pvp-enemy', idx: target.ref.cellIdx }],
    healAmount: heal,
  });
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameShrinesClean(SPELL_CURE));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'pvp-enemy-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// Build the PvP-enemy team list for AI decisions. Order = main opp (cell 0)
// → enemy ally 0 → enemy ally 1 → … Each entry's ref carries `cellIdx` so
// callers can write directly into the cell-indexed state bag.
function _buildPVPEnemyTeam() {
  const team = [];
  for (const cellIdx of _pvpEnemyTeamCellIdxs()) {
    const t = _pvpEnemyByCellIdx(cellIdx);
    if (!t) continue;
    team.push({
      ref: { cellIdx },
      hp: t.hp,
      maxHP: t.maxHP,
      status: t.status,
    });
  }
  return team;
}

// Build the player-team list for PvP-enemy offensive casts. Order = player →
// ally 0 → ally 1 → … Ref carries `partyIdx` (-1 = player, 0+ = ally cell)
// which is the convention the legacy state bag (`pvpMagicPartyTargetIdx`)
// uses.
function _buildPVPPlayerTeam() {
  const team = [];
  if (ps.hp > 0) team.push({ ref: { partyIdx: -1 }, hp: ps.hp, maxHP: ps.stats?.maxHP });
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const a = battleSt.battleAllies[i];
    if (a) team.push({ ref: { partyIdx: i }, hp: a.hp, maxHP: a.maxHP });
  }
  return team;
}

// PVP enemy offensive cast — BM/RM on the enemy team picks a target on the
// player party (player or living ally) and casts one of Fire/Blizzard/Sleep
// from their knownSpells list. Pre-rolls damage so the apply path can pop
// the damage number without re-rolling. Returns true when a cast was queued
// (caller should `return true` from the dispatch).
function _tryPVPEnemyOffensiveCast(caster, casterCellIdx) {
  if (!canCastAny(caster)) return false;
  const spellId = pickOffensiveSpell(caster);
  if (!spellId) return false;
  if (!rollActivation(AI_OFFENSIVE_GATE)) return false;

  const enemies = _buildPVPPlayerTeam();
  const target = pickRandomLivingTarget(enemies);
  if (!target) return false;
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  const dmg = rollOffensiveDamage(caster, spell);

  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = -1;
  pvpSt.pvpMagicPartyTargetIdx = target.ref.partyIdx;
  pvpSt.pvpMagicSpellId        = spellId;
  pvpSt.pvpMagicHealAmount     = 0;
  pvpSt.pvpMagicDamageRoll     = dmg;
  pvpSt.pvpMagicEffectApplied  = false;
  // partyIdx convention: -1 = player, 0+ = battleAllies[i].
  const targetFaction = target.ref.partyIdx === -1 ? 'player' : 'ally';
  setActiveCast({
    caster: { faction: 'pvp-enemy', idx: casterCellIdx },
    spellId,
    targets: [{ faction: targetFaction, idx: target.ref.partyIdx }],
    damageRoll: dmg,
  });
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameShrinesClean(spellId));
  playSFX(SFX.MAGIC_CAST);
  battleSt.battleState = 'pvp-enemy-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

function _tryPVPEnemyPoisona(caster, casterCellIdx) {
  if (!canCastBasic(caster, SPELL_POISONA)) return false;

  // Priority: self → other teammates (in cell-idx order). Reorder the team
  // so self lands first; the shared picker just takes the first poisoned
  // entry it finds.
  const teamRaw = _buildPVPEnemyTeam();
  const selfEntry = teamRaw.find(t => t.ref.cellIdx === casterCellIdx);
  const others    = teamRaw.filter(t => t.ref.cellIdx !== casterCellIdx);
  const ordered   = [selfEntry, ...others].filter(Boolean);

  const target = pickPoisonedTarget(ordered);
  if (!target) return false;

  pvpSt.pvpMagicCasterCellIdx  = casterCellIdx;
  pvpSt.pvpMagicTargetCellIdx  = target.ref.cellIdx;
  pvpSt.pvpMagicSpellId        = SPELL_POISONA;
  pvpSt.pvpMagicHealAmount     = 0;
  pvpSt.pvpMagicEffectApplied  = false;
  setActiveCast({
    caster: { faction: 'pvp-enemy', idx: casterCellIdx },
    spellId: SPELL_POISONA,
    targets: [{ faction: 'pvp-enemy', idx: target.ref.cellIdx }],
  });
  queueBattleMsg(caster.name ? _nameToBytes(caster.name) : BATTLE_FOE);
  replaceBattleMsg(getSpellNameShrinesClean(SPELL_POISONA));
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
    // Reflect MVP (v1.7.214) — if the player has Reflect, block hostile
    // spell damage/status entirely. NES canon bounces to the caster's team;
    // we keep MVP scope to "full block + Reflected! message" until the
    // bounce-back targeting ships (see BUFFS-AUDIT.md #7). Allies don't
    // have buffs per buffs.js v0 scope, so only player target gates here.
    if (partyIdx === -1 && hasBuff(ps, BUFF_REFLECT)) {
      replaceBattleMsg(BATTLE_REFLECT);
      playSFX(SFX.SW_HIT);
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
  const onHealNum = makeHealNumCallback('enemy', cellIdx);

  if (pvpSt.pvpMagicSpellId === 0x36) {
    applyMagicSight({ sfx: SFX.SIGHT });
    return;
  }
  // SFX engine-driven (fires at sparkle-start in _processPVPEnemyMagic);
  // helpers no longer carry SFX.
  if (pvpSt.pvpMagicSpellId === 0x35) {
    applyMagicCureStatus(target, STATUS.POISON, {
      onSparkle: () => onHealNum(0),
    });
    return;
  }
  // 0x34 Cure
  applyMagicHeal(target, pvpSt.pvpMagicHealAmount, { onHealNum });
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
    // Heal vs throw timing — same split as `battle-ally.js`. Heal has no
    // projectile + applies later for sequential pipeline.
    //
    // SFX timing rule: every spell fires SFX at SPELL-ANIM START. Throw =
    // impact-burst start; Heal = sparkle-burst start. Engine-driven via
    // `playSpellImpactSFX`; helpers never carry SFX.
    const isHeal = _isPVPMagicHealSpell(pvpSt.pvpMagicSpellId);
    const sfxMs    = isHeal ? CAST_PHASE_MS_HEAL.preImpactGap : PVP_THROW_SFX_MS;
    const effectMs = isHeal ? PVP_HEAL_EFFECT_MS : PVP_THROW_EFFECT_MS;
    const hitMs    = isHeal ? PVP_HEAL_HIT_MS    : PVP_THROW_HIT_MS;

    if (!pvpSt.pvpMagicSfxPlayed && battleSt.battleTimer >= sfxMs) {
      const spell = SPELLS.get(pvpSt.pvpMagicSpellId);
      if (spell) playSpellImpactSFX(spell);
      pvpSt.pvpMagicSfxPlayed = true;
    }
    if (!pvpSt.pvpMagicEffectApplied && battleSt.battleTimer >= effectMs) {
      _applyPVPEnemyMagicEffect();
      pvpSt.pvpMagicEffectApplied = true;
    }
    if (battleSt.battleTimer >= hitMs) {
      clearHealNums();
      pvpSt.pvpMagicCasterCellIdx = -1;
      pvpSt.pvpMagicTargetCellIdx = -1;
      pvpSt.pvpMagicPartyTargetIdx = -100;
      pvpSt.pvpMagicSpellId = 0;
      pvpSt.pvpMagicDamageRoll = 0;
      _advancePVPTurnOrEnd();  // v1.7.225 — was processNextTurn() (skipped teamwipe → spell-kill bug)
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
      dispatchDelta({ type: 'hp', target: ps, amount: -dmg });
      setPlayerDamageNum({ value: dmg, timer: 0 });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      const ally = battleSt.battleAllies[tidx];
      if (ally && ally.hp > 0) {
        dispatchDelta({ type: 'hp', target: ally, amount: -dmg });
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
      _advancePVPTurnOrEnd();
    }
  }
  return true;
}

function _processEnemyDamageShow() {
  if (battleSt.battleTimer < BATTLE_DMG_SHOW_MS) return;
  _advancePVPTurnOrEnd();
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
  // Hand selection — RRLL pattern via `isLeftHandHit` (single source).
  const rW = attackerStats && isWeapon(attackerStats.weaponId);
  const lW = attackerStats && isWeapon(attackerStats.weaponL);
  const totalHits = pvpSt.pvpEnemyHitResults ? pvpSt.pvpEnemyHitResults.length : 0;
  const isLeftHit = isLeftHandHit(pvpSt.pvpEnemyHitIdx, totalHits, rW, lW);
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
      if (ally) dispatchDelta({ type: 'hp', target: ally, amount: -pending.dmg });
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
    } else {
      dispatchDelta({ type: 'hp', target: ps, amount: -pending.dmg });
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
    const { totalDmg, anyCrit, allMiss } = summarizeHits(pvpSt.pvpEnemyHitResults, { dmgKey: 'dmg', respectShieldBlock: true });
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
