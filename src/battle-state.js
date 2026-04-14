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
  battleMessage: null,      // Uint8Array for status messages
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
  _teamWipeMsgShown: false,

  // ── Item use ──────────────────────────────────────────────────────
  itemHealAmount: 0,

  // ── Battle canvases (init-once from ROM) ──────────────────────────
  goblinBattleCanvas: null,
  goblinWhiteCanvas: null,
  goblinDeathFrames: null,
};

// Boss constants (Adamantoise — monster 0xCC)
export const BOSS_ATK = _BOSS_DATA.atk;
export const BOSS_DEF = _BOSS_DATA.def;
export const BOSS_MAX_HP = _BOSS_DATA.hp;

// Battle timing constants
export const BATTLE_SHAKE_MS = 300;
export const BATTLE_DMG_SHOW_MS = DMG_SHOW_MS;
export const BOSS_PREFLASH_MS = 133;
export const MONSTER_DEATH_MS = 250;

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
