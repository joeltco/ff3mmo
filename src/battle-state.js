// Battle state — all mutable state for the combat system (encounter + boss + PVP).
//
// Single `battleSt` object so consumers read/write live values through object properties.
// Reassignment-sensitive fields (battleAllies, turnQueue, encounterMonsters, dyingMonsterIndices)
// must be assigned through `battleSt.X = ...` not cached in a local.
//
// `getEnemyHP`/`setEnemyHP` are PVP-aware: when a PVP duel is active, they read/write
// `pvpSt.pvpOpponentStats.hp` or the current target ally's HP. Otherwise they use
// `battleSt.enemyHP` (the non-PVP monster HP).

import { pvpSt } from './pvp.js';
import { DMG_SHOW_MS } from './damage-numbers.js';
import { MONSTERS } from './data/monsters.js';

const _BOSS_DATA = MONSTERS.get(0xCC) || { hp: 120, atk: 8, def: 1 };

export const battleSt = {
  // ── State machine ─────────────────────────────────────────────────
  battleState: 'none',
  battleTimer: 0,
  battleShakeTimer: 0,
  bossFlashTimer: 0,
  critFlashTimer: -1,
  isDefending: false,
  runSlideBack: false,
  enemyDefeated: false,

  // ── Random encounter ──────────────────────────────────────────────
  isRandomEncounter: false,
  encounterMonsters: null,  // [{ hp, maxHP, atk, def, exp }]
  encounterDropItem: null,
  encounterJobLevelUp: null,
  encounterExpGained: 0,
  encounterGilGained: 0,
  encounterCpGained: 0,
  preBattleTrack: null,

  // ── Co-op random encounter (v1.7.418+) ───────────────────────────
  // Wire-driven monster battle shared with party members. Mirror of
  // pvpSt._wire* fields. On host: emit encounter-start, mark allies
  // wire-driven so AI is skipped, wait for guest actions. On guest:
  // spawn battle from encounter-invite, host appears as battleAlly[0].
  isWireEncounter: false,
  encounterIsHost: false,
  encounterHostUserId: 0,
  encounterSeed: 0,
  encounterTurnIndex: 0,

  // ── Turn system ───────────────────────────────────────────────────
  turnQueue: [],            // [{type:'player'|'enemy'|'ally', index}]
  currentAttacker: -1,
  turnTimer: 0,             // auto-skip accumulator
  currentHitIdx: 0,
  comboStatusInflicted: 0,

  // ── Slash animation ───────────────────────────────────────────────
  slashFrame: 0,
  slashX: 0,
  slashY: 0,
  slashOffX: 0,
  slashOffY: 0,

  // ── Enemy (non-PVP) ───────────────────────────────────────────────
  enemyHP: _BOSS_DATA.hp,
  dyingMonsterIndices: new Map(), // index → startDelayMs

  // ── Allies ────────────────────────────────────────────────────────
  battleAllies: [],         // [{name, palIdx, level, hp, maxHP, atk, def, agi, fadeStep}]
  allyJoinTimer: 0,
  allyJoinRound: 0,
  currentAllyAttacker: -1,
  allyTargetIndex: -1,
  allyHitResult: null,
  allyHitResults: [],
  allyHitIdx: 0,
  allyHitIsLeft: false,
  allyShakeTimer: {},       // {allyIdx: ms remaining}
  allyExitTimer: 0,
  enemyTargetAllyIdx: -1,
  // v1.7.364 step 7/7 — per-attacker mirror of enemyTargetAllyIdx. Keyed by
  // the attacker combatant object (encounter monster, pvpOpponentStats, or
  // pvpEnemyAllies entry). Single-player play is turn-based so only one
  // entry is active at a time — the integer above tracks the currently-
  // animating attack. The Map is populated for the wire layer (future
  // multiplayer that may render parallel attacks). Readers stay on the
  // integer until the parallel-render refactor lands.
  enemyTargetAllyIdxByAttacker: new WeakMap(),

  // ── Ally cast (WM heal AI) ────────────────────────────────────────
  allyMagicCasterIdx: -1,             // ally index of the caster
  allyMagicTargetType: 'player',      // 'player' | 'ally'
  allyMagicTargetIdx: -1,             // ally index when target type is 'ally'
  allyMagicSpellId: 0,
  allyMagicHealAmount: 0,             // pre-rolled heal value
  allyMagicDamageRoll: 0,             // pre-rolled damage value for offensive casts (Fire/Bzzard/etc.)
  allyMagicEffectApplied: false,
  allyMagicSfxPlayed:    false,  // gated SFX at impact start, separate from apply timing
  allyMagicItemMode: false,           // true = consumable (potion/antidote), suppresses cast flame visual

  // ── Unified active cast (v1.7.362 step 5/7) ───────────────────────
  // Single source-of-truth for "who is casting what at whom right now,"
  // shared across player / ally / pvp-enemy roles. The legacy per-role
  // bags above (`allyMagic*`) and in `pvpSt.pvpMagic*` are still
  // populated for back-compat; the wire layer (future step 6/7) reads /
  // writes `activeCast` so a remote-player cast intent doesn't need to
  // know which legacy bag to target.
  //
  // Shape:
  //   { caster:    { faction: 'player' | 'ally' | 'pvp-enemy',
  //                  idx: number },
  //     spellId:   number,
  //     isItemUse: boolean,
  //     targets:   [{ faction, idx }, ...],   // mixed-faction allowed
  //     healAmount:    number,                // 0 if not a heal
  //     damageRoll:    number,                // 0 if rolled per-target
  //     hitIdx:        number,
  //     effectApplied: boolean,
  //     sfxPlayed:     boolean }
  activeCast: null,

  // ── Item use ──────────────────────────────────────────────────────
  itemHealAmount: 0,

  // ── Battle canvases (init-once from ROM) ──────────────────────────
  goblinBattleCanvas: null,
  goblinWhiteCanvas: null,
  goblinDeathFrames: null,
};

// v1.7.362 step 5/7 — unified active-cast helpers. Every cast-start site
// (player startSpellCast, ally _tryAlly* AI, pvp-enemy _tryPVPEnemy* AI)
// calls `setActiveCast` so the wire layer has one place to read. Legacy
// per-role state bags continue to be populated by their existing writers
// — readers haven't migrated yet, so single-player play is unchanged.
// v1.7.364 step 7/7 — set both the legacy single integer AND the per-
// attacker WeakMap. Callers pass `attackerRef` as the attacker combatant
// object (so refs are GC'd when the battle ends). Pass null for resets
// that don't correspond to a specific attacker.
export function setEnemyAttackerTarget(attackerRef, targetAllyIdx) {
  battleSt.enemyTargetAllyIdx = targetAllyIdx;
  if (attackerRef) {
    battleSt.enemyTargetAllyIdxByAttacker.set(attackerRef, targetAllyIdx);
  }
}

export function setActiveCast(cast) {
  battleSt.activeCast = {
    caster:        cast.caster,
    spellId:       cast.spellId,
    isItemUse:     !!cast.isItemUse,
    targets:       cast.targets || [],
    healAmount:    cast.healAmount || 0,
    damageRoll:    cast.damageRoll || 0,
    hitIdx:        0,
    effectApplied: false,
    sfxPlayed:     false,
  };
}

export function clearActiveCast() {
  battleSt.activeCast = null;
}

export function getActiveCast() {
  return battleSt.activeCast;
}

// Boss constants (Adamantoise — monster 0xCC)
export const BOSS_ATK = _BOSS_DATA.atk;
export const BOSS_DEF = _BOSS_DATA.def;
export const BOSS_MAX_HP = _BOSS_DATA.hp;

// Battle timing constants
export const BATTLE_SHAKE_MS = 300;
export const BATTLE_DMG_SHOW_MS = DMG_SHOW_MS;
export const BOSS_PREFLASH_MS = 133;
export const MONSTER_DEATH_MS = 250;

// Battle text fade — drives menu / message strip / item-list fade-in/out.
// 4 fade steps × 50 ms = 200 ms full fade. Was duplicated as local
// constants in battle-draw-menu.js, battle-update.js, and pvp.js pre-v1.7.217.
export const BATTLE_TEXT_STEPS   = 4;
export const BATTLE_TEXT_STEP_MS = 50;

// Player + ally death-animation timing — three-phase choreography:
//   Phase 1 (DEATH_SLIDE_MS): kneel portrait slides down 16 px.
//   Phase 2 (DEATH_TXTFADE_MS): name / HP text fades to alpha 0.
//   Phase 3 (DEATH_POSEFADE_MS): prone death-pose sprite fades in.
// Player and ally use the SAME timing (1100 ms total). Previously
// duplicated in both battle-draw-player.js and battle-draw-allies.js;
// hud-drawing.js had its own derived 500/800/300 constants. v1.7.213
// consolidates here so any tweak applies everywhere.
export const DEATH_SLIDE_MS    = 500;
export const DEATH_TXTFADE_MS  = 300;
export const DEATH_POSEFADE_MS = 300;
export const DEATH_TOTAL_MS    = DEATH_SLIDE_MS + DEATH_TXTFADE_MS + DEATH_POSEFADE_MS;
// Convenience: the info-panel hide point (after slide + text-fade).
export const DEATH_INFO_HIDE_MS = DEATH_SLIDE_MS + DEATH_TXTFADE_MS;

// PVP-aware enemy HP accessors.
// NOTE: `setEnemyHP` writes battleSt.enemyHP unconditionally (even in PVP) — preserve this
// behavior; some non-PVP code paths rely on the fallback being always-updated.
export function getEnemyHP() {
  if (pvpSt.isPVPBattle) {
    if (pvpSt.pvpPlayerTargetIdx < 0) return pvpSt.pvpOpponentStats.hp;
    return pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx].hp;
  }
  return battleSt.enemyHP;
}
export function setEnemyHP(v) {
  if (pvpSt.isPVPBattle) {
    if (pvpSt.pvpPlayerTargetIdx < 0) pvpSt.pvpOpponentStats.hp = v;
    else pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx].hp = v;
  }
  battleSt.enemyHP = v;
}
