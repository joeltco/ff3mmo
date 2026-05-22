// battle-update.js — battle state machine: opening, player attack, defend/item,
// run, boss dissolve, victory, defeat, and main updateBattle() loop.

import { battleSt, getEnemyHP, setEnemyHP, BOSS_MAX_HP,
         BATTLE_SHAKE_MS, MONSTER_DEATH_MS, BATTLE_TEXT_STEPS, BATTLE_TEXT_STEP_MS } from './battle-state.js';
import { inputSt } from './input-handler.js';
import { sprite } from './player-sprite.js';
import { battleSpeedMult } from './settings.js';
import { pvpSt, resetPVPState, updatePVPBattle } from './pvp.js';
import { hudSt } from './hud-state.js';
import { mapSt } from './map-state.js';
import { ps, grantExp, grantCP, getHitWeapon, isHitRightHand, gainJobJP, grantGil } from './player-stats.js';
import { IDLE_FRAME_MS } from './combatant-pose.js';
import { bsc, getSlashFramesForWeapon, getSlashPattern, setSlashOffsetForFrame } from './battle-sprite-cache.js';
import { SLASH_FRAME_MS, shouldDrawSlash, SWING_HOLD_MS } from './slash-effects.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { summarizeHits } from './battle-math.js';
import { reseedFromEntropy } from './rng.js';
import { sendNetPVPAction, sendNetPVPAllyJoin, getOnlinePlayerByName, getOnlineAtLocation } from './net.js';
import { rand } from './rng.js';
import { updateBattleAlly } from './battle-ally.js';
import { updateBattleEnemyTurn } from './battle-enemy.js';
import { updateSpellCast, resetSpellCastVars, prerollSpellAmount, isHealSpell } from './spell-cast.js';
import { canCastSpell } from './data/spells.js';
import { clearAllBuffs } from './buffs.js';
import { queueBattleMsg, replaceBattleMsg, updateBattleMsg as _updateBattleMsg, clearBattleMsgQueue,
         queueVictoryRewards as _queueVictoryRewards, clearVictoryPersist } from './battle-msg.js';
import { resetAllDmgNums, tickDmgNums, tickHealNums, clearHealNums,
         setEnemyDmgNum } from './damage-numbers.js';
import { playSFX, stopMusic, pauseMusic, resumeMusic, playTrack, TRACKS, SFX } from './music.js';
import { MONSTERS } from './data/monsters.js';
import { PLAYER_POOL, generateAllyStats } from './data/players.js';
import { BATTLE_ROAR, BATTLE_CANT_ESCAPE, BATTLE_CRITICAL, BATTLE_SLAIN } from './data/strings.js';
import { showMsgBox } from './message-box.js';
import { respawnAfterDeath } from './map-loading.js';
import { _nameToBytes } from './text-utils.js';
import { getPlayerLocation } from './roster.js';
import { partyInviteSt } from './party-invite.js';
import { DIR_DOWN } from './sprite.js';
import { STATUS_NAME_BYTES, canCastMagic, STATUS, clearAll as clearAllStatus } from './status-effects.js';
import { applyPhysicalHitToEnemy } from './physical-attack.js';
import { playSlashSFX } from './battle-sfx.js';
import { saveSlotsToDB } from './save-state.js';
import { addItem, buildItemSelectList } from './inventory.js';
import { startCrystalReveal } from './npc.js';

// ── Constants ──────────────────────────────────────────────────────────────
// BATTLE_TEXT_STEPS / BATTLE_TEXT_STEP_MS now imported from battle-state.js (single source).
const BATTLE_FLASH_FRAMES      = 65;
const BATTLE_FLASH_FRAME_MS    = 16.67;
const BOSS_BOX_EXPAND_MS       = 300;
const BOSS_BLOCKS              = 9;
const BOSS_DISSOLVE_STEPS      = 8;
const BOSS_DISSOLVE_FRAME_MS   = 16.67;
const MONSTER_SLIDE_MS         = 267;
// SLASH_FRAME_MS / shouldDrawSlash / SWING_HOLD_MS imported from slash-effects.js (above).
const BACK_SWING_MS            = 80;
const FWD_SWING_MS             = 80;
// Post-swing anticipation beat — body in attack pose, no slash, no damage num.
// NES holds this for 316 ms (OAM f14608 frames 50-71) before the damage popup;
// gives the strike weight before the number lands. Was 100 ms.
const HIT_PAUSE_MS             = 316;
const HIT_COMBO_PAUSE_MS       = 30;
const PLAYER_DMG_SHOW_MS       = 700;
// Brief pause between damage-show and the monster-death animation. NES holds
// 85 ms here (OAM f14608 frames 105-109) with the SP3 palette dimmed — the
// "the hit registered, now they fall" beat. Was 0 (immediate transition).
const PRE_DEATH_PAUSE_MS       = 85;
const DEFEND_SPARKLE_TOTAL_MS  = 533;
// Idle-at-menu timeout. After this much time at menu-open / target-select /
// item-pick without input, the player MISSES THEIR TURN — wire-emits skip,
// queue advances, no damage halving, no fallback AI. Same semantic on both
// the local player's clock and the peer's wire-wait window. v1.7.471 reverts
// the v1.7.469 5s-auto-defend experiment back to the original design.
const TURN_TIME_MS             = 10000;
const VICTORY_BOX_ROWS         = 8;
const VICTORY_ROW_FRAME_MS     = 16.67;
const POISON_TICK_MS           = 500;
const POISON_END_HOLD_MS       = 700;

// ── Exported utilities ─────────────────────────────────────────────────────

export function resetBattleVars() {
  inputSt.battleCursor = 0;
  resetAllDmgNums();
  battleSt.encounterDropItem = null; battleSt.bossFlashTimer = 0; battleSt.battleShakeTimer = 0;
  battleSt.isDefending = false; battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
  battleSt.currentAllyAttacker = -1; battleSt.allyTargetIndex = -1; battleSt.allyHitResult = null; battleSt.allyHitIsLeft = false;
  battleSt.allyShakeTimer = {}; battleSt.enemyTargetAllyIdx = -1;
  battleSt.allyMagicCasterIdx = -1; battleSt.allyMagicTargetIdx = -1; battleSt.allyMagicSpellId = 0;
  battleSt.allyMagicHealAmount = 0; battleSt.allyMagicDamageRoll = 0;
  battleSt.allyMagicEffectApplied = false; battleSt.allyMagicSfxPlayed = false; battleSt.allyMagicTargetType = 'player';
  hudSt.playerDeathTimer = null;
  // Buffs are battle-bound — wipe haste/protect/reflect so each battle starts
  // clean. When per-ally / per-enemy buffs ship, clear those here too.
  clearAllBuffs(ps);
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
  reseedFromEntropy();
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
    // Slot 1: Defend for non-mages, Magic for mages (jobs 3/4/5).
    const isMage = ps.jobIdx === 3 || ps.jobIdx === 4 || ps.jobIdx === 5;
    // Filter to spells the current job can actually cast (school gate).
    // E.g., a White Mage carrying Fire from a previous BM stint won't see
    // Fire in their battle menu — RM sees both.
    // v1.7.447 — open the magic submenu even when the filtered list is
    // empty. "No spells" panel renders instead of silently falling through
    // to Defend (mages don't have Defend in FF3 canon).
    const castableKnown = (ps.knownSpells || []).filter(id => canCastSpell(ps.jobIdx, id));
    if (isMage) {
      // Silence gate — Silenced player can't pick Magic. SFX.ERROR + "Silenced"
      // strip; cursor stays on the slot so the player can re-pick or arrow over
      // to Item / Run. Items + Defend still work (NES: Silence only blocks
      // MP-cost spell casts, not items).
      if (ps.status && !canCastMagic(ps.status)) {
        playSFX(SFX.ERROR);
        replaceBattleMsg(STATUS_NAME_BYTES[STATUS.SILENCE]);
        return;
      }
      playSFX(SFX.CONFIRM);
      inputSt.menuMode = 'magic';
      inputSt.spellSelectList = castableKnown;
      inputSt.itemHeldIdx = -1;
      inputSt.itemPage = 1;
      inputSt.itemPageCursor = 0;
      inputSt.itemSlideDir = 0;
      inputSt.itemSlideCursor = 0;
      battleSt.battleState = 'item-menu-out';
      battleSt.battleTimer = 0;
    } else {
      // Defend
      playSFX(SFX.CONFIRM);
      battleSt.isDefending = true;
      inputSt.playerActionPending = { command: 'defend' };
      battleSt.battleState = 'confirm-pause';
      battleSt.battleTimer = 0;
    }
  } else if (index === 2) {
    // Item
    playSFX(SFX.CONFIRM);
    inputSt.menuMode = 'item';
    inputSt.itemSelectList = buildItemSelectList();
    inputSt.itemHeldIdx = -1;
    inputSt.itemPage = 1;
    inputSt.itemPageCursor = 0;
    inputSt.itemSlideDir = 0;
    inputSt.itemSlideCursor = 0;
    battleSt.battleState = 'item-menu-out';
    battleSt.battleTimer = 0;
  } else {
    // Run — allowed in random encounters AND in PvP (the boss fight is the
    // only no-flee case left). PvP flee in `_playerTurnRun` always succeeds
    // since rolling against the opponent's AGI would diverge across clients
    // (each AGI is on its own side).
    if (battleSt.isRandomEncounter || pvpSt.isPVPBattle) {
      playSFX(SFX.CONFIRM);
      battleSt.isDefending = false;
      inputSt.playerActionPending = { command: 'run' };
      battleSt.battleState = 'confirm-pause';
      battleSt.battleTimer = 0;
    } else {
      playSFX(SFX.ERROR);
      queueBattleMsg(BATTLE_CANT_ESCAPE);
      // Menu stays open; strip drains on its own clock.
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
}

function _updateTurnTimer(dt) {
  const isPlayerDeciding = battleSt.battleState === 'menu-open' || battleSt.battleState === 'target-select' ||
    battleSt.battleState === 'item-select' || battleSt.battleState === 'item-target-select' || battleSt.battleState === 'item-slide';
  if (!isPlayerDeciding) return;
  battleSt.turnTimer += dt;
  if (battleSt.turnTimer >= TURN_TIME_MS) {
    battleSt.turnTimer = 0; inputSt.itemHeldIdx = -1;
    // Miss the turn — wire-emits skip, queue advances, no animation, no
    // damage halving. Matches the "you snooze you lose" design.
    inputSt.playerActionPending = { command: 'skip' };
    battleSt.battleState = 'confirm-pause'; battleSt.battleTimer = 0;
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
  // Pre-pass: invited party members auto-join — no random roll, no
  // location check (party members travel with the player, unlike the
  // random ally pool which only pulls from roster at the current loc).
  // Per-battle stats regenerate via generateAllyStats (same as random
  // allies), so death in a previous fight doesn't disqualify them.
  // Cap respected. v1.7.235.
  let partyJoined = false;
  for (const name of partyInviteSt.partyMembers) {
    if (battleSt.battleAllies.length >= 3) break;
    if (pvpNames.has(name)) continue;
    if (battleSt.battleAllies.some(a => a.name === name)) continue;
    // Lookup order (most → least fresh):
    //   1. getOnlinePlayerByName — live wire profile from the partner if
    //      they're currently online. Picks up any level-up / equipment
    //      swap since the invite was accepted.
    //   2. partyMemberProfiles  — cache from accept time, used while the
    //      partner is briefly missing during a reconnect.
    //   3. PLAYER_POOL          — fake-roster fallback; empty by default.
    //      Pre-v1.7.418 this was first; a fake sharing a real player's
    //      name would override live data if PLAYER_POOL was repopulated.
    const member = getOnlinePlayerByName(name)
                || partyInviteSt.partyMemberProfiles.get(name)
                || PLAYER_POOL.find(p => p.name === name);
    if (!member) continue;
    const allyStats = generateAllyStats(member);
    battleSt.battleAllies.push(allyStats);
    partyJoined = true;
    // Wire-PvP — mirror this party member onto the opponent's `pvpEnemyAllies`.
    // Pre-v1.7.387 only the random-fill branch sent `pvp-ally-join`; party
    // members never reached the wire, so the opponent saw 1 fewer combatant
    // and turn queues forked. See docs/MULTIPLAYER-AUDIT-2026-05-15.md #28.
    if (pvpSt.isWirePVP && pvpSt.isPVPBattle) {
      sendNetPVPAllyJoin(_wireAllyProfile(member));
    }
  }
  if (battleSt.battleAllies.length >= 3) {
    if (partyJoined) { battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0; return true; }
    return false;
  }
  // ── Wire-PvP ally fill (unchanged — lockstep-critical) ───────────────
  // Both clients must roll identically, so this stays a deterministic
  // single-pick from the shared PLAYER_POOL via `rand()` and relays the
  // pick over the wire. Do NOT fold the solo auto-assist below into this
  // branch — `pvp-wire-sim` #18 asserts this exact behavior.
  if (pvpSt.isWirePVP) {
    const eligible = PLAYER_POOL.filter(p =>
      p.loc === loc &&
      !battleSt.battleAllies.some(a => a.name === p.name) &&
      !pvpNames.has(p.name)
    );
    const roll = rand();
    if (eligible.length === 0 || roll >= 0.5) {
      if (partyJoined) { battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0; return true; }
      return false;
    }
    const pickIdx = Math.floor(rand() * eligible.length);
    const picked = eligible[pickIdx];
    battleSt.battleAllies.push(generateAllyStats(picked));
    // Relay the raw ally profile so the partner runs their own
    // generateAllyStats and adds a matching `pvpEnemyAllies` cell.
    // See docs/MULTIPLAYER-AUDIT-2026-05-15.md #18.
    if (pvpSt.isPVPBattle && picked && picked.name) {
      sendNetPVPAllyJoin(_wireAllyProfile(picked));
    }
    battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0;
    return true;
  }

  // ── Solo auto-assist: real roster players in the room help out ───────
  // Every real online player at the current location joins as a local-AI
  // ally using their exact broadcast build — generateAllyStats's realized-
  // stats fast path consumes the wire profile verbatim (jobIdx, atk/def/
  // evade/mdef, equipment, knownSpells, jobLevel). Like the fake-player
  // system, but with real player data. No random gate — whoever's in the
  // room helps, up to the 3-ally cap (the party pre-pass may have taken
  // slots already). Self is never in the roster (net.js excludes
  // _myUserId), so no clone. Enemy AI still targets the whole team. v1.7.503.
  let roomJoined = false;
  for (const p of getOnlineAtLocation(loc)) {
    if (battleSt.battleAllies.length >= 3) break;
    if (!p || !p.name) continue;
    if (battleSt.battleAllies.some(a => a.name === p.name)) continue;
    if (pvpNames.has(p.name)) continue;
    battleSt.battleAllies.push(generateAllyStats(p));
    roomJoined = true;
  }
  if (partyJoined || roomJoined) {
    battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0;
    return true;
  }
  return false;
}

// ── Menu confirm ───────────────────────────────────────────────────────────

function _updateBattleMenuConfirm() {
  if (battleSt.battleState === 'confirm-pause') {
    if (battleSt.battleTimer >= 150) {
      // Pre-roll magic damage/heal BEFORE wire emit so the wire payload
      // carries the rolled value. Without this, receivers apply 0 (no
      // wire field → `action.healAmount | 0 = 0`) while sender's
      // spell-cast rolls a real value at apply time → damage-number +
      // HP desync across phones. Sender's `startSpellCast` consumes the
      // pre-rolled amount via `opts.preRolledAmount`, skipping its own
      // roll so neither side double-consumes rand(). Items don't need
      // pre-rolling — heal/damage values come from item.power (no RNG).
      if (pvpSt.isWirePVP && inputSt.playerActionPending) {
        const pending = inputSt.playerActionPending;
        if (pending.command === 'magic' && pending.preRolledAmount == null) {
          pending.preRolledAmount = prerollSpellAmount(pending.spellId) | 0;
        }
      }
      // MP Step 4 part 2 — relay the player's action to the wire partner
      // BEFORE turn dispatch fires animations, so the partner's client has
      // time to drive their opponent-side turn without an extra wait.
      if (pvpSt.isWirePVP && inputSt.playerActionPending) {
        _emitWirePVPAction(inputSt.playerActionPending);
      }
      battleSt.allyJoinRound++;
      if (tryJoinPlayerAlly()) return true;
      battleSt.turnQueue = buildTurnOrder(); processNextTurn();
    }
  } else { return false; }
  return true;
}


// Pluck the fields `generateAllyStats` needs out of an ally source object
// (PLAYER_POOL entry, online roster snapshot, partyMemberProfile cache, or
// the derived `battleAllies` shape). Receiver runs its own
// `generateAllyStats(profile)` on this payload — output matches the
// sender's local push because the stat formulas are deterministic on these
// inputs.
function _wireAllyProfile(src) {
  if (!src) return null;
  return {
    name:        src.name,
    jobIdx:      src.jobIdx | 0,
    level:       src.level | 0,
    palIdx:      src.palIdx | 0,
    loc:         src.loc,
    weaponR:     src.weaponR != null ? src.weaponR : (src.weaponId != null ? src.weaponId : null),
    weaponL:     src.weaponL,
    armorId:     src.armorId,
    helmId:      src.helmId,
    shieldId:    src.shieldId,
    knownSpells: Array.isArray(src.knownSpells) ? src.knownSpells.slice() : [],
    jobLevel:    src.jobLevel | 0,
  };
}

// Translate the local player's `inputSt.playerActionPending` into the wire
// action shape and emit. Wire shape (party-PvP):
//   actor:  { idx }            — sender's actor cell (0 = main player; 1+ = ally on sender's side)
//   target: { side, idx }      — 'me' = sender's player side, 'opp' = sender's opponent side;
//                                idx 0 = main, 1+ = ally cell
// Receiver swaps `side` and uses idx unchanged.
// Exported so the PvP-only menu-confirm path (`updatePVPBattle` in pvp.js)
// can reach it — `updateBattle` early-returns to `updatePVPBattle` when
// `pvpSt.isPVPBattle` is true, so the in-house `_updateBattleMenuConfirm`
// caller below is unreachable in PvP and the wire emit has to live there too.
export function emitWirePVPAction(pending) { _emitWirePVPAction(pending); }
function _emitWirePVPAction(pending) {
  const cmd = pending && pending.command;
  const actor = { idx: 0 };  // local player is always the sender's main actor.
  if (cmd === 'defend') { sendNetPVPAction({ kind: 'defend', actor }); return; }
  if (cmd === 'run')    { sendNetPVPAction({ kind: 'run',    actor }); return; }
  if (cmd === 'fight') {
    // pvpPlayerTargetIdx convention: -1 = main opp, N >= 0 = pvpEnemyAllies[N].
    const tgtIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
    // hitResults rides the wire (same defense as the magic damageRoll). The
    // sender pre-rolled hits inside `_battlePlayerAttackConfirm` against the
    // shared seed, but by the time the receiver runs the opponent-attack path
    // their `rand()` cursor has been advanced by their own pre-roll, so a
    // local re-roll lands on different numbers → HP desync. Shipping the
    // sender's rolls keeps damage values identical across clients.
    sendNetPVPAction({
      kind: 'attack',
      actor,
      target: { side: 'opp', idx: tgtIdx },
      hitResults: pending.hitResults || null,
    });
    return;
  }
  if (cmd === 'magic' || cmd === 'item') {
    // For player-target spells/items: pending.target='player'; pending.allyIndex
    // = -1 (self) or N (ally N). For offensive: pending.target is the 0-based
    // enemy cell idx (0=main opp, 1+=pvpEnemyAllies).
    const isSelf = pending.target === 'player'
      && (pending.allyIndex == null || pending.allyIndex < 0);
    const isAlly = pending.target === 'player' && pending.allyIndex >= 0;
    let target;
    if (isSelf)      target = { side: 'me',  idx: 0 };
    else if (isAlly) target = { side: 'me',  idx: pending.allyIndex + 1 };
    else             target = { side: 'opp', idx: typeof pending.target === 'number' ? pending.target : 0 };
    if (cmd === 'magic') {
      // Magic damage/heal is pre-rolled at confirm-pause (see
      // `_updateBattleMenuConfirm`) so the wire carries the value
      // alongside spellId. Without this, receiver's `_applyAllyMagicEffect`
      // reads `action.healAmount | 0 = 0` and renders 0 heal / 1 damage.
      const amt = pending.preRolledAmount | 0;
      const healKey = isHealSpell(pending.spellId);
      const extra = (amt > 0)
        ? (healKey ? { healAmount: amt } : { damageRoll: amt })
        : {};
      sendNetPVPAction({ kind: 'magic', spellId: pending.spellId, actor, target, ...extra });
    } else {
      sendNetPVPAction({ kind: 'item',  itemId:  pending.itemId,  actor, target });
    }
    return;
  }
}

// ── Player attack chain ────────────────────────────────────────────────────

function _finalizeComboHits() {
  const { totalDmg, anyCrit, allMiss, hitsLanded } = summarizeHits(inputSt.hitResults);
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
    setSlashOffsetForFrame(battleSt, handWeapon, 0);
    battleSt.battleState = 'attack-back';
    battleSt.battleTimer = 0;
  } else {
    _finalizeComboHits();
  }
}

function _updatePlayerAttackBack() {
  if (battleSt.battleState !== 'attack-back') return false;
  if (battleSt.currentHitIdx === 0) battleSt.comboStatusInflicted = 0;
  // Within the same hand: just back-swing → forward, no idle break (HIT_COMBO_PAUSE_MS).
  // At hand change (R→L or L→R): idle pose break so the new hand's swing reads as its own.
  // First hit of the round: full back-swing wind-up (skipped for fists).
  const handChange = battleSt.currentHitIdx > 0 &&
    isHitRightHand(battleSt.currentHitIdx, inputSt.rHandHitCount) !==
    isHitRightHand(battleSt.currentHitIdx - 1, inputSt.rHandHitCount);
  const isUnarmed = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount) === 0;
  // Every hit gets a full back-swing (BACK_SWING_MS). Hand change inserts an idle pose
  // first. Fists skip the back-swing entirely — punches go straight to forward strike.
  const delay = handChange ? IDLE_FRAME_MS
              : (isUnarmed ? 0 : BACK_SWING_MS);
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
  const handWeapon = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
  const hit = inputSt.hitResults[battleSt.currentHitIdx];
  const drawSlash = shouldDrawSlash(hit);
  if (drawSlash) {
    const pattern = getSlashPattern(handWeapon);
    const frame = Math.floor(battleSt.battleTimer / SLASH_FRAME_MS);
    if (frame !== battleSt.slashFrame && frame < pattern.totalFrames) {
      battleSt.slashFrame = frame;
      // Only re-set offset on hold-window boundaries (matches NES single-roll-per-hit
      // for impact weapons and per-frame stepping for bladed).
      if (frame % pattern.holdFrames === 0) setSlashOffsetForFrame(battleSt, handWeapon, frame);
    }
  }
  if (battleSt.battleTimer >= SWING_HOLD_MS) {
    if (drawSlash) {
      const wpnId = getHitWeapon(battleSt.currentHitIdx, inputSt.rHandHitCount);
      applyPhysicalHitToEnemy(hit, inputSt.targetIndex, { weaponId: wpnId });
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

function _updatePlayerDamageShow() {
  if (battleSt.battleState !== 'player-damage-show') return false;
  if (battleSt.battleTimer >= PLAYER_DMG_SHOW_MS) {
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters && battleSt.encounterMonsters[inputSt.targetIndex].hp <= 0) {
      replaceBattleMsg(BATTLE_SLAIN);
      battleSt.battleState = 'pre-monster-death';
      battleSt.battleTimer = 0;
    } else if (!battleSt.isRandomEncounter && getEnemyHP() <= 0) {
      replaceBattleMsg(BATTLE_SLAIN);
      if (pvpSt.isPVPBattle) {
        // Explicit dying-cell map; getEnemyHP() returned 0 for the player's
        // currently-targeted cell, so derive cellIdx from pvpPlayerTargetIdx.
        const cellIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
        pvpSt.pvpDyingMap = new Map([[cellIdx, 0]]);
        battleSt.battleState = 'pvp-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.MONSTER_DEATH);
      } else { battleSt.battleState = 'boss-dissolve'; battleSt.battleTimer = 0; playSFX(SFX.BOSS_DEATH); }
    } else {
      processNextTurn();
    }
  }
  return true;
}

// Brief beat between damage-show and the death cascade — NES dims SP3 then
// rolls the death anim, giving the kill a "settle" moment instead of snapping
// straight from number → particles. Random-encounter path only; PVP/boss
// dissolve transitions stay immediate (their dissolve effect handles its own
// pre-anim breath).
function _updatePreMonsterDeath() {
  if (battleSt.battleState !== 'pre-monster-death') return false;
  if (battleSt.battleTimer >= PRE_DEATH_PAUSE_MS) {
    battleSt.dyingMonsterIndices = new Map([[inputSt.targetIndex, 0]]);
    battleSt.battleState = 'monster-death';
    battleSt.battleTimer = 0;
    playSFX(SFX.MONSTER_DEATH);
  }
  return true;
}

export function updateBattlePlayerAttack() {
  return _updatePlayerAttackBack() ||
         _updatePlayerAttackFwd() ||
         _updatePlayerSlash() ||
         _updatePlayerHitShow() ||
         _updatePlayerDamageShow() ||
         _updatePreMonsterDeath() ||
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
  // KO'd player: no rewards, no victory flow — straight to box-close (→ respawn).
  if (ps.hp <= 0) {
    battleSt.encounterExpGained = 0; battleSt.encounterGilGained = 0; battleSt.encounterCpGained = 0;
    battleSt.encounterDropItem = null; battleSt.encounterJobLevelUp = false;
    battleSt.enemyDefeated = true;
    battleSt.isDefending = false;
    battleSt.battleState = 'enemy-box-close';
    battleSt.battleTimer = 0;
    return;
  }
  const oppLv = pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.level : 1;
  const rawPvpExp = 5 * oppLv;
  grantExp(rawPvpExp);
  battleSt.encounterExpGained = Math.max(1, Math.floor(rawPvpExp / 4));
  battleSt.encounterGilGained = Math.max(1, Math.floor(10 * oppLv / 4));
  battleSt.encounterCpGained = Math.max(1, Math.floor(oppLv / 4)); grantCP(battleSt.encounterCpGained);
  grantGil(battleSt.encounterGilGained);
  battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
  inputSt.battleActionCount = 0;
  // PvP wins don't drop items. Null any leftover drop from a prior monster
  // encounter so `cp-fade-out`'s `encounterDropItem !== null` branch doesn't
  // route the FSM through a phantom `item-text-in` → `item-hold` state (which
  // would render no item text since the drop is from a different fight, and
  // sit waiting for a Z press that the player has no visual reason to make).
  // v1.7.411.
  battleSt.encounterDropItem = null;
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
      // If the player is KO'd, skip rewards AND the victory flow entirely — drop straight to
      // box-close so the battle HUD closes cleanly, then respawn.
      if (ps.hp <= 0) {
        battleSt.encounterExpGained = 0;
        battleSt.encounterGilGained = 0;
        battleSt.encounterCpGained = 0;
        battleSt.encounterDropItem = null;
        battleSt.encounterJobLevelUp = false;
        battleSt.isDefending = false;
        battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close';
        battleSt.battleTimer = 0;
        return true;
      }
      const rawExp = battleSt.encounterMonsters.reduce((sum, m) => sum + m.exp, 0);
      grantExp(rawExp);
      battleSt.encounterExpGained = Math.max(1, Math.floor(rawExp / 4));
      battleSt.encounterGilGained = Math.max(1, Math.floor(battleSt.encounterMonsters.reduce((sum, m) => sum + (m.gil || 0), 0) / 4));
      battleSt.encounterCpGained = Math.max(1, Math.floor(battleSt.encounterMonsters.reduce((sum, m) => sum + (m.cp || 1), 0) / 4)); grantCP(battleSt.encounterCpGained);
      grantGil(battleSt.encounterGilGained);
      battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
      inputSt.battleActionCount = 0;
      battleSt.encounterDropItem = null;
      const _dropRand = Math.random;
      for (const m of battleSt.encounterMonsters) {
        const mData = MONSTERS.get(m.monsterId);
        // Filter null drops first — ROM-extracted drop tables include null placeholder
        // slots (Sahagin/Lamia all-null, several bosses end with null). Without this,
        // a null roll would still claim the encounter's drop slot via `break` and
        // silently zero out subsequent mobs' chances.
        const validDrops = mData?.drops?.filter(d => d != null) || [];
        if (validDrops.length && _dropRand() < 0.25) {
          battleSt.encounterDropItem = validDrops[Math.floor(_dropRand() * validDrops.length)];
          break;
        }
      }
      if (battleSt.encounterDropItem !== null) addItem(battleSt.encounterDropItem, 1);
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
      processNextTurn();
    }
  } else if (battleSt.battleState === 'item-use') {
    tickHealNums(dt);
    if (battleSt.battleTimer >= DEFEND_SPARKLE_TOTAL_MS) {
      clearHealNums();
      processNextTurn();
    }
  } else if (battleSt.battleState === 'magic-cast' || battleSt.battleState === 'magic-hit') {
    return updateSpellCast(dt);
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
    processNextTurn();
    return true;
  }
  if (battleSt.battleState === 'run-success') {
    battleSt.runSlideBack = true;
    // PvP uses `enemy-box-close` (cleans up via `resetPVPState`); random
    // encounters use `encounter-box-close`. Same visual close, different
    // cleanup path.
    battleSt.battleState = pvpSt.isPVPBattle ? 'enemy-box-close' : 'encounter-box-close';
    battleSt.battleTimer = 0;
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
    // Land Turtle → Wind Crystal: keep the overworld sprite and flip it into
    // the blink→crystal reveal. It blinks once the battle HUD exits (updateNpcs
    // only ticks in the overworld), then morphs to the standing crystal. The
    // turtle still respawns on map reload (re-fightable), see map-loading.
    startCrystalReveal();
    ps.unlockedJobs |= 0x3E; // Wind Crystal: bits 1-5 (Warrior, Monk, White Mage, Black Mage, Red Mage)
    // KO'd player: skip rewards and victory, straight to box-close (→ respawn).
    if (ps.hp <= 0) {
      battleSt.encounterExpGained = 0; battleSt.encounterGilGained = 0; battleSt.encounterCpGained = 0;
      battleSt.encounterDropItem = null; battleSt.encounterJobLevelUp = false;
      battleSt.isDefending = false;
      battleSt.battleState = 'enemy-box-close';
      battleSt.battleTimer = 0;
      return true;
    }
    const _bossData = MONSTERS.get(0xCC);
    const rawBossExp = _bossData?.exp || 132;
    grantExp(rawBossExp);
    battleSt.encounterExpGained = Math.max(1, Math.floor(rawBossExp / 4));
    battleSt.encounterGilGained = Math.max(1, Math.floor((_bossData?.gil || 500) / 4));
    grantGil(battleSt.encounterGilGained);
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
    if (battleSt.battleTimer >= _textMs) { clearVictoryPersist(); battleSt.battleState = 'victory-menu-fade'; battleSt.battleTimer = 0; }
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

function _respawnAtLastTown() {
  hudSt.playerDeathTimer = null;
  ps.hp = ps.stats ? ps.stats.maxHP : 28;
  ps.mp = ps.stats ? ps.stats.maxMP : 0;
  // Revive = clean state. Status flags don't carry through death (NES canon
  // + SAVE-STATE-AUDIT.md #5). Pre-v1.7.216 a player who died poisoned
  // would respawn full-HP but still poisoned, taking damage at next battle.
  if (ps.status) clearAllStatus(ps.status);
  respawnAfterDeath();
  saveSlotsToDB();
}

function _updateBoxClose() {
  if (battleSt.battleState === 'encounter-box-close') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) {
      const playerDead = ps.hp <= 0;
      battleSt.runSlideBack = false;
      sprite.setDirection(DIR_DOWN); battleSt.isRandomEncounter = false; battleSt.encounterMonsters = null;
      battleSt.dyingMonsterIndices = new Map(); battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
      stopMusic();
      battleSt.battleState = 'none'; battleSt.battleTimer = 0;
      if (playerDead) _respawnAtLastTown();
      else resumeMusic();
    }
    return true;
  }
  if (battleSt.battleState === 'enemy-box-close') {
    if (battleSt.battleTimer >= BOSS_BOX_EXPAND_MS) {
      const wasPVP = pvpSt.isPVPBattle;
      const playerDead = ps.hp <= 0;
      resetPVPState();
      sprite.setDirection(DIR_DOWN);
      battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
      battleSt.battleState = 'none'; battleSt.battleTimer = 0;
      if (playerDead) {
        stopMusic();
        _respawnAtLastTown();
      } else if (!wasPVP) playTrack(TRACKS.CRYSTAL_ROOM);
      else resumeMusic();
    }
    return true;
  }
  return false;
}

export function updateBattleEndSequence(dt) {
  return _updateBossDissolve(dt) || _updateVictorySequence() || _updateBoxClose();
}

// ── Poison tick ────────────────────────────────────────────────────────────

export function updatePoisonTick() {
  const bs = battleSt.battleState;
  if (bs === 'poison-tick') {
    // Confused-self-hit hold (battle-turn.js confused branch). Keeps shake +
    // hit-pose; resumes the turn queue.
    if (battleSt.battleTimer >= POISON_TICK_MS) processNextTurn();
    return true;
  }
  if (bs === 'poison-end-tick') {
    // End-of-round multi-actor poison: hold long enough for the damage-num
    // bounce (DMG_SHOW_MS=550ms) to land, then open the menu.
    if (battleSt.battleTimer >= POISON_END_HOLD_MS) {
      battleSt.battleState = 'menu-open';
      battleSt.battleTimer = 0;
    }
    return true;
  }
  return false;
}
const _updatePoisonTick = updatePoisonTick;

// ── Main update ────────────────────────────────────────────────────────────

export function updateBattle(dt) {
  if (battleSt.battleState === 'none') return;
  // Battle Speed (Options): scale the whole battle clock so timers, message
  // holds, and animations all pace together. Solo-only — PvP/co-op are disabled,
  // so there's no wire-sync that depends on wall-clock dt here.
  dt = dt * battleSpeedMult();
  battleSt.battleTimer += Math.min(dt, 33);
  _updateBattleMsg(dt);
  if (pvpSt.isPVPBattle) { updatePVPBattle(dt); return; }
  updateBattleTimers(dt);
  _updatePoisonTick()              ||
  _updateBattleOpening()           ||
  _updateBattleMenuConfirm()       ||
  updateBattlePlayerAttack()       ||
  updateBattleDefendItem(dt)       ||
  _updateBattleRun()               ||
  updateBattleAlly(dt)             ||
  updateBattleEnemyTurn()          ||
  updateBattleEndSequence(dt);
}
