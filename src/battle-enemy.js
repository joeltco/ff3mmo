// Battle enemy turn update logic — extracted from game.js

import { battleSt, getEnemyHP, setEnemyHP,
         BATTLE_SHAKE_MS, BATTLE_DMG_SHOW_MS, BOSS_PREFLASH_MS, BOSS_ATK,
         setEnemyAttackerTarget } from './battle-state.js';
import { dispatchDelta } from './deltas.js';
import { calcDamage, elemMultiplier, BOSS_HIT_RATE, GOBLIN_HIT_RATE } from './battle-math.js';
import { rand } from './rng.js';
import { getMyUserId } from './net.js';
import { ps, getShieldEvade } from './player-stats.js';
import { SFX, playSFX } from './music.js';
import { tryInflictStatus, blindHitPenalty, wakeOnHit, STATUS_NAME_BYTES } from './status-effects.js';
import { queueBattleMsg, replaceBattleMsg } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';
import { getPlayerDamageNum, setPlayerDamageNum, getAllyDamageNums } from './damage-numbers.js';
import { selectCursor, saveSlots } from './save-state.js';
import { COOP_HOST_ARB, resolveMonsterAttack, isCoopGuest } from './coop-resolver.js';

// Injected at boot — avoids circular import on main.js
let _processNextTurn = () => {};
let _isTeamWiped = () => false;
export function initBattleEnemy({ processNextTurn, isTeamWiped }) {
  _processNextTurn = processNextTurn;
  _isTeamWiped = isTeamWiped;
}

function _playerName() { return saveSlots[selectCursor]?.name || null; }

// ── Monster special attack definitions ─────────────────────────────────────
// Maps attack name → { type, power, hit, element, status }
// Derived from spells.js ROM data but kept flat here for battle use
const SPECIAL_ATTACKS = {
  'Fire':        { type: 'damage', power: 25, hit: 100, element: 'fire' },
  'Fira':        { type: 'damage', power: 55, hit: 100, element: 'fire' },
  'Firaga':      { type: 'damage', power: 150, hit: 100, element: 'fire' },
  'Bzzard':      { type: 'damage', power: 25, hit: 100, element: 'ice' },
  'Bzzara':      { type: 'damage', power: 55, hit: 100, element: 'ice' },
  'Bzzaga':      { type: 'damage', power: 85, hit: 100, element: 'ice' },
  'Thunder':     { type: 'damage', power: 35, hit: 100, element: 'bolt' },
  'Thundara':    { type: 'damage', power: 55, hit: 100, element: 'bolt' },
  'Thundaga':    { type: 'damage', power: 110, hit: 100, element: 'bolt' },
  'Tornado':     { type: 'damage', power: 4, hit: 40, element: 'air' },
  'Aeroga':      { type: 'damage', power: 115, hit: 100, element: null },
  'Quake':       { type: 'damage', power: 133, hit: 100, element: 'earth' },
  'Holy':        { type: 'damage', power: 160, hit: 100, element: 'holy' },
  'Flare':       { type: 'damage', power: 200, hit: 100, element: null },
  'Meteor':      { type: 'damage', power: 180, hit: 100, element: null },
  'Bio':         { type: 'damage', power: 130, hit: 100, element: null },
  'Drain':       { type: 'damage', power: 160, hit: 100, element: null },
  'Blind':       { type: 'status', hit: 60, status: 'blind' },
  'Poison':      { type: 'status', hit: 60, status: 'poison' },
  'Glare':       { type: 'status', hit: 80, status: 'paralysis' },
  'Sleep':       { type: 'status', hit: 15, status: 'sleep' },
  'Confuse':     { type: 'status', hit: 25, status: 'confuse' },
  'Toad':        { type: 'status', hit: 80, status: 'toad' },
  'Mini':        { type: 'status', hit: 80, status: 'mini' },
  'Silence':     { type: 'status', hit: 60, status: 'silence' },
  'Bad Breath':  { type: 'multi_status', hit: 60, statuses: ['poison', 'blind', 'silence', 'toad', 'mini'] },
  'Reflect':     { type: 'none' },
  'Sence':       { type: 'none' },
};

// ── Execute special attack against player or ally ──────────────────────────
function _doSpecialAttack(mon, spec, targetAlly = -1) {
  if (targetAlly >= 0) {
    const ally = battleSt.battleAllies[targetAlly];
    if (!ally || ally.hp <= 0) { _processNextTurn(); return; }
    if (spec.type === 'damage') {
      const eMult = elemMultiplier(spec.element, null, null);
      // NES magic damage (31/B1B4-BBE1): atk = floor(INT/2) + power, then +rand(0..atk/2), then -mdef
      const castStat = mon ? (mon.spiritInt || 0) : 0;
      const baseAtk = Math.floor(castStat / 2) + spec.power;
      const roll = baseAtk + Math.floor(rand() * (Math.floor(baseAtk / 2) + 1));
      const raw = Math.floor(roll * eMult) - (ally.mdef || 0);
      const dmg = Math.max(1, raw);
      dispatchDelta({ type: 'hp', target: ally, amount: -dmg });
      getAllyDamageNums()[targetAlly] = { value: dmg, timer: 0 };
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT);
      battleSt.battleState = 'ally-hit'; battleSt.battleTimer = 0;
    } else if (spec.type === 'status' && ally.status) {
      const applied = tryInflictStatus(ally.status, spec.status, spec.hit, ally.statusResist);
      getAllyDamageNums()[targetAlly] = applied
        ? { value: 0, timer: 0, status: spec.status }
        : { miss: true, timer: 0 };
      if (applied && STATUS_NAME_BYTES[applied]) replaceBattleMsg(STATUS_NAME_BYTES[applied]);
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    } else if (spec.type === 'multi_status' && ally.status) {
      let anyApplied = false;
      for (const s of spec.statuses) {
        const f = tryInflictStatus(ally.status, s, spec.hit, ally.statusResist);
        if (f) {
          anyApplied = true;
          if (STATUS_NAME_BYTES[f]) replaceBattleMsg(STATUS_NAME_BYTES[f]);
        }
      }
      getAllyDamageNums()[targetAlly] = anyApplied
        ? { value: 0, timer: 0, status: 'multi' }
        : { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    } else { _processNextTurn(); }
    return;
  }
  if (spec.type === 'damage') {
    // NES magic damage (31/B1B4-BBE1): atk = floor(INT/2) + power, then +rand(0..atk/2), then -mdef
    const eMult = elemMultiplier(spec.element, null, ps.elemResist);
    const castStat = mon ? (mon.spiritInt || 0) : 0;
    const baseAtk = Math.floor(castStat / 2) + spec.power;
    const roll = baseAtk + Math.floor(rand() * (Math.floor(baseAtk / 2) + 1));
    const raw = Math.floor(roll * eMult) - (ps.mdef || 0);
    const dmg = Math.max(1, raw);
    if (battleSt.isDefending) {
      const reduced = Math.max(1, Math.floor(dmg / 2));
      dispatchDelta({ type: 'hp', target: ps, amount: -reduced });
      setPlayerDamageNum({ value: reduced, timer: 0 });
    } else {
      dispatchDelta({ type: 'hp', target: ps, amount: -dmg });
      setPlayerDamageNum({ value: dmg, timer: 0 });
    }
    playSFX(SFX.ATTACK_HIT);
    battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
  } else if (spec.type === 'status' && ps.status) {
    const applied = tryInflictStatus(ps.status, spec.status, spec.hit, ps.statusResist);
    if (applied) {
      setPlayerDamageNum({ value: 0, timer: 0, status: spec.status });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      if (STATUS_NAME_BYTES[applied]) replaceBattleMsg(STATUS_NAME_BYTES[applied]);
    } else {
      setPlayerDamageNum({ miss: true, timer: 0 });
    }
    battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
  } else if (spec.type === 'multi_status' && ps.status) {
    let anyApplied = 0;
    for (const s of spec.statuses) {
      const result = tryInflictStatus(ps.status, s, spec.hit, ps.statusResist);
      if (result) {
        anyApplied = result;
        if (STATUS_NAME_BYTES[result]) replaceBattleMsg(STATUS_NAME_BYTES[result]);
      }
    }
    if (anyApplied) {
      setPlayerDamageNum({ value: 0, timer: 0, status: 'multi' });
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
    } else {
      setPlayerDamageNum({ miss: true, timer: 0 });
    }
    battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
  } else {
    // No-op attacks (Reflect, Sence, etc.) — msg drains independently
    _processNextTurn();
  }
}

// ── Enemy flash → targeting + hit calc ──────────────────────────────────────
function _processEnemyFlash() {
  if (battleSt.battleState !== 'enemy-flash' || battleSt.battleTimer < BOSS_PREFLASH_MS) return false;
  const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
  let targetAlly = -1;
  // Co-op random encounter (v1.7.419+) — both clients must pick the SAME
  // canonical actor for monster targeting. Without this, 'ps' on A's
  // screen is `ps=A, ally=B` and on B's it's `ps=B, ally=A`; same rand
  // result picks DIFFERENT logical actors → HP diverges. Use shared
  // `rand()` against a canonical-order team list (host first, then by
  // ascending userId) so both clients land on the same picked userId,
  // then map locally to ps (-1) or battleAllies[N].
  if (battleSt.isWireEncounter) {
    const team = [];
    const myUid = getMyUserId() | 0;
    if (ps.hp > 0) team.push({ userId: myUid, type: 'ps', localIdx: -1 });
    for (let i = 0; i < battleSt.battleAllies.length; i++) {
      const a = battleSt.battleAllies[i];
      if (a && a.hp > 0) team.push({ userId: a.userId | 0, type: 'ally', localIdx: i });
    }
    if (team.length > 0) {
      team.sort((x, y) => {
        const xHost = x.userId === battleSt.encounterHostUserId ? 0 : 1;
        const yHost = y.userId === battleSt.encounterHostUserId ? 0 : 1;
        if (xHost !== yHost) return xHost - yHost;
        return x.userId - y.userId;
      });
      const pickIdx = Math.floor(rand() * team.length);
      const picked = team[pickIdx];
      targetAlly = picked.type === 'ps' ? -1 : picked.localIdx;
    }
  } else if (livingAllies.length > 0) {
    const allyOptions = battleSt.battleAllies.map((a, i) => a.hp > 0 ? i : -1).filter(i => i >= 0);
    if (ps.hp <= 0) {
      targetAlly = allyOptions[Math.floor(rand() * allyOptions.length)];
    } else if (rand() >= 1 / (1 + livingAllies.length)) {
      targetAlly = allyOptions[Math.floor(rand() * allyOptions.length)];
    }
  }
  const mon = (battleSt.currentAttacker >= 0 && battleSt.encounterMonsters) ? battleSt.encounterMonsters[battleSt.currentAttacker] : null;

  // (Actor name is queued at turn dispatch — battle-turn.js — so its fade-in
  // overlaps the BOSS_PREFLASH_MS window and is visible by the time the swing lands.)

  // ── Monster special attack check ──────────────────────────────────────────
  if (mon && mon.spAtkRate > 0 && mon.attacks && mon.attacks.length > 0) {
    if (rand() * 100 < mon.spAtkRate) {
      const atkName = mon.attacks[Math.floor(rand() * mon.attacks.length)];
      const spec = SPECIAL_ATTACKS[atkName];
      if (spec && spec.type !== 'none') {
        // Monster name was queued at turn dispatch; swap in the attack name.
        replaceBattleMsg(_nameToBytes(atkName));
        _doSpecialAttack(mon, spec, targetAlly);
        return true;
      }
    }
  }

  let hitRate = mon ? (mon.hitRate || GOBLIN_HIT_RATE) : BOSS_HIT_RATE;
  if (mon && mon.status) hitRate *= blindHitPenalty(mon.status);
  const atk = mon ? mon.atk : BOSS_ATK;
  const rolls = mon ? (mon.attackRoll || 1) : 1;
  const monAtkElem = mon ? (mon.atkElem || null) : null;
  // NES multi-hit: roll attackRoll times, per-hit shield/evade/hitRate checks
  function rollMultiHit(def, targetResist, shieldEvade = 0, armorEvade = 0) {
    const eMult = elemMultiplier(monAtkElem, null, targetResist);
    let total = 0, landed = 0;
    for (let i = 0; i < rolls; i++) {
      if (shieldEvade > 0 && rand() * 100 < shieldEvade) continue;
      if (armorEvade > 0 && rand() * 100 < armorEvade) continue;
      if (rand() * 100 < hitRate) { total += calcDamage(atk, def, false, 0, eMult); landed++; }
    }
    return { total, landed };
  }
  if (targetAlly >= 0) {
    const attackerRef = battleSt.encounterMonsters && battleSt.encounterMonsters[battleSt.currentAttacker];
    setEnemyAttackerTarget(attackerRef, targetAlly);
    const ally = battleSt.battleAllies[targetAlly];
    const preStatusMask = (ally.status && ally.status.mask) | 0;
    const { total, landed } = rollMultiHit(ally.def, null, ally.shieldEvade || 0, ally.evade || 0);
    let finalDmg = 0;
    let miss = false;
    if (landed > 0) {
      // Co-op random encounter — wire-driven ally that picked Defend this
      // round has `ally.isDefending = true` set by
      // `_applyWireEncounterActionForAlly`. Halve incoming damage to match
      // the sender's view of their own defend. Round-end clear lives in
      // `processNextTurn` queue-empty branch. v1.7.419.
      finalDmg = ally.isDefending ? Math.max(1, Math.floor(total / 2)) : total;
      // Phase 6.7 — guest-side short-circuit. Skip the HP write; the
      // host's resolveMonsterAttack ships the authoritative damage and
      // the applier writes hp via the packet. Animation cues (shake,
      // damage-num, state transition) still fire.
      if (!isCoopGuest()) {
        dispatchDelta({ type: 'hp', target: battleSt.battleAllies[targetAlly], amount: -finalDmg });
      }
      getAllyDamageNums()[targetAlly] = { value: finalDmg, timer: 0 };
      battleSt.allyShakeTimer[targetAlly] = BATTLE_SHAKE_MS;
      playSFX(SFX.ATTACK_HIT); battleSt.battleState = 'ally-hit'; battleSt.battleTimer = 0;
    } else {
      miss = true;
      getAllyDamageNums()[targetAlly] = { miss: true, timer: 0 };
      battleSt.battleState = 'ally-damage-show-enemy'; battleSt.battleTimer = 0;
    }
    // Phase 6 — host-arb emit. Ships the final post-defend damage value +
    // any status-mask additions so guests apply identical state without
    // re-running rollMultiHit (which on guest's `ally`-path would use
    // different stat fields than the canonical ps-path the host runs).
    // Flag-gated: COOP_HOST_ARB=false → no-op. Live cut-over flips the
    // flag after two-phone smoke (see docs/COOP-PHASE-6-SMOKE.md).
    if (COOP_HOST_ARB && battleSt.isWireEncounter && battleSt.encounterIsHost && ally.userId) {
      const postStatusMask = (ally.status && ally.status.mask) | 0;
      resolveMonsterAttack({
        monsterIdx: battleSt.currentAttacker,
        target: { kind: 'player', userId: ally.userId | 0 },
        dmg:      finalDmg,
        miss,
        statusAdd: (postStatusMask & ~preStatusMask) >>> 0,
      });
    }
  } else {
    const shieldEvade = getShieldEvade();
    const preStatusMask = (ps.status && ps.status.mask) | 0;
    const { total, landed } = rollMultiHit(ps.def, ps.elemResist, shieldEvade, ps.evade);
    let finalDmg = 0;
    let miss = false;
    if (landed > 0) {
      let dmg = total;
      if (battleSt.isDefending) dmg = Math.max(1, Math.floor(dmg / 2));
      // Protect halves physical damage independently of Defend; both stack.
      // Canon FF3 NES Protect is physical-only — leave magic damage paths alone.
      if (ps.buffs && ps.buffs.protect) dmg = Math.max(1, Math.floor(dmg / 2));
      finalDmg = dmg;
      // Phase 6.7 — guest-side short-circuit. Skip HP write + status
      // mutations; host's resolveMonsterAttack ships the authoritative
      // values via the packet. Animations + state transition continue.
      const guestSkip = isCoopGuest();
      if (!guestSkip) {
        dispatchDelta({ type: 'hp', target: ps, amount: -dmg });
      }
      setPlayerDamageNum({ value: dmg, timer: 0 });
      // Physical hit wakes sleeping targets
      if (!guestSkip && ps.status) wakeOnHit(ps.status);
      // Monster statusAtk: try to inflict status on player
      if (!guestSkip) {
        const monStatus = mon ? mon.statusAtk : null;
        if (monStatus && ps.status) {
          const arr = Array.isArray(monStatus) ? monStatus : [monStatus];
          for (const s of arr) tryInflictStatus(ps.status, s, hitRate, ps.statusResist);
        }
      }
      playSFX(SFX.ATTACK_HIT);
      battleSt.battleShakeTimer = BATTLE_SHAKE_MS;
      battleSt.battleState = 'enemy-attack'; battleSt.battleTimer = 0;
    } else {
      miss = true;
      setPlayerDamageNum({ miss: true, timer: 0 });
      battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0;
    }
    // Phase 6 — host-arb emit. See ally-branch comment above. Status-mask
    // delta captures wake-on-hit + statusAtk inflict, so guest's view of
    // host's status converges exactly.
    if (COOP_HOST_ARB && battleSt.isWireEncounter && battleSt.encounterIsHost) {
      const postStatusMask = (ps.status && ps.status.mask) | 0;
      const myUid = getMyUserId() | 0;
      if (myUid) {
        resolveMonsterAttack({
          monsterIdx: battleSt.currentAttacker,
          target: { kind: 'player', userId: myUid },
          dmg:      finalDmg,
          miss,
          statusAdd: (postStatusMask & ~preStatusMask) >>> 0,
        });
      }
    }
  }
  return true;
}

// ── After damage show: check team wipe or advance ───────────────────────────
function _processEnemyDamageShowState() {
  if (battleSt.battleTimer < BATTLE_DMG_SHOW_MS) return;
  if (_isTeamWiped()) {
    battleSt.isDefending = false;
    battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close';
    battleSt.battleTimer = 0;
  } else { _processNextTurn(); }
}

export function updateBattleEnemyTurn() {
  if (_processEnemyFlash()) return true;
  if (battleSt.battleState === 'enemy-attack') {
    if (battleSt.battleTimer >= BATTLE_SHAKE_MS) { battleSt.battleState = 'enemy-damage-show'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'enemy-damage-show') { _processEnemyDamageShowState();
  } else { return false; }
  return true;
}
