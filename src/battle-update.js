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
import { sendNetPVPAction, sendNetPVPAllyJoin, getOnlinePlayerByName, getOnlineAtLocation, sendNetInvEvent,
  sendNetPvpIntent, PVP_ARBITER } from './net.js';
// v1.7.755 P-7 — arbiter intent emitter. When PVP_ARBITER is on, the
// player's menu commit routes here instead of the lockstep _emitWirePVPAction
// so the server (not the local engine) drives the next turn.
import { arbViewSt } from './pvp-arb-viewer.js';
// v1.7.756 P-8 — name strip helper for arbiter path.
import { setArbStripName } from './pvp-arb-anim.js';
import { rand } from './rng.js';
// v1.7.773 P-3 — submit pve-battle-end at natural encounter terminus so
// the server releases the battle slot. P-6 expands this into the full
// replay-validate flow (claim + intent buffer). No-op when PVE_ARBITER off.
import { pveSubmitBattleEnd, pveCurrentBattleId, pveBufferIntent, pveBuildIntent } from './pve-client.js';
import { PVE_ARBITER } from './net.js';
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
import { tryStartFenixRevive, updateFenixRevive, resetFenixRevive, isFenixReviving } from './battle-fenix-revive.js';
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
  battleSt.encounterDropItem = null; battleSt.encounterDropItemRejected = false; battleSt.bossFlashTimer = 0; battleSt.battleShakeTimer = 0;
  battleSt.isDefending = false; battleSt.battleAllies = []; battleSt.allyJoinRound = 0;
  battleSt.currentAllyAttacker = -1; battleSt.allyTargetIndex = -1; battleSt.allyHitResult = null; battleSt.allyHitIsLeft = false;
  battleSt.allyShakeTimer = {}; battleSt.enemyTargetAllyIdx = -1;
  battleSt.allyMagicCasterIdx = -1; battleSt.allyMagicTargetIdx = -1; battleSt.allyMagicSpellId = 0;
  battleSt.allyMagicHealAmount = 0; battleSt.allyMagicDamageRoll = 0;
  battleSt.allyMagicEffectApplied = false; battleSt.allyMagicSfxPlayed = false; battleSt.allyMagicTargetType = 'player';
  hudSt.playerDeathTimer = null;
  resetFenixRevive();
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
  // Seed party + room allies AT battle inception so they're on the field
  // during the intro instead of fading in after the player's first action.
  // `initial: true` keeps the state machine on 'roar-hold' and pushes
  // allies with `fadeStep = 0` (instantly visible). Round-boundary
  // reconcile + late-joiners still run at confirm-pause via the no-arg
  // call. v1.7.686 (party-system audit).
  tryJoinPlayerAlly({ initial: true });
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
    // v1.7.756 P-8 — under the arbiter, the strip cuts to the default
    // target's name when target-select opens. pvpPlayerTargetIdx
    // defaults to -1 (main opp); map to global cellId via yourSide.
    if (PVP_ARBITER && arbViewSt.inBattle && pvpSt.isPVPBattle) {
      const baseOpp = arbViewSt.yourSide === 'A' ? 4 : 0;
      const tgtIdx = pvpSt.pvpPlayerTargetIdx;
      const cellId = baseOpp + (tgtIdx < 0 ? 0 : (tgtIdx + 1));
      setArbStripName(cellId);
    }
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
  // Player death on first frame of hp=0. If a FenixDown is held,
  // tryStartFenixRevive seizes the battle into the revive sub-FSM (battleState
  // 'fenix-revive') and owns the death-anim timing itself (it holds on the
  // damage number first, then starts the fall). Without a FenixDown, start the
  // normal death animation here and let the usual box-close/respawn flow run.
  if (ps.hp <= 0 && hudSt.playerDeathTimer == null && !isFenixReviving() && battleSt.battleState !== 'none') {
    if (!tryStartFenixRevive()) hudSt.playerDeathTimer = 0;
  }
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

// `opts.initial = true` — called from `startBattle()` instead of from a
// round-boundary. Allies are pushed visible (`fadeStep = 0`) so they show
// up DURING the battle intro instead of fading in after the first turn.
// State machine is NOT touched (the intro keeps playing) and the turn
// queue isn't rebuilt (it gets built naturally when the first action
// confirms). Round-boundary calls (no opts) keep the existing fade-in
// animation + state transition. v1.7.686.
export function tryJoinPlayerAlly(opts) {
  const initial = !!(opts && opts.initial);
  const loc = getPlayerLocation();
  const pvpNames = new Set([
    pvpSt.pvpOpponent && pvpSt.pvpOpponent.name,
    ...pvpSt.pvpEnemyAllies.map(a => a.name),
  ].filter(Boolean));

  // Party members travel with you regardless of room (v1.7.594, reverses the
  // v1.7.559 room-gate). Same-room roster (non-party) is still room-scoped —
  // see the "Solo auto-assist" pass below. Held set so both reconcile + fill
  // agree.
  const partyNames = new Set(partyInviteSt.partyMembers);

  // Round-boundary reconcile (solo / co-op-AI only; the wire-PvP path below
  // is lockstep-deterministic and must not gain nondeterministic removals).
  // Drop allies who logged off — EXCEPT party members, who keep their slot
  // through brief offline blips (phone-in-pocket on mobile Safari suspends
  // the WS for tens of seconds at a time; pre-v1.7.707 those blips made
  // the partied ally pop in and out of the active battle every round).
  // Their stats are already snapshotted in `battleAllies` so they keep
  // acting on local AI until either (a) they reconnect and stay, or (b)
  // they leave the party explicitly (server `party-leave` / `party-dismiss`
  // → `partyMembers.includes(name)` becomes false and the splice fires).
  // Non-party allies still drop on offline OR room change.
  // Runs before the fill + before buildTurnOrder, so the turn queue rebuilds
  // clean. The fill below is the "join battle" half.
  if (!pvpSt.isWirePVP) {
    for (let i = battleSt.battleAllies.length - 1; i >= 0; i--) {
      const ally = battleSt.battleAllies[i];
      const isPartyAlly = partyNames.has(ally.name);
      const online = getOnlinePlayerByName(ally.name);
      if (!online) {
        if (!isPartyAlly) { battleSt.battleAllies.splice(i, 1); continue; }
        // Party member temporarily offline — keep them. They'll show as the
        // ally pose they had at their last update (no live state to refresh).
        continue;
      }
      if (!isPartyAlly && online.loc !== loc) {
        battleSt.battleAllies.splice(i, 1);
      }
    }
  }
  // Local helper — push an ally and, when called at battle inception,
  // mark them fully-visible so they don't pop in through the fade after
  // the intro finishes.
  const pushAlly = (src) => {
    const a = generateAllyStats(src);
    if (initial) a.fadeStep = 0;
    battleSt.battleAllies.push(a);
    return a;
  };

  if (battleSt.battleAllies.length >= 3) return false;

  // Pre-pass: party members get PRIORITY for the slots and join from ANY room
  // as long as they're online (v1.7.594; previously room-gated like the rest).
  // Other roster players in the same room fill the remaining slots below.
  let partyJoined = false;
  for (const name of partyInviteSt.partyMembers) {
    if (battleSt.battleAllies.length >= 3) break;
    if (pvpNames.has(name)) continue;
    if (battleSt.battleAllies.some(a => a.name === name)) continue;
    const member = getOnlinePlayerByName(name);   // live profile only — room-agnostic
    if (!member) continue;
    pushAlly(member);
    partyJoined = true;
    // Wire-PvP parity — mirror this party member onto the opponent's roster
    // (see docs/MULTIPLAYER-AUDIT-2026-05-15.md #28).
    if (pvpSt.isWirePVP && pvpSt.isPVPBattle) sendNetPVPAllyJoin(_wireAllyProfile(member));
  }
  if (battleSt.battleAllies.length >= 3) {
    if (partyJoined && !initial) { battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0; return true; }
    return partyJoined;
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
    pushAlly(picked);
    // Relay the raw ally profile so the partner runs their own
    // generateAllyStats and adds a matching `pvpEnemyAllies` cell.
    // See docs/MULTIPLAYER-AUDIT-2026-05-15.md #18.
    if (pvpSt.isPVPBattle && picked && picked.name) {
      sendNetPVPAllyJoin(_wireAllyProfile(picked));
    }
    if (!initial) { battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0; }
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
    pushAlly(p);
    roomJoined = true;
  }
  if (partyJoined || roomJoined) {
    if (!initial) { battleSt.battleState = 'ally-fade-in'; battleSt.battleTimer = 0; }
    return true;
  }
  return false;
}

// ── Menu confirm ───────────────────────────────────────────────────────────

function _updateBattleMenuConfirm() {
  if (battleSt.battleState === 'confirm-pause') {
    if (battleSt.battleTimer >= 150) {
      // v1.7.755 P-7 — arbiter path takes the menu commit FIRST so we
      // don't pre-roll legacy lockstep values (server is sole roller)
      // and don't dispatch a local turn order (server resolves round).
      // Returning early leaves battleState='confirm-pause'; the anim
      // driver (P-6c) transitions back to 'menu' after the server's
      // pvp-turn frame's deltas drain. Gated so the legacy path below
      // is untouched in production (flag false).
      if (PVP_ARBITER && pvpSt.isPVPBattle && inputSt.playerActionPending) {
        _emitWirePVPArbAction(inputSt.playerActionPending);
        inputSt.playerActionPending = null;
        // Stay in confirm-pause; the pvp-turn frame + tickArbAnim
        // will return us to 'menu'. Don't reset battleTimer — the
        // pause prevents repeat commits from a bouncing input.
        return true;
      }
      // v1.7.774 P-4 — buffer the player's intent for the PvE arbiter
      // replay log. No-op when PVE_ARBITER off or not in a server-rolled
      // encounter. `inputSt.battleActionCount` is the round counter
      // (bumped per player action below); use it as turnIdx so server
      // replay can correlate. Buffer happens BEFORE the action dispatches
      // so a fail-fast can capture even commits that crash mid-resolve.
      if (battleSt.isRandomEncounter && pveCurrentBattleId() && inputSt.playerActionPending) {
        const intent = pveBuildIntent(inputSt.playerActionPending, inputSt.battleActionCount | 0);
        if (intent) pveBufferIntent(intent);
      }
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

// v1.7.755 P-7 — translate a legacy `playerActionPending` into the
// arbiter wire shape and emit one pvp-intent. Cell-id mapping uses
// arbViewSt.yourSide:
//   yourSide='A': me=0..3, opp=4..7
//   yourSide='B': me=4..7, opp=0..3
// pending.command mapping:
//   'defend' → kind:'defend'        (no target)
//   'run'    → kind:'flee'          (server allowlists 'flee', not 'run')
//   'fight'  → kind:'attack',       targetCellId from pvpPlayerTargetIdx
//   'magic'  → kind:'magic',        spellId + targetCellId from pending.target
//   'item'   → kind:'item',         itemId  + targetCellId from pending.target
// Damage/heal pre-rolls are dropped — server is sole roller (P-3+P-4).
function _emitWirePVPArbAction(pending) {
  if (!arbViewSt.inBattle || !arbViewSt.battleId) return;
  const cmd = pending && pending.command;
  const baseMe  = arbViewSt.yourSide === 'A' ? 0 : 4;
  const baseOpp = arbViewSt.yourSide === 'A' ? 4 : 0;
  const args = { battleId: arbViewSt.battleId, turnIdx: arbViewSt.turnIdx };
  if (cmd === 'defend') { sendNetPvpIntent({ ...args, kind: 'defend' }); return; }
  if (cmd === 'run')    { sendNetPvpIntent({ ...args, kind: 'flee'   }); return; }
  if (cmd === 'fight') {
    const tgtIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
    sendNetPvpIntent({ ...args, kind: 'attack', targetCellId: baseOpp + tgtIdx });
    return;
  }
  if (cmd === 'magic' || cmd === 'item') {
    const isSelf = pending.target === 'player' && (pending.allyIndex == null || pending.allyIndex < 0);
    const isAlly = pending.target === 'player' && pending.allyIndex >= 0;
    let targetCellId;
    if (isSelf)      targetCellId = baseMe + 0;
    else if (isAlly) targetCellId = baseMe + (pending.allyIndex | 0) + 1;
    else             targetCellId = baseOpp + (typeof pending.target === 'number' ? pending.target : 0);
    if (cmd === 'magic') {
      sendNetPvpIntent({ ...args, kind: 'magic', spellId: pending.spellId, targetCellId });
    } else {
      sendNetPvpIntent({ ...args, kind: 'item',  itemId:  pending.itemId,  targetCellId });
    }
    return;
  }
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
  sendNetInvEvent('gil-delta', 0, battleSt.encounterGilGained, 'loot');   // v1.7.742 Phase 1c — PvP win gil
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
      // v1.7.775 P-6 — when PVE_ARBITER on, server applies gil via the
      // mirror after validating pve-battle-end (single writer). Skip the
      // client-side emit so the mirror doesn't double-count. Local
      // ps.gil is set by grantGil above for UI; server's inv-state push
      // (P-6 emit on `applied`) reconciles to the canonical value.
      if (!(PVE_ARBITER && pveCurrentBattleId())) {
        sendNetInvEvent('gil-delta', 0, battleSt.encounterGilGained, 'loot');
      }
      battleSt.encounterJobLevelUp = gainJobJP(inputSt.battleActionCount || 1);
      inputSt.battleActionCount = 0;
      battleSt.encounterDropItem = null;
      // Use seeded RNG (rng.js singleton) — v1.7.771 P-1. Drop roll is the
      // outcome-side fact that the upcoming PvE arbiter must replay; raw
      // Math.random would diverge between client and server replay.
      const _dropRand = rand;
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
      // Capture the bag-full case so the celebration screen can swap "Found X"
      // for "Bag is full!" — drop is forfeit (no post-battle retry), but the
      // player at least sees what happened instead of a silent zero. v1.7.689.
      battleSt.encounterDropItemRejected = false;
      if (battleSt.encounterDropItem !== null) {
        const added = addItem(battleSt.encounterDropItem, 1);
        if (added === 0) battleSt.encounterDropItemRejected = true;
        // v1.7.742 Phase 1c — only fire if the add actually landed (a
        // full-bag rejection sets `added === 0` and the mirror should
        // see no add either).
        // v1.7.775 P-6 — when PVE_ARBITER on, server applies drop via
        // the mirror after validating pve-battle-end (same gate as gil
        // above). Local addItem above keeps the UI in sync; server's
        // inv-state push reconciles. v1.7.775.
        else if (!(PVE_ARBITER && pveCurrentBattleId())) {
          sendNetInvEvent('add', battleSt.encounterDropItem, 1, 'loot');
        }
      }
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
    sendNetInvEvent('gil-delta', 0, battleSt.encounterGilGained, 'loot');   // v1.7.742 Phase 1c — boss win gil
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
      // v1.7.773 P-3 — fire pve-battle-end before the local tear-down so
      // claim builder can still read battleSt.encounter* fields. No-op
      // when PVE_ARBITER off or no active arbiter battleId.
      if (pveCurrentBattleId()) pveSubmitBattleEnd();
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
  // FenixDown auto-revive owns the FSM while active — short-circuit the normal
  // handlers so a held death can't route to game-over mid-revive.
  if (updateFenixRevive(dt)) return;
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
