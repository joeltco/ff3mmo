// Battle turn order + turn dispatch — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP, BATTLE_SHAKE_MS, BOSS_DEF, BOSS_MAX_HP, setActiveCast } from './battle-state.js';
import { rollHits, calcPotentialHits, rollInitiative, resolveLivingTarget } from './battle-math.js';
import { rand, seed as seedRng } from './rng.js';
import { dequeueWireEncounterAction } from './encounter-wire.js';
import { getMyUserId } from './net.js';
import { BATTLE_RAN_AWAY, BATTLE_CANT_ESCAPE, BATTLE_ALLY } from './data/strings.js';
import { getMonsterName, getSpellNameShrinesClean, getItemNameShrinesClean } from './text-decoder.js';
import { ps, getJobLevelStatBonus } from './player-stats.js';
import { JOBS } from './data/jobs.js';
import { ITEMS, isWeapon, isBladedWeapon } from './data/items.js';
import { SFX, playSFX } from './music.js';
import { processTurnStart, removeStatus, STATUS, blindHitPenalty, hasStatus, STATUS_NAME_TO_FLAG, miniToadAtkMult, canCastMagic } from './status-effects.js';
import { bsc, getSlashFramesForWeapon } from './battle-sprite-cache.js';
import { pvpSt } from './pvp.js';
import { inputSt } from './input-handler.js';
import { queueBattleMsg, replaceBattleMsg } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';
import { getAllyDamageNums, setEnemyDmgNum, setEnemyHealNum, setPlayerDamageNum, setPlayerHealNum, setSwDmgNum } from './damage-numbers.js';
import { startSpellCast } from './spell-cast.js';
import { applyMagicHeal } from './combatant-cast.js';
import { dispatchDelta } from './deltas.js';
import { sendNetPVPAction } from './net.js';
import { SPELLS, tagCasterCastTime } from './data/spells.js';
import { selectCursor, saveSlots, saveSlotsToDB } from './save-state.js';
import { removeItem } from './inventory.js';
import { canCastBasic, canCastAny, pickHealTarget, pickPoisonedTarget,
         pickRandomLivingTarget, pickOffensiveSpell, rollOffensiveDamage,
         rollCureAmount, rollActivation,
         SPELL_CURE, SPELL_POISONA, AI_HEAL_THRESHOLD, AI_POTION_THRESHOLD,
         AI_OFFENSIVE_GATE, AI_ITEM_GATE } from './combatant-ai.js';
import { markFilling as _atbMarkFilling, markActing as _atbMarkActing } from './atb.js';
import { emitAtbFillingSync } from './encounter-wire.js';
import { sendNetPVPAtbSync } from './net.js';

function _sendPVPAtbSync(unitKind, allyIdx, atMs, castTimeRa) {
  sendNetPVPAtbSync({
    unitKind,
    allyIdx: allyIdx | 0,
    atMs: Number(atMs),
    castTimeRa: Math.max(0, Math.min(99, (castTimeRa | 0) || 0)),
  });
}

function _playerName() { return saveSlots[selectCursor]?.name || null; }

// ── Turn order ─────────────────────────────────────────────────────────────
// For wire-PvP, the push order is critical: both clients must call
// `rollInitiative` for the same logical actor first, otherwise the rand cursor
// (synced via per-turn reseed in `pvp.js#_buildAndProcessNextTurn`) lands on
// a different actor's priority on each side and the resulting sort produces
// divergent turn orders. `pvpSt._wirePushOppFirst` is set at battle start so
// the "higher-userId" client swaps its ps↔opp push order, making both clients
// agree to roll "lower userId" first. v1.7.409.
export function buildTurnOrder() {
  const actors = [];
  const swap = !!(pvpSt.isPVPBattle && pvpSt.isWirePVP && pvpSt._wirePushOppFirst);
  const _pushPlayer = () => {
    if (ps.hp > 0) {
      const playerAgi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
      actors.push({ type: 'player', priority: rollInitiative(playerAgi) });
    }
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      if (battleSt.battleAllies[i].hp > 0)
        actors.push({ type: 'ally', index: i, priority: rollInitiative(battleSt.battleAllies[i].agi) });
    }
  };
  // Co-op random encounter — push ps + battleAllies in canonical order
  // (host's userId first, then ascending userId) so every client rolls
  // initiative for the same logical actor against the shared rand cursor.
  // Mirror of pvpSt._wirePushOppFirst's canonical-side rule (v1.7.409).
  // Without this, A's `_pushPlayer` pushes ps=A then ally=B, while B's
  // pushes ps=B then ally=A — same cursor calls, different actors → forks.
  const _pushPlayerCoop = () => {
    const myUid = getMyUserId() | 0;
    const team = [];
    if (ps.hp > 0) {
      const playerAgi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
      team.push({ type: 'player', index: -1, userId: myUid, agi: playerAgi });
    }
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      const a = battleSt.battleAllies[i];
      if (!a || a.hp <= 0) continue;
      // Skip allies missing userId — they're AI-driven (legacy fake
      // pool) and don't belong in the canonical-by-userId sort. They'd
      // collide at userId=0 and produce unstable ordering between
      // clients. Defensive guard; PLAYER_POOL random-fill is gated off
      // in co-op so this shouldn't fire in practice. v1.7.424.
      if (!a.userId) continue;
      team.push({ type: 'ally', index: i, userId: a.userId | 0, agi: a.agi });
    }
    const hostUid = battleSt.encounterHostUserId | 0;
    team.sort((x, y) => {
      const xHost = x.userId === hostUid ? 0 : 1;
      const yHost = y.userId === hostUid ? 0 : 1;
      if (xHost !== yHost) return xHost - yHost;
      return x.userId - y.userId;
    });
    for (const c of team) {
      const entry = { type: c.type, priority: rollInitiative(c.agi) };
      if (c.type === 'ally') entry.index = c.index;
      actors.push(entry);
    }
  };
  const _pushOpp = () => {
    if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) {
      actors.push({ type: 'enemy', index: -1, pvpAllyIdx: -1, priority: rollInitiative(pvpSt.pvpOpponentStats.agi) });
    }
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      if (pvpSt.pvpEnemyAllies[i].hp > 0) {
        actors.push({ type: 'enemy', index: -1, pvpAllyIdx: i, priority: rollInitiative(pvpSt.pvpEnemyAllies[i].agi) });
      }
    }
  };
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    if (battleSt.isWireEncounter) _pushPlayerCoop();
    else                          _pushPlayer();
    for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
      if (battleSt.encounterMonsters[i].hp > 0) {
        actors.push({ type: 'enemy', index: i, priority: rollInitiative(battleSt.encounterMonsters[i].agi) });
      }
    }
  } else if (pvpSt.isPVPBattle) {
    if (swap) { _pushOpp(); _pushPlayer(); }
    else      { _pushPlayer(); _pushOpp(); }
  } else {
    _pushPlayer();
    // Boss has no agi field; agi=0 → priority is just the rand roll (0..255).
    actors.push({ type: 'enemy', index: -1, priority: rollInitiative(0) });
  }
  actors.sort((a, b) => b.priority - a.priority);
  return actors;
}

// Co-op random encounter — per-turn rand reseed (mirror of PvP's
// `_buildAndProcessNextTurn`). Both clients converge to the same cursor
// at each new round before any rolls happen, erasing any drift from
// non-wire rand consumers (status / AI / etc) earlier in the previous
// round. Called from the menu-confirm bridge in `battle-update.js` and
// from the ps-dead end-of-round path in `processNextTurn` below.
export function maybeReseedCoopTurn() {
  if (!battleSt.isWireEncounter || !battleSt.encounterSeed) return;
  battleSt.encounterTurnIndex = (battleSt.encounterTurnIndex | 0) + 1;
  const s = ((battleSt.encounterSeed >>> 0) + battleSt.encounterTurnIndex) >>> 0;
  seedRng(s);
}

// ── Turn dispatch ──────────────────────────────────────────────────────────
// Track the actor currently animating so we can reset their gauge when their
// action ends. Set at dispatch (markActing + cache ref), cleared when
// processNextTurn re-enters (markFilling).
let _lastDispatchedActor = null;

export function _resetLastDispatched() {
  if (!_lastDispatchedActor) return;
  // Wire-wait retry guard: when an ally's wire-action hasn't arrived,
  // `updateBattleAlly` re-calls processNextTurn with the same turn entry
  // unshifted at the queue head. Detect that and skip the reset — the
  // ally's gauge should stay at full while we wait, not drop to 0 every
  // retry frame.
  if (battleSt.turnQueue.length > 0) {
    const head = battleSt.turnQueue[0];
    const headActor = _resolveTurnActor(head);
    if (headActor === _lastDispatchedActor) return;
  }
  const atMs = Date.now();
  // v1.7.445 — FF4 spell cast time. The cast-initiation site stashed the
  // charge value on the actor; consume it now and pass to markFilling so
  // the next gauge cycle takes (RA + castTime) ticks. Cleared after read
  // so a non-cast action next turn gets a normal-length fill.
  const castTimeRa = (_lastDispatchedActor._nextCastTimeRa | 0) || 0;
  _lastDispatchedActor._nextCastTimeRa = 0;
  _atbMarkFilling(_lastDispatchedActor, atMs, castTimeRa);
  // Slice 4b (v1.7.439) — emit wire-sync for locally-owned units in co-op
  // encounters so partner clients reset their gauge for this unit at the
  // same atMs. Player is always ours; monsters are ours if we're the host.
  // Wire-driven allies belong to the partner — they emit, we don't.
  // v1.7.445 — also relay castTimeRa so partner gauges show the same
  // post-cast charge delay.
  if (battleSt.isWireEncounter) {
    if (_lastDispatchedActor === ps) {
      emitAtbFillingSync('player', -1, atMs, castTimeRa);
    } else if (battleSt.encounterIsHost && battleSt.encounterMonsters) {
      const idx = battleSt.encounterMonsters.indexOf(_lastDispatchedActor);
      if (idx >= 0) emitAtbFillingSync('monster', idx, atMs, castTimeRa);
    }
  }
  // Slice 5 (v1.7.442) — same idea for PvP. Locally-owned = ps + our
  // battleAllies. Partner-owned (pvpOpponentStats + pvpEnemyAllies) is
  // their problem to emit; we apply via setNetPVPAtbSyncHandler.
  if (pvpSt.isWirePVP) {
    if (_lastDispatchedActor === ps) {
      _sendPVPAtbSync('player', -1, atMs, castTimeRa);
    } else {
      const allyIdx = battleSt.battleAllies.indexOf(_lastDispatchedActor);
      if (allyIdx >= 0) _sendPVPAtbSync('ally', allyIdx, atMs, castTimeRa);
    }
  }
  _lastDispatchedActor = null;
}

function _resolveTurnActor(turn) {
  if (turn.type === 'player') return ps;
  if (turn.type === 'ally') return battleSt.battleAllies[turn.index] || null;
  if (turn.type === 'enemy') {
    if (pvpSt.isPVPBattle) {
      if (turn.pvpAllyIdx >= 0) return pvpSt.pvpEnemyAllies[turn.pvpAllyIdx] || null;
      return pvpSt.pvpOpponentStats || null;
    }
    if (turn.isBoss) return battleSt._bossAtbRef || null;
    if (battleSt.encounterMonsters && turn.index >= 0) {
      return battleSt.encounterMonsters[turn.index] || null;
    }
  }
  return null;
}

export function processNextTurn() {
  // ATB era: a turn just completed (or is being skipped). Reset the actor
  // that was animating, then yield to the ATB dispatch hub when the
  // legacy queue is empty.
  _resetLastDispatched();
  if (battleSt.turnQueue.length === 0) {
    battleSt.isDefending = false; inputSt.battleCursor = 0; battleSt.turnTimer = 0;
    if (pvpSt.isPVPBattle) pvpSt.pvpOpponentIsDefending = false;
    if (battleSt.isWireEncounter) {
      for (const a of battleSt.battleAllies) if (a) a.isDefending = false;
    }
    // v1.7.455 — FF4 canon. After any turn ends, yield to `atb-idle` and
    // let the dispatch hub re-open the menu only when the player's gauge
    // fills. Reverts v1.7.437's "menu open while filling" (queueable
    // commands) — that was Active mode plus pre-queue, which read as
    // "menu reset on enemy attack" because monsters kept ticking during
    // sub-menus. With FF4 canon, gauges only tick when nothing else is
    // happening (`_ATB_TICK_STATES` = atb-idle + menu-open only).
    battleSt.battleState = 'atb-idle';
    battleSt.battleTimer = 0;
    return;
  }
  const turn = battleSt.turnQueue.shift();
  // Per-actor poison tick at start of this turn (replaces the legacy
  // end-of-round consolidated poison phase). Skipped if status flag isn't
  // set or the actor is already dead.
  _maybePerActorPoison(turn);
  // Mark this actor acting — gauge freezes until their action completes.
  const actor = _resolveTurnActor(turn);
  if (actor) {
    _atbMarkActing(actor);
    _lastDispatchedActor = actor;
  }
  if (turn.type === 'player') {
    if (ps.hp <= 0) { processNextTurn(); return; }
    // Status turn-start: paralysis/sleep skip, confuse flag.
    // Poison damage is deferred to end-of-round (see _applyEndOfRoundPoison).
    if (ps.status && !turn._statusDone) {
      const { canAct, confused } = processTurnStart(ps.status, ps.stats ? ps.stats.maxHP : ps.hp);
      if (!canAct) { processNextTurn(); return; }
      // Confused: NES picks any random living target (self, ally, or enemy)
      if (confused) {
        const pool = [];
        pool.push({ type: 'self' });
        for (let i = 0; i < battleSt.battleAllies.length; i++) {
          if (battleSt.battleAllies[i].hp > 0) pool.push({ type: 'ally', index: i });
        }
        if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
          for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
            if (battleSt.encounterMonsters[i].hp > 0) pool.push({ type: 'monster', index: i });
          }
        }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        const blindMult = ps.status ? blindHitPenalty(ps.status) : 1;
        const effHitRate = (ps.hitRate || 80) * blindMult;
        const lv = ps.stats?.level || 1;
        const agi = (ps.stats?.agi || 5) + getJobLevelStatBonus().agi;
        const potHits = calcPotentialHits(lv, agi, false);
        const _playerJob = JOBS[ps.jobIdx] || {};
        const _playerCrit = { critPct: _playerJob.critPct || 0, critBonus: _playerJob.critBonus || 0 };
        // Confused player attacks a random target with the right-hand (or only
        // equipped) weapon. ps.atk holds the display sum (rWpn+lWpn+str/2), so
        // strip the offhand contribution back out — otherwise a confused
        // dual-wielder hits at sum-ATK for a single-hand roll.
        const _cRWpnAtk = isWeapon(ps.weaponR) ? (ITEMS.get(ps.weaponR)?.atk || 0) : 0;
        const _cLWpnAtk = isWeapon(ps.weaponL) ? (ITEMS.get(ps.weaponL)?.atk || 0) : 0;
        const _firstHandWpnAtk = isWeapon(ps.weaponR) ? _cRWpnAtk : _cLWpnAtk;
        const _confuseAtk = ps.atk - _cRWpnAtk - _cLWpnAtk + _firstHandWpnAtk;
        if (pick.type === 'monster') {
          const mon = battleSt.encounterMonsters[pick.index];
          const firstWpnId = isWeapon(ps.weaponR) ? ps.weaponR : ps.weaponL;
          const firstHandR = isWeapon(ps.weaponR) || !isWeapon(ps.weaponL);
          const bladed = isBladedWeapon(firstWpnId);
          inputSt.playerActionPending = { command: 'fight', targetIndex: pick.index,
            hitResults: rollHits(_confuseAtk, mon.def, effHitRate, potHits, { ..._playerCrit, evade: mon.evade || 0 }),
            slashFrames: getSlashFramesForWeapon(firstWpnId, firstHandR),
            slashOffX: bladed ? 8 : Math.floor(Math.random() * 40) - 20,
            slashOffY: bladed ? -8 : Math.floor(Math.random() * 40) - 20,
            slashX: 0, slashY: 0 };
        } else {
          // Self or ally: roll hits, apply damage directly, skip slash animation
          const targetDef = pick.type === 'self' ? ps.def : (battleSt.battleAllies[pick.index].def || 0);
          const hits = rollHits(_confuseAtk, targetDef, effHitRate, potHits, _playerCrit);
          let totalDmg = 0;
          for (const h of hits) { if (!h.miss && !h.shieldBlock) totalDmg += h.damage; }
          if (totalDmg > 0) {
            if (pick.type === 'self') {
              dispatchDelta({ type: 'hp', target: ps, amount: -totalDmg });
              setPlayerDamageNum({ value: totalDmg, timer: 0 });
            } else {
              const ally = battleSt.battleAllies[pick.index];
              dispatchDelta({ type: 'hp', target: ally, amount: -totalDmg });
              getAllyDamageNums()[pick.index] = { value: totalDmg, timer: 0 };
            }
            battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
            playSFX(SFX.ATTACK_HIT);
          }
          battleSt.battleState = 'poison-tick'; battleSt.battleTimer = 0;
          return;
        }
      }
    }
    const cmd = inputSt.playerActionPending.command;
    const pn = _playerName();
    if (cmd === 'fight') {
      if (pn) queueBattleMsg(pn);
      _playerTurnFight();
    }
    else if (cmd === 'defend') { inputSt.battleActionCount++; if (pn) queueBattleMsg(pn); playSFX(SFX.DEFEND_HIT); battleSt.battleState = 'defend-anim'; battleSt.battleTimer = 0; }
    else if (cmd === 'item') { inputSt.battleActionCount++; if (pn) queueBattleMsg(pn); _playerTurnItem(); }
    else if (cmd === 'magic') { inputSt.battleActionCount++; if (pn) queueBattleMsg(pn); _playerTurnMagic(); }
    else if (cmd === 'skip') processNextTurn();
    else if (cmd === 'run') _playerTurnRun();
  } else if (turn.type === 'ally') {
    battleSt.currentAllyAttacker = turn.index;
    battleSt.allyHitIsLeft = false;
    const ally = battleSt.battleAllies[turn.index];
    if (!ally || ally.hp <= 0) { processNextTurn(); return; }
    // Co-op random encounter wire-driven ally — the action belongs to a
    // peer player who's running their local turn on their phone. Replay
    // their wire-delivered action instead of running AI here. Stall the
    // turn (push back to queue head) until the matching encounter-action
    // arrives. v1.7.418.
    if (battleSt.isWireEncounter && ally.isWireDriven && ally.userId) {
      // Mirror the sender's `processTurnStart` rand consumption so both
      // clients' rand cursors stay aligned through status rolls (sleep
      // wake / confuse snap / paralysis skip). Sender ran this in their
      // player-turn branch and either took the turn (canAct=true → emit)
      // or skipped (canAct=false → no emit). We do the same: run the
      // status roll, then either dequeue the action or skip. Flagged
      // with `turn._statusDone` so the unshift+retry loop doesn't
      // double-consume the rand. v1.7.419.
      if (ally.status && !turn._statusDone) {
        const { canAct } = processTurnStart(ally.status, ally.maxHP || ally.hp);
        turn._statusDone = true;
        if (!canAct) { processNextTurn(); return; }
      }
      const action = dequeueWireEncounterAction(ally.userId);
      if (!action) {
        battleSt.turnQueue.unshift(turn);
        // First entry into wait — start the timeout clock. Re-entries
        // from the per-frame retry tick leave battleTimer accumulating
        // so the watchdog in `updateBattleAlly` can flip the ally to
        // AI-fallback after WIRE_WAIT_TIMEOUT_MS. v1.7.419.
        if (battleSt.battleState !== 'ally-wire-wait') {
          battleSt.battleState = 'ally-wire-wait';
          battleSt.battleTimer = 0;
        }
        return;
      }
      if (_applyWireEncounterActionForAlly(turn.index, ally, action)) return;
      // Fell through (kind we don't replay) — skip this ally's turn.
      processNextTurn(); return;
    }
    // Ally status turn-start (paralysis/sleep). Poison damage deferred.
    if (ally.status && !turn._statusDone) {
      const { canAct } = processTurnStart(ally.status, ally.maxHP || ally.hp);
      if (!canAct) { processNextTurn(); return; }
    }
    // White Mage heal AI — pick lowest-HP-pct teammate (player or other ally) below 60% HP.
    // If anyone needs healing AND ally knows Cure (0x34), cast on them. Else fall through to Poisona check / attack.
    if (_tryAllyCure(ally, turn.index)) return;
    // White Mage status AI — if anyone (incl self) is poisoned and ally knows Poisona (0x35), cast it.
    if (_tryAllyPoisona(ally, turn.index)) return;
    // Black/Red Mage offensive AI — if ally knows Fire/Bzzard/Sleep, sometimes cast on a living monster.
    // Encounter-only for v1; PVP target path TODO.
    if (_tryAllyOffensiveCast(ally, turn.index)) return;
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const living = battleSt.encounterMonsters.map((m, i) => m.hp > 0 ? i : -1).filter(i => i >= 0);
      if (living.length === 0) { processNextTurn(); return; }
      battleSt.allyTargetIndex = living[Math.floor(Math.random() * living.length)];
    } else { battleSt.allyTargetIndex = -1; }
    const monTgt = battleSt.allyTargetIndex >= 0 ? battleSt.encounterMonsters[battleSt.allyTargetIndex] : null;
    const pvpTgt = !monTgt && pvpSt.isPVPBattle
      ? (pvpSt.pvpPlayerTargetIdx >= 0
          ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats)
          : pvpSt.pvpOpponentStats)
      : null;
    const targetDef = monTgt ? monTgt.def : pvpTgt ? pvpTgt.def : BOSS_DEF;
    // Unarmed = dual fists (same as player path) → 2x hits.
    const aRw = isWeapon(ally.weaponId), aLw = isWeapon(ally.weaponL);
    const dualWield = (aRw && aLw) || (!aRw && !aLw);
    const potentialHits = calcPotentialHits(ally.level || 1, ally.agi, dualWield);
    const _allyJob = JOBS[ally.jobIdx || 0] || {};
    // Apply Blind (halves hit rate) and Mini/Toad (zeroes atk) at roll time —
    // matches player path. Previously skipped, so a Blinded/Mini'd ally
    // attacked at full effectiveness.
    const allyBlindMult = ally.status ? blindHitPenalty(ally.status) : 1;
    const allyAtkMult = ally.status ? miniToadAtkMult(ally.status) : 1;
    const allyHitRate = (ally.hitRate || 85) * allyBlindMult;
    // Per-hand ATK split (v1.7.322): ally.atk is the DISPLAY value (sum of both
    // weapon ATKs + str/2). Strip weapon component to recover str/2, then add
    // each hand's own weapon ATK back. RRLL split inside rollHits via opts.lAtk
    // + splitRH. Single-wield: pass the equipped hand's atk as `mainAtk` so
    // left-hand-only loadouts don't roll at str/2.
    const allyRWpnAtk = aRw ? (ITEMS.get(ally.weaponId)?.atk || 0) : 0;
    const allyLWpnAtk = aLw ? (ITEMS.get(ally.weaponL)?.atk || 0) : 0;
    const allyBaseAtk = (ally.atk - allyRWpnAtk - allyLWpnAtk) * allyAtkMult;
    const allyRAtk = allyBaseAtk + allyRWpnAtk;
    const allyLAtk = allyBaseAtk + allyLWpnAtk;
    const allyMainAtk = dualWield ? allyRAtk : (aRw ? allyRAtk : allyLAtk);
    // Wire-PvP — when ally attacks the main opp, halve damage if the opp's
    // wire-delivered 'defend' action set `pvpOpponentIsDefending`. Mirror of
    // the player-attack site in input-handler.js. See
    // docs/MULTIPLAYER-AUDIT-2026-05-15.md #1.
    const oppDefending = pvpTgt === pvpSt.pvpOpponentStats && !!pvpSt.pvpOpponentIsDefending;
    battleSt.allyHitResults = rollHits(allyMainAtk, targetDef, allyHitRate, potentialHits, {
      critPct: _allyJob.critPct || 0,
      critBonus: _allyJob.critBonus || 0,
      shieldEvade: pvpTgt ? (pvpTgt.shieldEvade || 0) : 0,
      evade: monTgt ? (monTgt.evade || 0) : pvpTgt ? (pvpTgt.evade || 0) : 0,
      defendHalve: oppDefending,
      lAtk: allyLAtk,
      splitRH: dualWield,
    });
    battleSt.allyHitIdx = 0;
    battleSt.allyHitResult = battleSt.allyHitResults[0];
    // MP party-PvP — relay ally physical attack target so the opponent's
    // client drives its matching pvp-enemy-ally turn from this pick. PvP
    // target: pvpTgt is the cell idx via pvpPlayerTargetIdx (-1=main opp,
    // N=ally N). Map to wire cell idx (main=0, ally N → N+1).
    if (pvpSt.isWirePVP && pvpSt.isPVPBattle) {
      const tgtCellIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
      _emitWireAllyAction(turn.index, { kind: 'attack', target: { side: 'opp', idx: tgtCellIdx } });
    }
    battleSt.battleState = 'ally-attack-back'; battleSt.battleTimer = 0;
  } else {
    battleSt.currentAttacker = turn.index;
    // Monster status turn-start: paralysis skip. Poison damage deferred.
    if (turn.index >= 0 && battleSt.encounterMonsters && battleSt.encounterMonsters[turn.index] && !turn._statusDone) {
      const mon = battleSt.encounterMonsters[turn.index];
      if (mon.status) {
        const { canAct } = processTurnStart(mon.status, mon.maxHP);
        if (!canAct || mon.hp <= 0) { processNextTurn(); return; }
      }
    }
    if (pvpSt.isPVPBattle) {
      const pai = turn.pvpAllyIdx ?? -1;
      pvpSt.pvpCurrentEnemyAllyIdx = pai;
      if (pai < 0 && (!pvpSt.pvpOpponentStats || pvpSt.pvpOpponentStats.hp <= 0)) { processNextTurn(); return; }
      if (pai >= 0 && (pvpSt.pvpEnemyAllies[pai]?.hp ?? 0) <= 0) { processNextTurn(); return; }
      // PVP status turn-start: paralysis-skip, sleep-wake roll, confuse
      // snap-out. Was missing entirely — paralysis on PVP enemy let them act,
      // sleep never woke via the 25% roll.
      const pvpActor = pai >= 0 ? pvpSt.pvpEnemyAllies[pai] : pvpSt.pvpOpponentStats;
      if (pvpActor && pvpActor.status) {
        const { canAct } = processTurnStart(pvpActor.status, pvpActor.maxHP || pvpActor.hp);
        if (!canAct || pvpActor.hp <= 0) { processNextTurn(); return; }
      }
      if (pai < 0) pvpSt.pvpEnemyHitIdx = 0;
    }
    if (turn.index >= 0 && battleSt.encounterMonsters && battleSt.encounterMonsters[turn.index].hp <= 0) { processNextTurn(); return; }
    // Queue the actor name BEFORE the preflash so the 200ms message fade-in
    // overlaps the 133ms BOSS_PREFLASH_MS window. Without this the message
    // started fading in only after the swing began, so the player saw the hit
    // land before the name appeared. Both regular and PVP enemy turns route
    // through here.
    if (pvpSt.isPVPBattle) {
      const pai = pvpSt.pvpCurrentEnemyAllyIdx;
      const stats = pai >= 0 ? pvpSt.pvpEnemyAllies[pai] : pvpSt.pvpOpponentStats;
      if (stats && stats.name) queueBattleMsg(_nameToBytes(stats.name));
    } else if (turn.isBoss) {
      // v1.7.453 — boss turn name queue. Boss is monster 0xCC (Land Turtle).
      queueBattleMsg(getMonsterName(0xCC) || _nameToBytes('Enemy'));
    } else if (battleSt.currentAttacker >= 0 && battleSt.encounterMonsters) {
      const mon = battleSt.encounterMonsters[battleSt.currentAttacker];
      if (mon) queueBattleMsg(getMonsterName(mon.monsterId) || _nameToBytes('Enemy'));
    }
    battleSt.battleState = 'enemy-flash'; battleSt.battleTimer = 0; pvpSt.pvpPreflashDecided = false;
  }
}

// ── End-of-round poison ────────────────────────────────────────────────────
// Walks every living combatant once. Anyone with the POISON flag takes
// floor(maxHP/16) and gets a damage-num popped on their slot. Player + allies
// clamp to HP 1 (NES never lets poison kill from full); enemies/monsters can
// die. Returns true if any actor ticked (caller drives the hold-state).
// Per-actor poison tick — applied at the start of each actor's turn in
// ATB world. Replaces the legacy `_applyEndOfRoundPoison` consolidated
// phase (which existed because the round-based queue had a natural
// "round boundary" — gone with ATB). NES rule: player/ally poison clamps
// at min 1 HP; monsters + PvP enemies can die to poison.
function _maybePerActorPoison(turn) {
  if (turn.type === 'player') {
    if (ps.hp > 0 && ps.status && hasStatus(ps.status, STATUS.POISON)) {
      const max = ps.stats ? ps.stats.maxHP : ps.hp;
      const dmg = Math.floor(max / 16);
      if (dmg > 0) {
        dispatchDelta({ type: 'hp', target: ps, amount: -dmg, min: 1 });
        setPlayerDamageNum({ value: dmg, timer: 0 });
      }
    }
  } else if (turn.type === 'ally') {
    const i = turn.index;
    const ally = battleSt.battleAllies[i];
    if (ally && ally.hp > 0 && ally.status && hasStatus(ally.status, STATUS.POISON)) {
      const dmg = Math.floor((ally.maxHP || ally.hp) / 16);
      if (dmg > 0) {
        dispatchDelta({ type: 'hp', target: ally, amount: -dmg, min: 1 });
        getAllyDamageNums()[i] = { value: dmg, timer: 0 };
      }
    }
  } else if (turn.type === 'enemy') {
    if (pvpSt.isPVPBattle) {
      const tgt = turn.pvpAllyIdx >= 0 ? pvpSt.pvpEnemyAllies[turn.pvpAllyIdx] : pvpSt.pvpOpponentStats;
      if (tgt && tgt.hp > 0 && tgt.status && hasStatus(tgt.status, STATUS.POISON)) {
        const dmg = Math.floor((tgt.maxHP || tgt.hp) / 16);
        if (dmg > 0) {
          dispatchDelta({ type: 'hp', target: tgt, amount: -dmg });
          setSwDmgNum(turn.pvpAllyIdx >= 0 ? turn.pvpAllyIdx + 1 : 0, dmg);
        }
      }
    } else if (battleSt.isRandomEncounter && battleSt.encounterMonsters && turn.index >= 0) {
      const mon = battleSt.encounterMonsters[turn.index];
      if (mon && mon.hp > 0 && mon.status && hasStatus(mon.status, STATUS.POISON)) {
        const dmg = Math.floor((mon.maxHP || mon.hp) / 16);
        if (dmg > 0) {
          dispatchDelta({ type: 'hp', target: mon, amount: -dmg });
          setSwDmgNum(turn.index, dmg);
        }
      }
    }
  }
}

// Legacy end-of-round poison — retired with the round-queue dispatch.
// Kept as a no-op stub in case any remaining caller references it during
// the ATB transition; remove once all references are cleaned up.
function _applyEndOfRoundPoison() {
  let anyTicked = false;
  if (ps.hp > 0 && ps.status && hasStatus(ps.status, STATUS.POISON)) {
    const max = ps.stats ? ps.stats.maxHP : ps.hp;
    const dmg = Math.floor(max / 16);
    if (dmg > 0) {
      // NES rule: poison never kills player/ally from full → clamp to 1.
      dispatchDelta({ type: 'hp', target: ps, amount: -dmg, min: 1 });
      setPlayerDamageNum({ value: dmg, timer: 0 });
      anyTicked = true;
    }
  }
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const ally = battleSt.battleAllies[i];
    if (!ally || ally.hp <= 0 || !ally.status) continue;
    if (!hasStatus(ally.status, STATUS.POISON)) continue;
    const dmg = Math.floor((ally.maxHP || ally.hp) / 16);
    if (dmg <= 0) continue;
    dispatchDelta({ type: 'hp', target: ally, amount: -dmg, min: 1 });
    getAllyDamageNums()[i] = { value: dmg, timer: 0 };
    anyTicked = true;
  }
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    for (let i = 0; i < battleSt.encounterMonsters.length; i++) {
      const mon = battleSt.encounterMonsters[i];
      if (!mon || mon.hp <= 0 || !mon.status) continue;
      if (!hasStatus(mon.status, STATUS.POISON)) continue;
      const dmg = Math.floor((mon.maxHP || mon.hp) / 16);
      if (dmg <= 0) continue;
      // Monsters/PvP-enemies CAN die to poison — no min clamp.
      dispatchDelta({ type: 'hp', target: mon, amount: -dmg });
      setSwDmgNum(i, dmg);
      anyTicked = true;
    }
  }
  if (pvpSt.isPVPBattle) {
    const opp = pvpSt.pvpOpponentStats;
    if (opp && opp.hp > 0 && opp.status && hasStatus(opp.status, STATUS.POISON)) {
      const dmg = Math.floor((opp.maxHP || opp.hp) / 16);
      if (dmg > 0) {
        dispatchDelta({ type: 'hp', target: opp, amount: -dmg });
        setSwDmgNum(0, dmg);
        anyTicked = true;
      }
    }
    for (let i = 0; i < pvpSt.pvpEnemyAllies.length; i++) {
      const e = pvpSt.pvpEnemyAllies[i];
      if (!e || e.hp <= 0 || !e.status) continue;
      if (!hasStatus(e.status, STATUS.POISON)) continue;
      const dmg = Math.floor((e.maxHP || e.hp) / 16);
      if (dmg <= 0) continue;
      dispatchDelta({ type: 'hp', target: e, amount: -dmg });
      setSwDmgNum(i + 1, dmg);
      anyTicked = true;
    }
  }
  return anyTicked;
}

// ── Ally heal AI (White Mage) ──────────────────────────────────────────────
// Returns true if ally cast Cure this turn (caller should NOT also do attack).
// Decision side (knownSpells gate, candidate pick, heal roll) lives in
// `combatant-ai.js`; this function builds the player-side team list, calls
// the shared picker, and writes the ally-specific state bag.
function _tryAllyCure(ally, allyIdx) {
  if (!canCastBasic(ally, SPELL_CURE)) return false;

  const team = _buildPlayerTeam();
  const target = pickHealTarget(team, AI_HEAL_THRESHOLD);
  if (!target) return false;

  const heal = rollCureAmount(ally);
  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = target.ref.type;
  battleSt.allyMagicTargetIdx     = target.ref.index;
  battleSt.allyMagicSpellId       = SPELL_CURE;
  battleSt.allyMagicHealAmount    = heal;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = false;
  setActiveCast({
    caster: { faction: 'ally', idx: allyIdx },
    spellId: SPELL_CURE,
    targets: [{ faction: target.ref.type, idx: target.ref.index }],
    healAmount: heal,
  });
  _emitWireAllyAction(allyIdx, { kind: 'magic', spellId: SPELL_CURE, target: _wireTargetFromAllyMagicBag(), healAmount: heal });
  queueBattleMsg(ally.name ? _nameToBytes(ally.name) : BATTLE_ALLY);
  replaceBattleMsg(getSpellNameShrinesClean(SPELL_CURE));
  playSFX(SFX.MAGIC_CAST);
  tagCasterCastTime(ally, SPELL_CURE);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// MP party-PvP — emit an ally's chosen action to the wire partner so the
// opponent's client can drive the matching pvp-enemy-ally cell from real
// input rather than its own local AI. Caller invokes this after writing the
// state bag (so the state-bag write also drives the LOCAL animation flow as
// usual). actor.idx is allyIdx + 1 (cell-idx convention: 0 = main player,
// 1+ = ally cell on the sender's player side).
function _emitWireAllyAction(allyIdx, payload) {
  if (!pvpSt.isWirePVP) return;
  sendNetPVPAction({ ...payload, actor: { idx: allyIdx + 1 } });
}

// Co-op random encounter — replay a wire-delivered action on the local
// view of a peer player's ally turn. Returns true if the action was
// consumed (caller should NOT advance the queue); false if it couldn't
// be replayed (caller falls through to skip via processNextTurn).
// v1.7.418 / extended v1.7.419 to cover magic + item + defend.
//
// Target translation (sender's view → receiver's view):
//   `self`             → caster is wire-driven ally @ allyIdx → 'ally' / allyIdx
//   `ally` userId=me   → local ps                              → 'player' / -1
//   `ally` userId=N    → look up ally with that userId         → 'ally' / N
//   `monster` idx=N    → 'enemy' / N (both clients sorted identically)
function _applyWireEncounterActionForAlly(allyIdx, ally, action) {
  if (!action) return false;

  // Defend — flag per-ally so incoming damage halves. Animation skipped
  // for MVP; round-end clear lives in processNextTurn's queue-empty
  // branch alongside `battleSt.isDefending`. v1.7.419.
  if (action.kind === 'defend') {
    ally.isDefending = true;
    return false;
  }

  // Run / skip — peer fled or skipped. Receiver's local FSM has nothing
  // to animate for this turn; just advance.
  if (action.kind === 'run' || action.kind === 'skip') {
    return false;
  }

  // Attack
  if (action.kind === 'attack') {
    const tgt = action.target;
    if (!tgt || tgt.kind !== 'monster') return false;
    const tgtIdx = tgt.idx | 0;
    if (!battleSt.encounterMonsters || !battleSt.encounterMonsters[tgtIdx]) return false;
    const mon = battleSt.encounterMonsters[tgtIdx];
    if (mon.hp <= 0) return false;
    battleSt.allyTargetIndex = tgtIdx;
    battleSt.allyHitResults = Array.isArray(action.hitResults) ? action.hitResults : [];
    battleSt.allyHitIdx = 0;
    battleSt.allyHitResult = battleSt.allyHitResults[0] || null;
    battleSt.battleState = 'ally-attack-back';
    battleSt.battleTimer = 0;
    return true;
  }

  // Magic / item — both ride the ally-magic-cast / ally-magic-hit
  // pipeline. Item uses `allyMagicItemMode=true` to suppress the cast
  // flame and routes through a sentinel spellId (SPELL_CURE for heal
  // items, SPELL_POISONA for cure-status). Damage / heal amounts are
  // pre-rolled by the sender + ride the wire; receiver applies them
  // directly via the same state bag.
  if (action.kind === 'magic' || action.kind === 'item') {
    const isItem = action.kind === 'item';
    let spellId = (action.spellId | 0);
    if (isItem && !spellId) {
      const item = ITEMS.get(action.itemId | 0);
      spellId = (item && item.effect === 'cure_status') ? SPELL_POISONA : SPELL_CURE;
    }
    if (!spellId) return false;

    const tgt = action.target;
    if (!tgt) return false;
    let targetType, targetIdx;
    if (tgt.kind === 'self') {
      targetType = 'ally';
      targetIdx = allyIdx;
    } else if (tgt.kind === 'ally') {
      const tgtUid = tgt.userId | 0;
      const myUid = getMyUserId() | 0;
      if (tgtUid && tgtUid === myUid) {
        targetType = 'player';
        targetIdx = -1;
      } else if (tgtUid) {
        const i = battleSt.battleAllies.findIndex(a => (a.userId | 0) === tgtUid);
        if (i < 0) return false;
        targetType = 'ally';
        targetIdx = i;
      } else {
        return false;
      }
    } else if (tgt.kind === 'monster') {
      targetType = 'enemy';
      targetIdx = tgt.idx | 0;
      if (!battleSt.encounterMonsters || !battleSt.encounterMonsters[targetIdx]) return false;
    } else {
      return false;
    }

    battleSt.allyMagicCasterIdx     = allyIdx;
    battleSt.allyMagicTargetType    = targetType;
    battleSt.allyMagicTargetIdx     = targetIdx;
    battleSt.allyMagicSpellId       = spellId;
    battleSt.allyMagicHealAmount    = action.healAmount | 0;
    battleSt.allyMagicDamageRoll    = action.damageRoll | 0;
    battleSt.allyMagicEffectApplied = false;
    battleSt.allyMagicSfxPlayed     = false;
    battleSt.allyMagicItemMode      = isItem;
    setActiveCast({
      caster: { faction: 'ally', idx: allyIdx },
      spellId,
      isItemUse: isItem,
      targets: [{ faction: targetType, idx: targetIdx }],
      healAmount: action.healAmount | 0,
      damageRoll: action.damageRoll | 0,
    });
    queueBattleMsg(ally.name ? _nameToBytes(ally.name) : BATTLE_ALLY);
    replaceBattleMsg(getSpellNameShrinesClean(spellId));
    playSFX(SFX.MAGIC_CAST);
    tagCasterCastTime(ally, spellId, isItem);
    battleSt.battleState = 'ally-magic-cast';
    battleSt.battleTimer = 0;
    return true;
  }

  return false;
}

// Translate the ally state bag's `{ allyMagicTargetType, allyMagicTargetIdx }`
// into the wire target shape. 'player'/-1 → me.0 (sender's main player);
// 'player'/N or 'ally'/N → me.(N+1); 'enemy'|'pvp-enemy'/N → opp.N
// (where N is the pvp-enemy cell idx).
function _wireTargetFromAllyMagicBag() {
  const t = battleSt.allyMagicTargetType;
  const i = battleSt.allyMagicTargetIdx;
  if (t === 'player') return { side: 'me', idx: i < 0 ? 0 : i + 1 };
  if (t === 'ally')   return { side: 'me', idx: i + 1 };
  return { side: 'opp', idx: i | 0 };  // 'enemy' (random encounter) reuses same convention
}

// Build the player-team list for AI decisions. Order = player → ally 0 →
// ally 1 → … Each entry has { ref, hp, maxHP, status } so the AI helpers in
// `combatant-ai.js` can scan without dereferencing the underlying combatants.
// `ref.index` is -1 for the player, ally cell index otherwise — the same
// shape the legacy state bag uses for `allyMagicTargetType / TargetIdx`.
function _buildPlayerTeam() {
  const team = [];
  if (ps.hp > 0) {
    team.push({
      ref: { type: 'player', index: -1 },
      hp: ps.hp,
      maxHP: ps.stats?.maxHP,
      status: ps.status,
    });
  }
  for (let i = 0; i < battleSt.battleAllies.length; i++) {
    const a = battleSt.battleAllies[i];
    if (!a) continue;
    team.push({
      ref: { type: 'ally', index: i },
      hp: a.hp,
      maxHP: a.maxHP,
      status: a.status,
    });
  }
  return team;
}

// ── Ally Poisona AI ────────────────────────────────────────────────────────
// Returns true if ally cast Poisona this turn. Targets first poisoned teammate
// (player → self → other allies). MP-gated upstream by knownSpells presence;
// no need to deduct MP here since fake-roster allies don't track MP.
function _tryAllyPoisona(ally, allyIdx) {
  if (!canCastBasic(ally, SPELL_POISONA)) return false;

  // Priority order: player → self → other allies. `_buildPlayerTeam` is
  // ordered player → ally 0..n, so reorder: player first, then self at
  // ally.allyIdx, then the remaining allies. Self lands second so a healer
  // with their own POISON gets cured before scanning others.
  const team = _buildPlayerTeam();
  const playerEntry = team.find(t => t.ref.type === 'player');
  const selfEntry   = team.find(t => t.ref.type === 'ally' && t.ref.index === allyIdx);
  const others      = team.filter(t => t.ref.type === 'ally' && t.ref.index !== allyIdx);
  const ordered     = [playerEntry, selfEntry, ...others].filter(Boolean);

  const target = pickPoisonedTarget(ordered);
  if (!target) return false;

  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = target.ref.type;
  battleSt.allyMagicTargetIdx     = target.ref.index;
  battleSt.allyMagicSpellId       = SPELL_POISONA;
  battleSt.allyMagicHealAmount    = 0;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = false;
  setActiveCast({
    caster: { faction: 'ally', idx: allyIdx },
    spellId: SPELL_POISONA,
    targets: [{ faction: target.ref.type, idx: target.ref.index }],
  });
  _emitWireAllyAction(allyIdx, { kind: 'magic', spellId: SPELL_POISONA, target: _wireTargetFromAllyMagicBag() });
  queueBattleMsg(ally.name ? _nameToBytes(ally.name) : BATTLE_ALLY);
  replaceBattleMsg(getSpellNameShrinesClean(SPELL_POISONA));
  playSFX(SFX.MAGIC_CAST);
  tagCasterCastTime(ally, SPELL_POISONA);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// ── Ally offensive cast AI (BM/RM Fire/Bzzard/Sleep) ───────────────────────
// Roster ally on the player team picks a random offensive spell from
// `ally.knownSpells` (Fire 0x31 / Bzzard 0x32 / Sleep 0x33), targets a
// random living encounter monster, pre-rolls damage (INT-based, mirrors
// `_tryPVPEnemyOffensiveCast` in pvp.js), and queues an `ally-magic-cast`
// turn. Apply path lives in `battle-ally.js:_applyAllyMagicEffect`.
//
// Activation gate (~45%) keeps offensive magic feeling like a *sometimes*
// choice instead of the default — same gate as the PVP-enemy mirror.
// MP-gated upstream by `knownSpells` presence (fake-roster allies don't
// track MP). Encounter-only for v1; PVP target path TODO.
function _tryAllyOffensiveCast(ally, allyIdx) {
  if (!canCastAny(ally)) return false;
  const spellId = pickOffensiveSpell(ally);
  if (!spellId) return false;
  if (!rollActivation(AI_OFFENSIVE_GATE)) return false;

  // Build the enemy list using the cell-idx convention shared with
  // `spell-cast.js:_getEnemyAt`:
  //   'enemy'      → encounterMonsters[idx]
  //   'pvp-enemy'  → idx === 0 → pvpOpponentStats; idx >= 1 → pvpEnemyAllies[idx - 1]
  // The shared damage display (`setSwDmgNum`) keys off these same indices.
  const enemies = [];
  let targetType = null;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
    targetType = 'enemy';
    battleSt.encounterMonsters.forEach((m, i) => {
      if (m) enemies.push({ ref: { type: 'enemy', index: i }, hp: m.hp });
    });
  } else if (pvpSt.isPVPBattle) {
    targetType = 'pvp-enemy';
    if (pvpSt.pvpOpponentStats) {
      enemies.push({ ref: { type: 'pvp-enemy', index: 0 }, hp: pvpSt.pvpOpponentStats.hp });
    }
    (pvpSt.pvpEnemyAllies || []).forEach((a, i) => {
      if (a) enemies.push({ ref: { type: 'pvp-enemy', index: i + 1 }, hp: a.hp });
    });
  } else {
    return false;
  }

  const target = pickRandomLivingTarget(enemies);
  if (!target) return false;
  const spell = SPELLS.get(spellId);
  if (!spell) return false;
  const dmg = rollOffensiveDamage(ally, spell);

  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = targetType;
  battleSt.allyMagicTargetIdx     = target.ref.index;
  battleSt.allyMagicSpellId       = spellId;
  battleSt.allyMagicHealAmount    = 0;
  battleSt.allyMagicDamageRoll    = dmg;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = false;
  setActiveCast({
    caster: { faction: 'ally', idx: allyIdx },
    spellId,
    targets: [{ faction: targetType, idx: target.ref.index }],
    damageRoll: dmg,
  });
  _emitWireAllyAction(allyIdx, { kind: 'magic', spellId, target: _wireTargetFromAllyMagicBag(), damageRoll: dmg });
  queueBattleMsg(ally.name ? _nameToBytes(ally.name) : BATTLE_ALLY);
  replaceBattleMsg(getSpellNameShrinesClean(spellId));
  playSFX(SFX.MAGIC_CAST);
  tagCasterCastTime(ally, spellId);
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// ── Ally item AI (cure potion / antidote) ──────────────────────────────────
// Roster ally consumes a Cure Potion (target heal 50) or Antidote (cure POISON
// on target). Reuses the ally-magic-cast / ally-magic-hit pipeline with
// allyMagicItemMode=true to suppress the cast flame; sparkle + heal-num still
// render on the target as with spell casts.
function _tryAllyItem(ally, allyIdx) {
  if (!rollActivation(AI_ITEM_GATE)) return false;

  // Priority 1 — Antidote: scan team for first poisoned member. Order =
  // player → self → other allies (matches the pre-v1.7.360 hand-rolled
  // priority order).
  const teamRaw = _buildPlayerTeam();
  const playerEntry = teamRaw.find(t => t.ref.type === 'player');
  const selfEntry   = teamRaw.find(t => t.ref.type === 'ally' && t.ref.index === allyIdx);
  const others      = teamRaw.filter(t => t.ref.type === 'ally' && t.ref.index !== allyIdx);
  const orderedPoison = [playerEntry, selfEntry, ...others].filter(Boolean);

  let target = pickPoisonedTarget(orderedPoison);
  let spellSentinel = SPELL_POISONA;  // antidote uses the Poisona anim slot

  // Priority 2 — Cure Potion: lowest-HP teammate below 50%.
  if (!target) {
    target = pickHealTarget(teamRaw, AI_POTION_THRESHOLD);
    if (!target) return false;
    spellSentinel = SPELL_CURE;
  }

  battleSt.allyMagicCasterIdx     = allyIdx;
  battleSt.allyMagicTargetType    = target.ref.type;
  battleSt.allyMagicTargetIdx     = target.ref.index;
  battleSt.allyMagicSpellId       = spellSentinel;
  battleSt.allyMagicHealAmount    = 50;
  battleSt.allyMagicEffectApplied = false;
  battleSt.allyMagicItemMode      = true;
  setActiveCast({
    caster: { faction: 'ally', idx: allyIdx },
    spellId: spellSentinel,
    isItemUse: true,
    targets: [{ faction: target.ref.type, idx: target.ref.index }],
    healAmount: 50,
  });
  _emitWireAllyAction(allyIdx, { kind: 'item', itemId: 0xa6, target: _wireTargetFromAllyMagicBag() });
  queueBattleMsg(ally.name ? _nameToBytes(ally.name) : BATTLE_ALLY);
  replaceBattleMsg(getSpellNameShrinesClean(spellSentinel));
  playSFX(SFX.CURE);
  tagCasterCastTime(ally, spellSentinel, true);  // item-use → charge 0
  battleSt.battleState = 'ally-magic-cast';
  battleSt.battleTimer = 0;
  return true;
}

// ── Player turn actions ────────────────────────────────────────────────────
function _playerTurnFight() {
  let ti = inputSt.playerActionPending.targetIndex;
  if (battleSt.isRandomEncounter && battleSt.encounterMonsters && ti >= 0 && battleSt.encounterMonsters[ti].hp <= 0) {
    const living = battleSt.encounterMonsters.findIndex(m => m.hp > 0);
    if (living < 0) { processNextTurn(); return; }
    ti = living;
  }
  battleSt.currentHitIdx = 0; battleSt.slashFrame = 0;
  inputSt.hitResults = inputSt.playerActionPending.hitResults;
  inputSt.targetIndex = ti;
  bsc.slashFrames = inputSt.playerActionPending.slashFrames;
  battleSt.slashOffX = inputSt.playerActionPending.slashOffX; battleSt.slashOffY = inputSt.playerActionPending.slashOffY;
  battleSt.slashX = inputSt.playerActionPending.slashX; battleSt.slashY = inputSt.playerActionPending.slashY;
  battleSt.battleState = 'attack-back'; battleSt.battleTimer = 0;
}

function _playerTurnConsumable() {
  const itemId = inputSt.playerActionPending.itemId;
  const itemDat = ITEMS.get(itemId);
  const effect = itemDat?.effect || 'heal';
  const power = itemDat?.power || 50;

  // Player name was queued at command dispatch; swap in the item name now.
  replaceBattleMsg(getItemNameShrinesClean(itemId));
  playSFX(SFX.CURE);
  const { target, allyIndex } = inputSt.playerActionPending;

  if (effect === 'cure_status') {
    // Status cure items — only target player for now
    const flag = STATUS_NAME_TO_FLAG[itemDat.cures];
    if (flag && ps.status) removeStatus(ps.status, flag);
    battleSt.itemHealAmount = 0;
    battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
    return;
  }

  if (effect === 'full_heal') {
    // Elixir — full HP restore
    if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
      const heal = ps.stats.maxHP - ps.hp;
      ps.hp = ps.stats.maxHP; battleSt.itemHealAmount = heal; setPlayerHealNum({ value: heal, timer: 0 });
    }
    battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
    return;
  }

  // Default: heal HP by power amount. Routes through applyMagicHeal so Cure
  // spell + Potion can't drift on the clamp/HP-write logic. SFX already
  // played at line 526; pass no `sfx` opt to avoid double-fire. The boss /
  // PVP-main-opp path stays inline because it goes through getEnemyHP /
  // setEnemyHP wrappers (no `target.hp` accessor).
  //
  // Apply-time target redirect (v1.7.359 step 2/7): if the picked target died
  // between menu confirm and turn arrival, redirect to the next-living member
  // of the same faction so the item doesn't get silently wasted.
  if (target === 'player' && (allyIndex === undefined || allyIndex < 0)) {
    // Heal the player. If dead, fall back to first-living ally.
    let healTgt = ps, healNumCb = (n) => setPlayerHealNum({ value: n, timer: 0 });
    if (ps.hp <= 0) {
      const allies = battleSt.battleAllies || [];
      for (let i = 0; i < allies.length; i++) {
        if (allies[i] && allies[i].hp > 0) {
          healTgt = allies[i];
          healNumCb = (n) => { getAllyDamageNums()[i] = { value: n, timer: 0, heal: true }; };
          break;
        }
      }
    }
    const heal = applyMagicHeal(healTgt, power, { onHealNum: healNumCb });
    battleSt.itemHealAmount = heal;
  } else if (target === 'player' && allyIndex >= 0) {
    // Heal an ally. If picked ally dead, fall back: next-living ally → player.
    const allies = battleSt.battleAllies || [];
    let healTgt = allies[allyIndex];
    let healIdx = allyIndex;
    let healNumCb = (n) => { getAllyDamageNums()[healIdx] = { value: n, timer: 0, heal: true }; };
    if (!healTgt || healTgt.hp <= 0) {
      let redirected = false;
      for (let i = 0; i < allies.length; i++) {
        if (allies[i] && allies[i].hp > 0) { healTgt = allies[i]; healIdx = i; redirected = true; break; }
      }
      if (!redirected && ps.hp > 0) {
        healTgt = ps;
        healNumCb = (n) => setPlayerHealNum({ value: n, timer: 0 });
      }
    }
    if (healTgt) {
      const heal = applyMagicHeal(healTgt, power, { onHealNum: healNumCb });
      battleSt.itemHealAmount = heal;
    }
  } else {
    const mons = battleSt.isRandomEncounter && battleSt.encounterMonsters ? battleSt.encounterMonsters : null;
    let mon = mons ? mons[target] : null;
    let monIdx = target;
    if (mons && (!mon || mon.hp <= 0)) {
      const live = resolveLivingTarget(mon, mons);
      if (live) { mon = live; monIdx = mons.indexOf(live); }
    }
    if (mon) {
      const heal = applyMagicHeal(mon, power, { onHealNum: (n) => setEnemyHealNum({ value: n, timer: 0, index: monIdx }) });
      battleSt.itemHealAmount = heal;
    } else {
      const curHP = getEnemyHP();
      const maxHP = pvpSt.isPVPBattle ? (pvpSt.pvpOpponentStats ? pvpSt.pvpOpponentStats.maxHP : 1) : BOSS_MAX_HP;
      const heal = Math.min(power, maxHP - curHP);
      setEnemyHP(curHP + heal); battleSt.itemHealAmount = heal; setEnemyHealNum({ value: heal, timer: 0, index: 0 });
    }
  }
  battleSt.battleState = 'item-use'; battleSt.battleTimer = 0;
}

function _playerTurnItem() {
  battleSt.isDefending = false;
  const pending = inputSt.playerActionPending;
  removeItem(pending.itemId);
  const item = ITEMS.get(pending.itemId);
  if (item?.type === 'battle_item') {
    const tm = pending.targetMode || 'single';
    startSpellCast(item.animSpellId, { enemyIndex: pending.target, targetMode: tm }, { isItemUse: true, itemId: pending.itemId });
  } else {
    _playerTurnConsumable();
  }
}

function _playerTurnMagic() {
  battleSt.isDefending = false;
  const pending = inputSt.playerActionPending;
  if (!pending) { processNextTurn(); return; }
  // pending.target === 'player' → friendly (player or ally via allyIndex).
  // pending.target is a number → enemy slot in encounter / PVP grid (or boss = 0).
  // pending.targetMode: 'single' | 'all' | 'col-left' | 'col-right' (set by the
  // target picker; multi-target Cure relies on this to build the target list).
  const tm = pending.targetMode || 'single';
  if (pending.target === 'player') {
    startSpellCast(pending.spellId, { allyIndex: pending.allyIndex ?? -1, targetMode: tm });
  } else {
    startSpellCast(pending.spellId, { enemyIndex: pending.target, targetMode: tm });
  }
  // MP changed; persist immediately so a crash doesn't refund the cost.
  saveSlotsToDB();
}

function _playerTurnRun() {
  // PvP flee always succeeds (cross-client lockstep doesn't have a stable
  // single source for the AGI-vs-level roll). Show the same RAN_AWAY +
  // SFX as a successful encounter flee.
  if (pvpSt.isPVPBattle) {
    queueBattleMsg(BATTLE_RAN_AWAY);
    playSFX(SFX.RUN_AWAY);
    battleSt.battleState = 'run-success';
    battleSt.battleTimer = 0;
    return;
  }
  const playerAgi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
  let avgLevel = 1;
  if (battleSt.encounterMonsters) {
    const alive = battleSt.encounterMonsters.filter(m => m.hp > 0);
    if (alive.length > 0) avgLevel = alive.reduce((s, m) => s + (m.level || 1), 0) / alive.length;
  }
  const successRate = Math.min(99, Math.max(1, playerAgi + 25 - Math.floor(avgLevel / 4)));
  // rand() (not Math.random) so any future code that depends on the RNG cursor
  // being in lockstep won't fork on a run attempt. Audit #4.
  if (Math.floor(rand() * 100) < successRate) {
    queueBattleMsg(BATTLE_RAN_AWAY);
    playSFX(SFX.RUN_AWAY);
    battleSt.battleState = 'run-success'; battleSt.battleTimer = 0;
  } else {
    queueBattleMsg(BATTLE_CANT_ESCAPE);
    battleSt.battleState = 'run-fail'; battleSt.battleTimer = 0;
  }
}
