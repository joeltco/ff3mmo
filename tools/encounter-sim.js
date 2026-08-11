#!/usr/bin/env node
// tools/encounter-sim.js — monster-attack lockstep verification harness.
//
// Probes the unified `_processEnemyFlash` code path in `src/battle-enemy.js`
// for symmetry between ps-target and ally-target outcomes. Catches the
// v1.7.472 divergence class (element resist / Protect / wake-on-hit /
// status infliction asymmetry) without requiring a live two-phone test.
//
// Approach: for each scenario, set up identical ps and ally combatants,
// then run a single monster flash twice — once forced to target ps, once
// forced to target the ally. Damage delta + status mask after the hit
// must be IDENTICAL. Any divergence means the unified path still has an
// asymmetric branch.
//
// Determinism is verified separately: same seed × same setup × twice
// produces identical state.
//
// Usage:
//   node tools/encounter-sim.js
//   node tools/encounter-sim.js --filter=protect

// ── Browser shims (cloned from coop-viewer-sim.js — battle-enemy.js
//    transitively imports modules that touch DOM/audio/storage globals
//    at load time) ───────────────────────────────────────────────────────
const _stubEl = () => ({
  style:           {},
  classList:       { add: () => {}, remove: () => {}, toggle: () => {} },
  appendChild:     () => {}, removeChild: () => {},
  setAttribute:    () => {}, getAttribute: () => null,
  parentNode:      null,
  getContext:      () => ({
    fillRect: () => {}, drawImage: () => {}, save: () => {}, restore: () => {},
    translate: () => {}, scale: () => {}, rotate: () => {},
    beginPath: () => {}, closePath: () => {}, stroke: () => {}, fill: () => {},
    arc: () => {}, moveTo: () => {}, lineTo: () => {},
    createImageData: () => ({ data: new Uint8ClampedArray() }),
    putImageData: () => {}, getImageData: () => ({ data: new Uint8ClampedArray() }),
    measureText: () => ({ width: 0 }), fillText: () => {}, strokeText: () => {},
    clearRect: () => {}, clip: () => {}, setTransform: () => {},
    canvas: { width: 0, height: 0 },
  }),
});

globalThis.window = {
  addEventListener:    () => {},
  removeEventListener: () => {},
  location:            { href: '' },
  devicePixelRatio:    1,
  innerWidth:          800,
  innerHeight:         600,
};
globalThis.document = {
  createElement:    _stubEl,
  getElementById:   _stubEl,
  querySelector:    _stubEl,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body:             { appendChild: () => {}, querySelector: () => null },
  head:             { appendChild: () => {} },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame  = () => {};
globalThis.Image = class { constructor() { this.onload = null; } };
globalThis.Audio = class { constructor() {} play() {} pause() {} };
globalThis.AudioContext = class {
  constructor() {}
  createGain()         { return { gain: { value: 0 }, connect: () => {} }; }
  createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; }
  decodeAudioData()    { return Promise.resolve({}); }
  get destination()    { return {}; }
};
globalThis.Worker = class {
  constructor() {}
  postMessage()       {}
  addEventListener()  {}
  terminate()         {}
};
globalThis.localStorage = {
  _kv: new Map(),
  getItem(k)    { return this._kv.has(k) ? this._kv.get(k) : null; },
  setItem(k, v) { this._kv.set(k, String(v)); },
  removeItem(k) { this._kv.delete(k); },
  clear()       { this._kv.clear(); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; }
  send()              {}
  close()             {}
  addEventListener()  {}
  removeEventListener() {}
};

// ── Imports (after shims) ──────────────────────────────────────────────
const { battleSt } = await import('../src/battle-state.js');
const { ps }       = await import('../src/player-stats.js');
const battleEnemy  = await import('../src/battle-enemy.js');
const rngMod       = await import('../src/rng.js');
const statusMod    = await import('../src/status-effects.js');
const battleTurn   = await import('../src/battle-turn.js');
const { inputSt, keys, handleBattleInput } = await import('../src/input-handler.js');
const { executeBattleCommand } = await import('../src/battle-update.js');
const { JOBS, jobHasMagic } = await import('../src/data/jobs.js');
const { jobToCastKey, hasCapturedSpellAnim, capturedOneShotMs, healImpactWindowMs,
        CAST_PHASE_MS_HEAL } = await import('../src/cast-anim.js');
const { CAPTURED_SPELL_ANIMS } = await import('../src/data/spell-anim-captured.js');
const { SCREEN_PLACEMENT } = await import('../src/spell-anim.js');
const { isScreenAnchoredSpell, CAST_PHASE_MS, CAST_T_HEAL_APPLY,
        CAST_T_HEAL_ANIM_START, CAST_T_HEAL_ANIM_END } = await import('../src/cast-anim.js');
const { spellUsesCastAnim, screenShakeCueMs, startSpellCast, updateSpellCast,
        getCastAnimElapsedMs } = await import('../src/spell-cast.js');
const { getSpellImpactSFX, healStyleRenderWindow } = await import('../src/combatant-cast.js');
const { SPELLS, isMultiTargetSpell, MULTI_TARGET_SPELLS, spellStatusMask, getSpellBuyPrice } = await import('../src/data/spells.js');
const { applySpell } = await import('../src/combatant-cast.js');
const { addStatus, tryInflictStatus } = await import('../src/status-effects.js');
const { processNextTurn } = await import('../src/battle-turn.js');
const { addItem, releaseOffhandForTwoHanded } = await import('../src/inventory.js');
const { isQuestItem, QUEST_ITEM_TYPES, ITEMS } = await import('../src/data/items.js');
const { isSellable } = await import('../src/shop.js');
const { SHOPS } = await import('../src/data/shops.js');
const { normalizeGrip, isDualWield, computeRealizedStats } = await import('../src/realized-stats.js');
const { calcPotentialHits, rollHits } = await import('../src/battle-math.js');
const { hasStatus } = await import('../src/status-effects.js');
// Turn dispatch queues the actor's NAME on the battle strip, which reads the
// ROM string table. Feed it the real ROM when it is there; the confuse test is
// the only one that walks that path, and it skips itself if it is not.
const { initTextDecoder } = await import('../src/text-decoder.js');
let _romLoaded = false;
let _romBytes = null;
try {
  const { readFileSync } = await import('node:fs');
  _romBytes = new Uint8Array(readFileSync(new URL('../FF3-English.nes', import.meta.url)));
  initTextDecoder(_romBytes);
  _romLoaded = true;
} catch { /* no ROM in this checkout — the ROM-dependent tests report themselves skipped */ }
const { sweepFloors, PASS } = await import('./dungeon-sweep.mjs');
const { generateFloor } = await import('../src/dungeon-generator.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { SUMMON_TIERS } = await import('../src/data/summon-tiers.js');
const { elemMultiplier } = await import('../src/battle-math.js');
const { updateBattlePlayerAttack, updatePoisonTick } = await import('../src/battle-update.js');
const { updateBattleAlly } = await import('../src/battle-ally.js');
const { DMG_SHOW_MS, getEnemyDmgNum } = await import('../src/damage-numbers.js');
const { BACK_SWING_MS, FWD_SWING_MS, HIT_PAUSE_MS, SWING_HOLD_MS } = await import('../src/slash-effects.js');

const { updateBattleEnemyTurn, initBattleEnemy } = battleEnemy;
const { createStatusState, STATUS } = statusMod;

// Pre-init the injected callbacks so `_processNextTurn` is a no-op (we
// don't want the FSM to cascade after the flash — we measure exactly one
// monster swing per call).
initBattleEnemy({
  processNextTurn: () => {},
  isTeamWiped:     () => false,
});

// ── Test fixtures ──────────────────────────────────────────────────────
// Minimal monster stat objects — only the fields _processEnemyFlash
// reads. Real ROM data isn't required; we want predictable inputs.

function mkMonster(over = {}) {
  return {
    monsterId:    0x00,
    hp:           30,
    maxHP:        30,
    atk:          12,
    attackRoll:   1,
    def:          5,
    evade:        0,
    mdef:         0,
    hitRate:      100,           // always lands so we measure damage every flash
    atkElem:      null,
    spAtkRate:    0,
    statusAtk:    null,
    status:       createStatusState(),
    level:        1, agi: 1,
    spiritInt:    0,
    ...over,
  };
}

const goblin        = mkMonster();
const fireMonster   = mkMonster({ atkElem: 'fire' });
const poisonMonster = mkMonster({ statusAtk: 'poison' });

// ── Setup / teardown ───────────────────────────────────────────────────

function setupEncounter({ psStats, allyStats, monster, seed }) {
  rngMod.seed(seed);
  // ps — only the fields the unified path reads. `weaponR/L = 0xFF` keeps
  // ITEMS.get(...) undefined → getShieldEvade() returns 0 → no shield-
  // evade rand consumed.
  Object.assign(ps, {
    hp: 100, maxHP: 100,
    mp: 0,   maxMP: 0,
    def: 10, evade: 0, mdef: 0,
    statusResist: 0,
    elemResist:   [],
    buffs:        {},
    hitRate:      80,
    weaponR: 0xFF, weaponL: 0xFF,
    head: 0xFF, body: 0xFF, arms: 0xFF,
    status: createStatusState(),
  });
  Object.assign(ps, psStats || {});

  battleSt.battleAllies = [{
    userId:       0,
    def:          10, evade: 0, shieldEvade: 0, mdef: 0,
    statusResist: 0,
    elemResist:   [],
    buffs:        {},
    hp:           100, maxHP: 100,
    isDefending:  false,
    status:       createStatusState(),
    ...(allyStats || {}),
  }];
  battleSt.encounterMonsters = [monster];
  battleSt.currentAttacker   = 0;
  battleSt.isRandomEncounter = true;
  battleSt.isWireEncounter   = false;
  battleSt.battleState       = 'enemy-flash';
  battleSt.battleTimer       = 1000;        // > BOSS_PREFLASH_MS
  battleSt.battleShakeTimer  = 0;
  battleSt.allyShakeTimer    = [0];
  battleSt.isDefending       = false;
}

// Force the targeting to pick ps or the ally by killing the other side.
// The targeting code in `_processEnemyFlash` consumes 1 rand call when
// `livingAllies.length > 0`, and 0 when livingAllies is empty. We
// pre-consume 1 rand on the ps-target path so both runs land on the
// damage-roll phase with the same RNG cursor.
function runFlashWithTarget(target) {
  if (target === 'ps') {
    battleSt.battleAllies[0].hp = 0;   // ally dead → livingAllies = [] → 0 targeting rand
    rngMod.rand();                      // pre-consume to match ally-target's 1 rand
  } else {
    ps.hp = 0;                          // ps dead → ally is forced target, consumes 1 rand
  }
  updateBattleEnemyTurn();
}

function snapshot() {
  return {
    psHp:       ps.hp | 0,
    psMask:     (ps.status && ps.status.mask) | 0,
    allyHp:     battleSt.battleAllies[0] ? battleSt.battleAllies[0].hp | 0 : -1,
    allyMask:   (battleSt.battleAllies[0] && battleSt.battleAllies[0].status && battleSt.battleAllies[0].status.mask) | 0,
    battleState: battleSt.battleState,
  };
}

// ── Test primitives ────────────────────────────────────────────────────

// Same setup × same seed × twice → identical post-flash snapshot.
function determinismTest({ name, psStats, allyStats, monster, seed, target }) {
  setupEncounter({ psStats, allyStats, monster, seed });
  runFlashWithTarget(target);
  const a = snapshot();
  setupEncounter({ psStats, allyStats, monster, seed });
  runFlashWithTarget(target);
  const b = snapshot();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    return { pass: false, name, reason: `A=${JSON.stringify(a)} B=${JSON.stringify(b)}` };
  }
  return { pass: true, name };
}

// Identical stats on both sides → monster does identical damage and
// status changes regardless of target type.
function symmetryTest({ name, psStats, allyStats, monster, seed, defending }) {
  // Run A — target = ps
  setupEncounter({ psStats, allyStats, monster, seed });
  if (defending) battleSt.isDefending = true;
  const psStart = { hp: ps.hp, mask: (ps.status && ps.status.mask) | 0 };
  runFlashWithTarget('ps');
  const psDamage = psStart.hp - ps.hp;
  const psStatusDelta = ((ps.status && ps.status.mask) | 0) ^ psStart.mask;

  // Run B — target = ally. If `defending`, set ally.isDefending too
  // (separate field from battleSt.isDefending).
  setupEncounter({
    psStats,
    allyStats: defending ? { ...(allyStats || {}), isDefending: true } : allyStats,
    monster,
    seed,
  });
  const ally = battleSt.battleAllies[0];
  const aStart = { hp: ally.hp, mask: (ally.status && ally.status.mask) | 0 };
  runFlashWithTarget('ally');
  const allyDamage = aStart.hp - battleSt.battleAllies[0].hp;
  const allyStatusDelta = ((battleSt.battleAllies[0].status && battleSt.battleAllies[0].status.mask) | 0) ^ aStart.mask;

  if (psDamage !== allyDamage || psStatusDelta !== allyStatusDelta) {
    return {
      pass: false,
      name,
      reason: `psDmg=${psDamage} allyDmg=${allyDamage} | psStatusDelta=0x${psStatusDelta.toString(16)} allyStatusDelta=0x${allyStatusDelta.toString(16)}`,
    };
  }
  return { pass: true, name, info: `dmg=${psDamage} statusDelta=0x${psStatusDelta.toString(16)}` };
}

// Sanity — confirm the unified path actually applies the feature being
// tested (e.g. elemResist really reduces damage). If this fails, the
// symmetry test is meaningless: it'd be "both targets buggy in the
// same way."
function sanityReductionTest({ name, monster, withFeature, seed = 42, expectReduction = true }) {
  // Baseline — no feature
  setupEncounter({ psStats: {}, allyStats: {}, monster, seed });
  const baseStart = ps.hp;
  runFlashWithTarget('ps');
  const baseDmg = baseStart - ps.hp;

  // With feature — apply the feature to ps
  setupEncounter({ psStats: withFeature, allyStats: {}, monster, seed });
  const featStart = ps.hp;
  runFlashWithTarget('ps');
  const featDmg = featStart - ps.hp;

  if (expectReduction && !(featDmg < baseDmg)) {
    return { pass: false, name, reason: `expected reduction; baseline=${baseDmg} feature=${featDmg}` };
  }
  if (!expectReduction && featDmg !== baseDmg) {
    return { pass: false, name, reason: `expected no change; baseline=${baseDmg} feature=${featDmg}` };
  }
  return { pass: true, name, info: `baseline=${baseDmg} feature=${featDmg}` };
}

// ── Test list ──────────────────────────────────────────────────────────

const tests = [
  // Determinism — same seed twice → same outcome (proves the path is RNG-pure)
  () => determinismTest({ name: 'determinism — ps target',   monster: goblin, target: 'ps',   seed: 42 }),
  () => determinismTest({ name: 'determinism — ally target', monster: goblin, target: 'ally', seed: 42 }),

  // Sanity — features the unified path adds actually do something
  () => sanityReductionTest({
    name: 'sanity — elemResist reduces fire damage',
    monster: fireMonster,
    withFeature: { elemResist: ['fire'] },
    seed: 42,
  }),
  () => sanityReductionTest({
    name: 'sanity — Protect halves physical damage',
    monster: goblin,
    withFeature: { buffs: { protect: true } },
    seed: 42,
  }),

  // Symmetry — ps-target and ally-target outcomes must match for the
  // same input. Any divergence here means the unified branch still
  // has an asymmetric read.
  () => symmetryTest({ name: 'symmetry — baseline physical',  monster: goblin, seed: 42 }),
  () => symmetryTest({ name: 'symmetry — baseline physical (alt seed)', monster: goblin, seed: 99 }),
  () => symmetryTest({
    name: 'symmetry — elemResist (both fire)',
    psStats:   { elemResist: ['fire'] },
    allyStats: { elemResist: ['fire'] },
    monster: fireMonster,
    seed: 42,
  }),
  () => symmetryTest({
    name: 'symmetry — Protect on both',
    psStats:   { buffs: { protect: true } },
    allyStats: { buffs: { protect: true } },
    monster: goblin,
    seed: 42,
  }),
  () => symmetryTest({
    name: 'symmetry — Defend on both',
    monster: goblin,
    seed: 42,
    defending: true,
  }),
  () => symmetryTest({
    name: 'symmetry — statusAtk poison',
    monster: poisonMonster,
    seed: 7,
  }),
  () => symmetryTest({
    name: 'symmetry — statusAtk poison (alt seed)',
    monster: poisonMonster,
    seed: 13,
  }),

  // wake-on-hit — a sleeping target must wake when struck. Asymmetric in
  // v1.7.472: ps-branch called wakeOnHit, ally-branch didn't. Unified
  // path calls it for both.
  () => {
    const name = 'symmetry — wake-on-hit (sleeping target wakes)';
    // Run A — ps starts asleep, gets hit
    setupEncounter({ psStats: {}, allyStats: {}, monster: goblin, seed: 42 });
    ps.status.mask |= STATUS.SLEEP;
    runFlashWithTarget('ps');
    const psWoke = !(ps.status.mask & STATUS.SLEEP);
    // Run B — ally starts asleep, gets hit
    setupEncounter({ psStats: {}, allyStats: {}, monster: goblin, seed: 42 });
    battleSt.battleAllies[0].status.mask |= STATUS.SLEEP;
    runFlashWithTarget('ally');
    const allyWoke = !(battleSt.battleAllies[0].status.mask & STATUS.SLEEP);
    if (psWoke !== allyWoke) {
      return { pass: false, name, reason: `psWoke=${psWoke} allyWoke=${allyWoke}` };
    }
    if (!psWoke) {
      return { pass: false, name, reason: 'neither target woke — sanity failure (wakeOnHit not firing)' };
    }
    return { pass: true, name, info: `both targets woke` };
  },
  // Regression — a PLAYER turn dispatched with no pending action must not throw.
  // Production crashed here twice (v1.7.842): `processNextTurn` dereferenced
  // `inputSt.playerActionPending.command` and killed the game loop, taking the
  // player sprite and HUD with it. Both live stacks had queueLen 1 and a battle
  // still running, reached via `_advancePVPTurnOrEnd` and `_updatePVPMenuConfirm`.
  () => {
    const name = 'regression — player turn with null playerActionPending';
    const savedQueue = battleSt.turnQueue, savedState = battleSt.battleState;
    const savedAllies = battleSt.battleAllies, savedPending = inputSt.playerActionPending;
    const savedHp = ps.hp, savedStatus = ps.status;
    try {
      ps.hp = 38; ps.status = 0;
      battleSt.battleAllies = [];
      battleSt.turnQueue = [{ type: 'player', priority: 100 }];
      battleSt.battleState = 'pvp-enemy-magic-hit';
      inputSt.playerActionPending = null;
      battleTurn.processNextTurn();
      if (battleSt.battleState !== 'menu-open') {
        return { pass: false, name, reason: `expected menu-open (control returned), got ${battleSt.battleState}` };
      }
      return { pass: true, name, info: 'advanced to menu-open instead of throwing' };
    } catch (e) {
      return { pass: false, name, reason: `still throws: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.turnQueue = savedQueue; battleSt.battleState = savedState;
      battleSt.battleAllies = savedAllies; inputSt.playerActionPending = savedPending;
      ps.hp = savedHp; ps.status = savedStatus;
    }
  },
  // Regression — the battle item menu's PHANTOM last-page rows must not crash.
  // `buildItemSelectList` pads to INV_SLOTS (16) but the menu pages by
  // BATTLE_INV_ROWS (3), and 16 % 3 != 0, so the last page addresses indices
  // 15/16/17 against a 16-element array. Rows 2 and 3 read back `undefined`,
  // which passed the `!== null` emptiness check — so a first Z "picked up" a
  // slot that does not exist and the second Z died on `item.id`, taking the
  // game loop with it (v1.7.843). Drives the real production path:
  // handleBattleInput -> _battleInputItemSelect -> _itemSelectZ.
  () => {
    const name = 'regression — battle item menu phantom last-page row';
    const savedState = battleSt.battleState, savedList = inputSt.itemSelectList;
    const savedPage = inputSt.itemPage, savedCursor = inputSt.itemPageCursor;
    const savedHeld = inputSt.itemHeldIdx, savedMode = inputSt.menuMode;
    const savedPending = inputSt.playerActionPending;
    try {
      const list = [{ id: 0x40, count: 1 }];
      while (list.length < 16) list.push(null);        // exactly what the builder emits
      inputSt.itemSelectList = list;
      inputSt.menuMode = 'item';
      inputSt.itemHeldIdx = -1;
      inputSt.playerActionPending = null;
      battleSt.battleState = 'item-select';
      inputSt.itemPage = 6;                            // last inventory page
      inputSt.itemPageCursor = 1;                      // -> invIdx 16, past the end
      const invIdx = (inputSt.itemPage - 1) * 3 + inputSt.itemPageCursor;
      if (invIdx < list.length) {
        return { pass: false, name, reason: `test is stale: invIdx ${invIdx} is in range of ${list.length}` };
      }
      keys['z'] = true; handleBattleInput();           // pick up the phantom slot
      if (inputSt.itemHeldIdx !== -1) {
        return { pass: false, name, reason: `phantom row was picked up (itemHeldIdx=${inputSt.itemHeldIdx})` };
      }
      keys['z'] = true; handleBattleInput();           // pre-fix: threw on item.id
      return { pass: true, name, info: `invIdx ${invIdx} past end of ${list.length} rejected as empty` };
    } catch (e) {
      return { pass: false, name, reason: `still throws: ${e && e.message ? e.message : String(e)}` };
    } finally {
      keys['z'] = false;
      battleSt.battleState = savedState; inputSt.itemSelectList = savedList;
      inputSt.itemPage = savedPage; inputSt.itemPageCursor = savedCursor;
      inputSt.itemHeldIdx = savedHeld; inputSt.menuMode = savedMode;
      inputSt.playerActionPending = savedPending;
    }
  },
  // Regression — picking Magic must OPEN the magic menu for every caster job.
  // Reported live: "selecting magic as a sage doesn't pull up magic menu and
  // still uses guard sequence". v1.7.840 widened the battle menu's LABEL rule
  // to read `job.magic` but left an inline `jobIdx === 3 || 4 || 5` in
  // `executeBattleCommand`, so Conjurer, Summoner, Devout, Magus and Sage all
  // showed "Magic" and ran DEFEND. Drives the real dispatch. v1.7.844.
  () => {
    const name = 'regression — Magic opens the magic menu for every caster job';
    const savedJob = ps.jobIdx, savedKnown = ps.knownSpells, savedStatus = ps.status;
    const savedState = battleSt.battleState, savedMode = inputSt.menuMode;
    const savedDefending = battleSt.isDefending, savedPending = inputSt.playerActionPending;
    const broken = [];
    try {
      for (let jobIdx = 0; jobIdx < JOBS.length; jobIdx++) {
        if (!jobHasMagic(jobIdx)) continue;              // non-casters keep Defend
        ps.jobIdx = jobIdx; ps.status = 0; ps.knownSpells = [0x31, 0x34];
        battleSt.isDefending = false;
        inputSt.playerActionPending = null;
        inputSt.menuMode = 'item';
        battleSt.battleState = 'menu-open';
        executeBattleCommand(1);                          // slot 1 = Guard | Magic
        const openedMagic = inputSt.menuMode === 'magic' && battleSt.battleState === 'item-menu-out';
        const ranDefend = battleSt.isDefending
          || (inputSt.playerActionPending && inputSt.playerActionPending.command === 'defend');
        if (!openedMagic || ranDefend) {
          broken.push(`${JOBS[jobIdx].name || jobIdx}${ranDefend ? ' (ran DEFEND)' : ''}`);
        }
      }
      if (broken.length) {
        return { pass: false, name, reason: `label says Magic but slot 1 does not open it: ${broken.join(', ')}` };
      }
      // Every caster must also resolve a cast VISUAL, or it casts invisibly.
      // Summons are exempt: they own their whole presentation.
      const noVisual = [];
      for (let jobIdx = 0; jobIdx < JOBS.length; jobIdx++) {
        if (!jobHasMagic(jobIdx)) continue;
        for (const spellId of [0x31, 0x34]) {             // one black, one white
          if (!jobToCastKey(jobIdx, spellId)) noVisual.push(`${JOBS[jobIdx].name || jobIdx}/0x${spellId.toString(16)}`);
        }
      }
      if (noVisual.length) {
        return { pass: false, name, reason: `caster resolves no cast visual: ${noVisual.join(', ')}` };
      }
      return { pass: true, name, info: 'all caster jobs open Magic and resolve a cast visual' };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      ps.jobIdx = savedJob; ps.knownSpells = savedKnown; ps.status = savedStatus;
      battleSt.battleState = savedState; inputSt.menuMode = savedMode;
      battleSt.isDefending = savedDefending; inputSt.playerActionPending = savedPending;
    }
  },
  // Regression — EVERY captured spell animation must actually be reachable in
  // battle, and long one-shots must not be cut off.
  //
  // Reported live: "just casted meteo, wheres the meteors". 24 of the 37
  // captured animations were built at boot and never drawn, because which
  // spells got an animation was decided by two hardcoded element/target
  // whitelists (`_isCastAnimSpell`, `isThrown`) written when only
  // Fire/Ice/Bolt/Cure existed. Meteo is non-elemental, so it matched neither
  // and `getCastAnimElapsedMs` returned -1 — the renderer bailed on its first
  // check. This test fails if a future capture lands without being reachable,
  // which is exactly how the gap went unnoticed. v1.7.845.
  () => {
    const name = 'regression — every captured spell animation is reachable and untruncated';
    const dark = [], truncated = [];
    for (const [id] of CAPTURED_SPELL_ANIMS) {
      // BOTH halves: the shared helper AND the engine gate that consumes it.
      if (!hasCapturedSpellAnim(id) || !spellUsesCastAnim(id)) dark.push('0x' + id.toString(16));
      const need = capturedOneShotMs(id);
      if (need > healImpactWindowMs(id)) truncated.push(`0x${id.toString(16)} needs ${need}ms`);
    }
    if (dark.length) return { pass: false, name, reason: `captured but unreachable: ${dark.join(', ')}` };
    if (truncated.length) return { pass: false, name, reason: `impact window too short: ${truncated.join(', ')}` };
    // Cycling target bursts must NOT be stretched — they loop, so a longer
    // window would delay the damage number for no visual gain.
    const stretched = [];
    for (const [id, e] of CAPTURED_SPELL_ANIMS) {
      if (e.anchor !== 'screen' && healImpactWindowMs(id) !== CAST_PHASE_MS_HEAL.impact) {
        stretched.push('0x' + id.toString(16));
      }
    }
    if (stretched.length) return { pass: false, name, reason: `cycling burst wrongly stretched: ${stretched.join(', ')}` };
    return { pass: true, name, info: `${CAPTURED_SPELL_ANIMS.size} captured animations reachable, none truncated` };
  },
  // Regression — a screen-anchored effect must stay inside the map/battle HUD.
  //
  // The captured band is the full 256 px NES screen, but the battle view is
  // only the LEFT 144 px; x 144..256 is the player roster box. Mapping x 1:1
  // put Quake's crack at x 160..208 — entirely INSIDE the roster box — and
  // spilled Meteo out to 248. Reported live as "why isnt meteo staying within
  // the map hud" and "why the fuck is quake in the player roster box". v1.7.846.
  () => {
    const name = 'regression — screen-anchored effects stay inside the battle HUD';
    const HUD_VIEW_W = 144, TILE = 8;
    const spills = [], badPin = [];
    for (const [id, e] of CAPTURED_SPELL_ANIMS) {
      if (e.anchor !== 'screen') continue;
      const f = HUD_VIEW_W / e.width;
      let lo = Infinity, hi = -Infinity;
      for (const layout of e.layouts) for (const l of layout) {
        const x = Math.round(l[1] * f);
        if (x < lo) lo = x;
        if (x + TILE > hi) hi = x + TILE;
      }
      const place = SCREEN_PLACEMENT[id];
      if (place && place.pinCenterX != null) {
        // Pinned spells are a DELIBERATE exception: Quake straddles the
        // boundary by design. Assert the straddle rather than containment —
        // a pin that ended up wholly on one side would be just as wrong.
        const dx = Math.round(place.pinCenterX - (lo + hi) / 2);
        const [pLo, pHi] = [lo + dx, hi + dx];
        if (!(pLo < place.pinCenterX && pHi > place.pinCenterX)) {
          badPin.push(`0x${id.toString(16)} spans ${pLo}..${pHi}, not straddling ${place.pinCenterX}`);
        }
        continue;
      }
      if (hi > HUD_VIEW_W) spills.push(`0x${id.toString(16)} reaches x=${hi}`);
    }
    if (spills.length) {
      return { pass: false, name, reason: `spills into the roster box (x>=${HUD_VIEW_W}): ${spills.join(', ')}` };
    }
    if (badPin.length) return { pass: false, name, reason: `pin misplaced: ${badPin.join(', ')}` };
    return { pass: true, name, info: `unpinned effects within x<${HUD_VIEW_W}; pinned ones straddle as specified` };
  },
  // Regression — no player-castable spell may cast SILENTLY.
  //
  // `getSpellImpactSFX` compared `spell.element` with ===, so BOLT had no case
  // at all and compound elements ('ice,air') matched nothing: 37 of 56 spells
  // made no sound, including every Bolt tier and all 8 summons. That breaks the
  // standing rule that SFX fire at anim-start for ALL spells, and it only
  // became audible once v1.7.845 made those spells render. v1.7.847.
  () => {
    const name = 'regression — every castable spell has an impact SFX';
    const silent = [];
    for (const [id, spell] of SPELLS) {
      if (id > 0x37) continue;                 // 0x38+ are monster-only abilities
      if (getSpellImpactSFX(spell) == null) silent.push('0x' + id.toString(16));
    }
    if (silent.length) return { pass: false, name, reason: `cast silently: ${silent.join(', ')}` };
    return { pass: true, name, info: 'no castable spell is silent' };
  },
  // Regression — screen-anchored effects shake at ANIMATION START, and the
  // shake must land while the animation is actually on screen.
  //
  // The shake used to ride `applyMagicDamage`, next to the damage number. That
  // reads as one event for a 283 ms burst but not for a 1071 ms Meteo: the
  // whole sweep played and only then did the screen jolt. Target-anchored
  // spells deliberately keep the damage-apply shake. v1.7.849.
  () => {
    const name = 'regression — screen-anchored spells shake at anim start';
    const animStart = screenShakeCueMs(0x02);
    const bad = [];
    for (const [id, e] of CAPTURED_SPELL_ANIMS) {
      const screen = e.anchor === 'screen';
      if (isScreenAnchoredSpell(id) !== screen) {
        bad.push(`0x${id.toString(16)} anchor/helper disagree`);
        continue;
      }
      if (!screen) continue;
      // The shake must fire DURING the animation, not before or after it.
      // v1.7.851 — this used to bound the shake by a window computed from the
      // same constant, so it held no matter which anchor the renderer used.
      // Assert the shake lands exactly on the render window's OPENING FRAME.
      // Read the engine's REAL cue, and pin it to the pipeline constants
      // independently — asserting it against the render window alone would be
      // tautological now that both read one helper.
      const w = healStyleRenderWindow(id);
      const shakeAt = screenShakeCueMs(id) + CAST_PHASE_MS.buildup;
      const want = CAST_PHASE_MS_HEAL.buildup + CAST_PHASE_MS_HEAL.preImpactGap;
      if (shakeAt !== w.start || shakeAt !== want) {
        bad.push(`0x${id.toString(16)} shake at ${shakeAt}, animation opens ${w.start}, pipeline says ${want}`);
      }
    }
    if (bad.length) return { pass: false, name, reason: bad.join(', ') };
    return { pass: true, name, info: `shake at t=${animStart}ms, inside every screen animation` };
  },
  // Regression — multi-target must be DERIVED, not a hand list.
  //
  // `MULTI_TARGET_SPELLS` had four entries, so 52 of 56 spells could only be
  // aimed at one target — Meteo, every Fire2/3, Bolt2/3, Cure2/3/4 and the
  // whole status family. The ROM does not encode single-vs-all for player
  // spells, so the rule is generalized from the categories those four
  // demonstrate: enemy / enemy_status / ally. v1.7.850.
  () => {
    const name = 'regression — multi-target derives from target scope, summons excluded';
    const SCOPES = new Set(['enemy', 'enemy_status', 'ally']);
    const wrong = [];
    for (const [id, spell] of SPELLS) {
      if (id > 0x37) continue;
      const got = isMultiTargetSpell(id);
      // Summons must stay single here: `summon-tier.js` decides all-vs-single
      // per job tier, and the picker offering it too would override the tier.
      const want = MULTI_TARGET_SPELLS.has(id) ? true
                 : SUMMON_TIERS.has(id)        ? false
                 : SCOPES.has(spell.target);
      if (got !== want) wrong.push(`0x${id.toString(16)} got=${got} want=${want} (${spell.target})`);
    }
    if (wrong.length) return { pass: false, name, reason: wrong.join(', ') };
    for (const id of MULTI_TARGET_SPELLS) {
      if (!isMultiTargetSpell(id)) return { pass: false, name, reason: `override 0x${id.toString(16)} lost` };
    }
    for (const [id] of SUMMON_TIERS) {
      if (isMultiTargetSpell(id)) return { pass: false, name, reason: `summon 0x${id.toString(16)} bypasses its tier` };
    }
    const n = [...SPELLS.keys()].filter(i => i <= 0x37 && isMultiTargetSpell(i)).length;
    return { pass: true, name, info: `${n} multi-target, all 8 summons left to their tier` };
  },
  // Regression — the heal-style pipeline must be strictly SEQUENTIAL, and the
  // three cues that mark "the spell becomes visible" must come from one source.
  //
  // The renderer anchored its impact window on the legacy `CAST_T_HEAL` (1217)
  // while the engine scheduled the SFX cue, the screen shake and the effect
  // apply off `CAST_PHASE_MS_HEAL` (anim start 900). On all 23 enemy-facing
  // heal-style spells the sound therefore played 317 ms before anything was
  // drawn, and the damage number popped 66 ms INTO the burst with the burst
  // still drawing for 217 ms after it — the overlap the pipeline rule forbids.
  // `healStyleRenderWindow` is now the single source; this asserts the whole
  // schedule closes, including the long screen sweeps (Meteo 1071, Kill 1819).
  // v1.7.851.
  () => {
    const name = 'regression — heal-style SFX / shake / burst / damage stay sequential';
    const bad = [];
    let n = 0;
    for (const [id, spell] of SPELLS) {
      if (id > 0x37) continue;
      if (!spellUsesCastAnim(id)) continue;
      if (SUMMON_TIERS.has(id)) continue;
      // Thrown spells run the projectile pipeline, not this one.
      if (spell.target === 'sight' || spell.element === 'fire' || spell.element === 'ice'
          || spell.element === 'bolt' || spell.type === 'sleep') continue;
      n++;
      const w = healStyleRenderWindow(id);
      // 1. Burst opens exactly where the engine cues sound + shake.
      const cue = CAST_PHASE_MS_HEAL.buildup + CAST_PHASE_MS_HEAL.preImpactGap;
      if (w.start !== cue) {
        bad.push(`0x${id.toString(16)} burst opens ${w.start}, cue at ${cue}`);
        continue;
      }
      // 2. Burst CLOSES a full postImpactGap before damage lands — never
      //    overlapping it, and never leaving dead air either.
      const stretch = Math.max(0, healImpactWindowMs(id) - CAST_PHASE_MS_HEAL.impact);
      const applyAt = CAST_T_HEAL_APPLY + stretch;
      const gap = applyAt - w.end;
      if (gap !== CAST_PHASE_MS_HEAL.postImpactGap) {
        bad.push(`0x${id.toString(16)} gap burst->damage is ${gap}ms, want ${CAST_PHASE_MS_HEAL.postImpactGap}`);
      }
      // 3. The projectile lead-in must not run past the burst's opening.
      if (!(w.projStart < w.start && w.start < w.end)) {
        bad.push(`0x${id.toString(16)} window out of order ${w.projStart}/${w.start}/${w.end}`);
      }
    }
    if (bad.length) return { pass: false, name, reason: bad.join(', ') };
    return { pass: true, name, info: `burst opens ${healStyleRenderWindow(0x02).start}ms, ${CAST_PHASE_MS_HEAL.postImpactGap}ms gap before damage, ${n} spells` };
  },
  // Regression — a compound spell element must be matched component by
  // component against a monster's weakness / resist.
  //
  // Elements are stored comma-joined, and `elemMultiplier` compared the whole
  // string against lists holding single elements, so 'ice,air' (Aero2 0x11 and
  // 0x2d) matched nothing and both spells dealt flat neutral damage to every
  // monster in the game. Same unsplit-element root cause as the silent-SFX bug
  // of v1.7.847, which is why this gate covers the multiplier too. v1.7.851.
  () => {
    const name = 'regression — compound spell elements resolve weakness and resist';
    if (elemMultiplier('ice,air', ['ice'], null) !== 2) {
      return { pass: false, name, reason: 'compound element does not match a weakness' };
    }
    if (elemMultiplier('ice,air', null, ['air']) !== 0.5) {
      return { pass: false, name, reason: 'compound element does not match a resist' };
    }
    if (elemMultiplier('ice,air', ['fire'], null) !== 1) {
      return { pass: false, name, reason: 'compound element matched an unrelated weakness' };
    }
    // Single elements and the no-element case must be untouched.
    if (elemMultiplier('fire', ['fire'], null) !== 2) return { pass: false, name, reason: 'single element regressed' };
    if (elemMultiplier('fire', null, ['fire']) !== 0.5) return { pass: false, name, reason: 'single resist regressed' };
    if (elemMultiplier(null, ['fire'], null) !== 1)   return { pass: false, name, reason: 'null element regressed' };
    // Every compound-element spell in the catalogue must resolve its parts.
    const dead = [];
    for (const [id, spell] of SPELLS) {
      if (typeof spell.element !== 'string' || !spell.element.includes(',')) continue;
      for (const part of spell.element.split(',')) {
        if (elemMultiplier(spell.element, [part], null) !== 2) dead.push(`0x${id.toString(16)}:${part}`);
      }
    }
    if (dead.length) return { pass: false, name, reason: `component ignored: ${dead.join(', ')}` };
    return { pass: true, name, info: 'compound elements split; single + null unchanged' };
  },
  // Regression — a single-state captured animation must carry its MEASURED
  // hold, not the emitter's fallback guess.
  //
  // `spell-emit-rom.cjs` drops the last state before taking the median hold,
  // because that state's length is bounded by the capture window rather than by
  // the animation. For a one-state effect that left nothing, and it fell back to
  // a hardcoded 4 frames. Quake is one static crack measured at 81 frames
  // (1348 ms) and shipped at 67 ms — a 20x-too-short flash that read as a
  // missing capture. Death's burst had the same shape (16 frames -> 266 ms).
  // 67 ms on a one-frame animation is the exact fingerprint of that guess.
  // If a future capture genuinely measures 4 frames, widen this deliberately.
  () => {
    const name = 'regression — single-state animations keep their measured hold';
    const FALLBACK_MS = Math.round(4 * (1000 / 60.0988));   // 67 — the emitter guess
    const guessed = [];
    for (const [id, e] of CAPTURED_SPELL_ANIMS) {
      if ((e.layouts ? e.layouts.length : 0) !== 1) continue;
      if (e.holdMs === FALLBACK_MS) guessed.push(`0x${id.toString(16)}`);
    }
    if (guessed.length) {
      return { pass: false, name, reason: `one-frame animation still on the ${FALLBACK_MS}ms emitter fallback: ${guessed.join(', ')}` };
    }
    const singles = [...CAPTURED_SPELL_ANIMS].filter(([, e]) => (e.layouts ? e.layouts.length : 0) === 1);
    return { pass: true, name, info: `${singles.length} single-state animations, all measured` };
  },
  // Regression — every state whose job is to SHOW a damage number must hold it
  // for the number's full lifetime.
  //
  // v1.7.180 added the 200 ms stick phase and moved `DMG_SHOW_MS` 550 -> 750,
  // updating battle-ally's magic path, pvp.js and spell-cast.js. Three state
  // gates predated it and were missed: `player-damage-show` (bare 700, dated
  // 2026-04-16), `ally-damage-show` (bare literal 700, 2026-04-02) and
  // `poison-end-tick` (700, 2026-05-06, its comment still citing the old 550).
  // Each ended 50 ms before the number cleared itself, so on every player
  // attack, every ally attack and every end-of-round poison the number bled
  // into the following state. Their defender-side twins were already correct,
  // which is what made the split invisible. v1.7.853.
  () => {
    const name = 'regression — damage-show states hold for the number\'s full lifetime';
    const saved = {
      state: battleSt.battleState, timer: battleSt.battleTimer,
      mons: battleSt.encounterMonsters, rnd: battleSt.isRandomEncounter,
      tgt: inputSt.targetIndex, allyTgt: battleSt.allyTargetIndex,
      dying: battleSt.dyingMonsterIndices,
    };
    try {
      // A DEAD target makes every one of these transitions deterministic, so
      // none of them depends on an injected `processNextTurn` callback.
      battleSt.isRandomEncounter = true;
      battleSt.encounterMonsters = [{ monsterId: 0x00, hp: 0, maxHP: 30 }];
      inputSt.targetIndex = 0;
      battleSt.allyTargetIndex = 0;

      const CASES = [
        { state: 'player-damage-show', run: () => updateBattlePlayerAttack() },
        { state: 'ally-damage-show',   run: () => updateBattleAlly(0) },
        { state: 'poison-end-tick',    run: () => updatePoisonTick() },
      ];
      const bad = [];
      for (const c of CASES) {
        // One tick BEFORE the number expires: the state must still be running.
        battleSt.battleState = c.state;
        battleSt.battleTimer = DMG_SHOW_MS - 1;
        c.run();
        if (battleSt.battleState !== c.state) {
          bad.push(`${c.state} left early at ${DMG_SHOW_MS - 1}ms (number lives ${DMG_SHOW_MS}ms)`);
        }
        // At the number's expiry: the state must be done.
        battleSt.battleState = c.state;
        battleSt.battleTimer = DMG_SHOW_MS;
        c.run();
        if (battleSt.battleState === c.state) {
          bad.push(`${c.state} still running at ${DMG_SHOW_MS}ms`);
        }
      }
      if (bad.length) return { pass: false, name, reason: bad.join(', ') };
      return { pass: true, name, info: `${CASES.length} damage-show states all hold exactly ${DMG_SHOW_MS}ms` };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.battleTimer = saved.timer;
      battleSt.encounterMonsters = saved.mons; battleSt.isRandomEncounter = saved.rnd;
      inputSt.targetIndex = saved.tgt; battleSt.allyTargetIndex = saved.allyTgt;
      battleSt.dyingMonsterIndices = saved.dying;
    }
  },
  // Regression — an ally's physical attack runs the PLAYER's melee timeline,
  // and its damage popup carries its own target instead of hijacking the
  // player's cursor.
  //
  // v1.7.854 fixed two halves of the same divergence:
  //
  //  - The ally used its own 40/40 ms swings and went from impact STRAIGHT to
  //    its damage number, where the player holds the OAM-measured 316 ms
  //    `player-hit-show` beat first. Same action, two animations: 980 ms for an
  //    ally against 1376 ms for the player. The ally now runs the identical
  //    back -> fwd -> slash -> hit-show sequence off the shared constants in
  //    slash-effects.js.
  //  - `_finalizeAllyCombo` used to assign `inputSt.targetIndex =
  //    battleSt.allyTargetIndex`, purely so the popup — positioned off that
  //    shared cursor — landed on the right monster. The side effect was that
  //    the PLAYER's target selection silently followed their ally around. The
  //    popup carries `index` now, like `enemyHealNum` always has.
  () => {
    const name = 'regression — ally melee timeline matches the player, popup carries its own target';
    const saved = {
      state: battleSt.battleState, timer: battleSt.battleTimer,
      mons: battleSt.encounterMonsters, rnd: battleSt.isRandomEncounter,
      tgt: inputSt.targetIndex, allyTgt: battleSt.allyTargetIndex,
      allies: battleSt.battleAllies, results: battleSt.allyHitResults,
      hitIdx: battleSt.allyHitIdx, attacker: battleSt.currentAllyAttacker,
      isLeft: battleSt.allyHitIsLeft,
    };
    try {
      battleSt.isRandomEncounter = true;
      battleSt.encounterMonsters = [{ monsterId: 0x00, hp: 30, maxHP: 30 }];
      battleSt.battleAllies = [{ hp: 50, maxHP: 50, weaponId: 0x01, weaponL: 0xFF,
                                 level: 1, status: createStatusState() }];
      battleSt.currentAllyAttacker = 0;
      battleSt.allyTargetIndex = 0;
      battleSt.allyHitIdx = 0;
      battleSt.allyHitIsLeft = false;
      // A MISS keeps the timeline identical (slash dwell is hit/miss agnostic
      // by design — see slash-effects.js) while skipping the damage plumbing.
      battleSt.allyHitResults = [{ miss: true }];
      // Sentinel: the player's cursor must come out untouched.
      const CURSOR = 3;
      inputSt.targetIndex = CURSOR;

      battleSt.battleState = 'ally-attack-back';
      battleSt.battleTimer = 0;
      const seq = [];
      let last = battleSt.battleState, elapsed = 0, guard = 0;
      while (battleSt.battleState !== 'ally-damage-show' && guard++ < 10000) {
        battleSt.battleTimer += 1; elapsed += 1;
        updateBattleAlly(0);
        if (battleSt.battleState !== last) {
          seq.push({ from: last, to: battleSt.battleState, at: elapsed });
          last = battleSt.battleState;
        }
      }
      if (battleSt.battleState !== 'ally-damage-show') {
        return { pass: false, name, reason: `never reached ally-damage-show (stuck in ${battleSt.battleState})` };
      }
      // The hit-pause is a MEASUREMENT (OAM f14608 frames 50-71), not a taste
      // knob, so pin its value outright — the rest of the timeline is asserted
      // against the shared constants, which is the real invariant: whatever the
      // player uses, the ally uses.
      if (HIT_PAUSE_MS !== 316) {
        return { pass: false, name, reason: `HIT_PAUSE_MS is ${HIT_PAUSE_MS}, the OAM capture says 316` };
      }
      const want = [
        ['ally-attack-back', 'ally-attack-fwd',   BACK_SWING_MS],
        ['ally-attack-fwd',  'ally-slash',        FWD_SWING_MS],
        ['ally-slash',       'ally-hit-show',     SWING_HOLD_MS],
        ['ally-hit-show',    'ally-damage-show',  HIT_PAUSE_MS],
      ];
      if (seq.length !== want.length) {
        return { pass: false, name, reason: `sequence was ${seq.map(s => s.to).join(' -> ')}, wanted ${want.map(w => w[1]).join(' -> ')}` };
      }
      let prev = 0;
      for (let i = 0; i < want.length; i++) {
        const [from, to, dur] = want[i];
        const got = seq[i];
        if (got.from !== from || got.to !== to) {
          return { pass: false, name, reason: `step ${i}: ${got.from} -> ${got.to}, wanted ${from} -> ${to}` };
        }
        const took = got.at - prev; prev = got.at;
        if (took !== dur) {
          return { pass: false, name, reason: `${from} lasted ${took}ms, wanted ${dur}ms (the player's value)` };
        }
      }
      // The popup knows which monster it belongs to...
      const dn = getEnemyDmgNum();
      if (!dn) return { pass: false, name, reason: 'no enemy damage popup after the combo' };
      if (dn.index !== 0) {
        return { pass: false, name, reason: `popup index ${dn.index}, wanted the ally's target 0` };
      }
      // ...so the player's cursor is left alone.
      if (inputSt.targetIndex !== CURSOR) {
        return { pass: false, name, reason: `ally combo moved the player's cursor ${CURSOR} -> ${inputSt.targetIndex}` };
      }
      return { pass: true, name, info: `back ${BACK_SWING_MS} / fwd ${FWD_SWING_MS} / slash ${SWING_HOLD_MS} / hit-pause ${HIT_PAUSE_MS} = ${prev}ms, cursor untouched` };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.battleTimer = saved.timer;
      battleSt.encounterMonsters = saved.mons; battleSt.isRandomEncounter = saved.rnd;
      inputSt.targetIndex = saved.tgt; battleSt.allyTargetIndex = saved.allyTgt;
      battleSt.battleAllies = saved.allies; battleSt.allyHitResults = saved.results;
      battleSt.allyHitIdx = saved.hitIdx; battleSt.currentAllyAttacker = saved.attacker;
      battleSt.allyHitIsLeft = saved.isLeft;
    }
  },
  // Regression — status-cure and toggle spells act on the ROM's status MASK,
  // and a `hit` of 0 means guaranteed rather than impossible.
  //
  // For target bytes 0x06 (cure) and 0x07 (toggle) the ROM's byte +3 is a
  // BITMASK of NES status bits, not a single type. The generator's `typeJS`
  // named it lossily and all three cast sites then did
  // `STATUS_NAME_TO_FLAG[spell.type]`, so:
  //   Heal  mask 0xFF -> named 'cure_status' -> undefined -> cured NOTHING
  //   Soft  mask 0x07 -> collided with 'haste' -> undefined -> cured NOTHING
  //   Wash  mask 0x04 / Pure mask 0x02 -> worked only because a single bit's
  //         name happens to round-trip.
  // Toad and Mini (target 0x07) had no branch in any dispatcher at all and
  // fell through to `applyMagicDamage` — dealing damage to an enemy, and
  // damaging your OWN PARTY when cast on an ally. Both also carry hit 0, which
  // `tryInflictStatus` read as a 0% chance while `applyMagicDamage` has always
  // read the same byte as "no roll, guaranteed". v1.7.855.
  () => {
    const name = 'regression — cure / toggle spells act on the ROM status mask';
    // 1. Every spell in the family resolves a real mask.
    const dead = [];
    for (const [id, spell] of SPELLS) {
      if (id > 0x37) continue;
      if (spell.target !== 'cure_status' && spell.target !== 'toggle_status') continue;
      if (!spellStatusMask(spell)) dead.push(`0x${id.toString(16)} (${spell.type})`);
    }
    if (dead.length) return { pass: false, name, reason: `resolves to no status: ${dead.join(', ')}` };

    // 2. Heal's 0xFF clears every NES status bit it covers.
    const heal = { status: createStatusState(), hp: 10, maxHP: 10 };
    addStatus(heal.status, STATUS.POISON | STATUS.BLIND | STATUS.SILENCE | STATUS.PETRIFY);
    // Through the shared DISPATCHER, not the leaf helper — otherwise the gate
    // would still pass with the dispatcher's branch reverted.
    applySpell(SPELLS.get(0x0b), heal, {});
    if (heal.status.mask !== 0) {
      return { pass: false, name, reason: `Heal left mask 0x${heal.status.mask.toString(16)}` };
    }

    // 3. Soft's 0x07 clears paralysis|poison|blind and LEAVES the rest — the
    //    multi-bit case a single-name lookup can never express.
    const soft = { status: createStatusState(), hp: 10, maxHP: 10 };
    addStatus(soft.status, STATUS.PARALYSIS | STATUS.POISON | STATUS.BLIND | STATUS.SILENCE);
    applySpell(SPELLS.get(0x12), soft, {});
    if (soft.status.mask !== STATUS.SILENCE) {
      return { pass: false, name, reason: `Soft left mask 0x${soft.status.mask.toString(16)}, wanted only SILENCE` };
    }

    // 4. Toad toggles: inflicts on a clean target, cures on an afflicted one —
    //    and never touches HP, which is what it used to do instead.
    const toadSpell = SPELLS.get(0x2e);
    const t = { status: createStatusState(), hp: 100, maxHP: 100, statusResist: 0 };
    applySpell(toadSpell, t, {});
    if (!(t.status.mask & STATUS.TOAD)) {
      return { pass: false, name, reason: `Toad did not land (hit ${toadSpell.hit} read as impossible?)` };
    }
    if (t.hp !== 100) return { pass: false, name, reason: `Toad changed HP 100 -> ${t.hp}` };
    applySpell(toadSpell, t, {});
    if (t.status.mask & STATUS.TOAD) return { pass: false, name, reason: 'second Toad cast did not cure' };
    if (t.hp !== 100) return { pass: false, name, reason: `Toad cure changed HP 100 -> ${t.hp}` };

    // 5. hit 0 is "no roll", not "never" — the reading applyMagicDamage uses.
    const zero = createStatusState();
    if (tryInflictStatus(zero, 'toad', 0) !== STATUS.TOAD) {
      return { pass: false, name, reason: 'hit 0 still read as a 0% chance' };
    }
    // ...and a real percentage still rolls.
    const resisted = createStatusState();
    if (tryInflictStatus(resisted, 'toad', 50, ['toad']) !== 0) {
      return { pass: false, name, reason: 'resist ignored on the inflict path' };
    }
    return { pass: true, name, info: 'Heal 0xff / Soft 0x07 / Wash 0x04 / Pure 0x02, Toad+Mini toggle, hit 0 guaranteed' };
  },
  // Regression — a Mini'd or Toad'd MONSTER swings at reduced strength.
  //
  // The player, ally and PVP attack paths all scale by `miniToadAtkMult`; the
  // monster path applied `blindHitPenalty` and then skipped the multiplier, so
  // a transformed monster hit at full power. It was invisible because the only
  // spells that inflict those statuses could never land (above). v1.7.855.
  () => {
    const name = 'regression — mini/toad cuts a monster\'s attack like every other path';
    const strong = { ...goblin, atk: 60, hitRate: 100, attackRoll: 1 };
    setupEncounter({ monster: strong, seed: 7 });
    battleSt.battleAllies[0].hp = 0; rngMod.rand();
    updateBattleEnemyTurn();
    const baseline = 100 - (ps.hp | 0);

    setupEncounter({ monster: strong, seed: 7 });
    addStatus(battleSt.encounterMonsters[0].status, STATUS.MINI);
    battleSt.battleAllies[0].hp = 0; rngMod.rand();
    updateBattleEnemyTurn();
    const mini = 100 - (ps.hp | 0);

    if (!(mini < baseline)) {
      return { pass: false, name, reason: `mini'd monster dealt ${mini}, un-mini'd dealt ${baseline}` };
    }
    return { pass: true, name, info: `baseline=${baseline} mini=${mini}` };
  },
  // Regression — a confused ALLY or MONSTER swings at a random living
  // combatant on EITHER side, and a confused caster does not calmly pick an
  // optimal spell target.
  //
  // `processTurnStart` has always returned a `confused` flag and only the
  // player's handler read it; the ally, monster and PVP handlers destructured
  // `{ canAct }` and dropped it, so Confu (0x20) cast on a monster did nothing
  // but tick itself back off. All three now share `_confusedPool` /
  // `_confusedProfile` / `_confusedFriendlyFire` rather than growing a fourth
  // copy of the same logic. v1.7.857.
  () => {
    const name = 'regression — confused player / ally / monster attack either side';
    if (!_romLoaded) return { pass: true, name, info: 'SKIPPED — no FF3-English.nes in this checkout' };
    const saved = { state: battleSt.battleState, queue: battleSt.turnQueue,
                    mons: battleSt.encounterMonsters, allies: battleSt.battleAllies,
                    rnd: battleSt.isRandomEncounter, forced: battleSt.forcedEnemyTarget };
    try {
      // Drives one confused turn under a given seed and reports what happened.
      const runTurn = (who, seed) => {
        setupEncounter({ monster: { ...goblin, hp: 200, maxHP: 200 }, seed });
        battleSt.encounterMonsters = [
          { ...goblin, hp: 200, maxHP: 200, status: createStatusState() },
          { ...goblin, hp: 200, maxHP: 200, status: createStatusState() },
        ];
        ps.hp = 500; if (ps.stats) ps.stats.maxHP = 500;
        const ally = battleSt.battleAllies[0];
        ally.hp = 300; ally.maxHP = 300; ally.atk = 20; ally.agi = 5; ally.level = 3;
        ally.weaponId = 0xFF; ally.weaponL = 0xFF;
        // Cure + a badly wounded player: the ally heal AI WOULD fire here if
        // confuse did not pre-empt it. That is the sharp half of this test.
        ally.knownSpells = [0x34]; ally.mp = 99;
        if (who === 'player') {
          addStatus(ps.status, STATUS.CONFUSE);
          battleSt.turnQueue = [{ type: 'player' }];
        } else if (who === 'ally') {
          addStatus(ally.status, STATUS.CONFUSE);
          ps.hp = 40;                       // < 60% -> _tryAllyCure would trigger
          battleSt.turnQueue = [{ type: 'ally', index: 0 }];
        } else {
          addStatus(battleSt.encounterMonsters[0].status, STATUS.CONFUSE);
          battleSt.turnQueue = [{ type: 'monster', index: 0 }];
        }
        const hpBefore = { ps: ps.hp, ally: ally.hp,
                           m0: battleSt.encounterMonsters[0].hp, m1: battleSt.encounterMonsters[1].hp };
        battleSt.battleState = 'menu-open';
        processNextTurn();
        const reached = battleSt.battleState;
        // A monster that picked the player or an ally hands off to the normal
        // flash -> swing path. Drive that so the forced target is actually
        // consumed — which is half of what this test is checking.
        if (reached === 'enemy-flash') { battleSt.battleTimer = 1000; updateBattleEnemyTurn(); }
        return { state: reached, hpBefore,
                 hpAfter: { ps: ps.hp, ally: ally.hp,
                            m0: battleSt.encounterMonsters[0].hp, m1: battleSt.encounterMonsters[1].hp } };
      };

      // The player is in the loop because v1.7.857 refactored its ALREADY-WORKING
      // confused branch onto the shared helpers; a silent break there would be
      // the worst outcome of this change.
      for (const who of ['player', 'ally', 'monster']) {
        let hitOwnSide = 0, hitOtherSide = 0, cast = 0, snappedOut = 0;
        for (let seed = 1; seed <= 60; seed++) {
          const r = runTurn(who, seed);
          if (r.state === 'ally-magic-cast') { cast++; continue; }
          if (r.state === 'poison-tick') { hitOwnSide++; continue; }
          if (r.state === 'ally-attack-back' || r.state === 'enemy-flash'
              || r.state === 'attack-back') { hitOtherSide++; continue; }
          // 25%/turn snap-out is inside processTurnStart and is fine.
          snappedOut++;
        }
        if (cast > 0) {
          return { pass: false, name, reason: `confused ${who} still ran its spell AI ${cast}/60 turns` };
        }
        if (hitOwnSide === 0) {
          return { pass: false, name, reason: `confused ${who} never hit its own side in 60 turns (pool is one-sided)` };
        }
        if (hitOtherSide === 0) {
          return { pass: false, name, reason: `confused ${who} never hit the other side in 60 turns` };
        }
      }
      // A confused monster must not leave its forced target behind for the
      // next, sane monster to inherit.
      if (battleSt.forcedEnemyTarget != null) {
        return { pass: false, name, reason: `forcedEnemyTarget left set (${battleSt.forcedEnemyTarget})` };
      }
      return { pass: true, name, info: 'player + ally + monster each swing at both sides; neither casts while confused' };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.turnQueue = saved.queue;
      battleSt.encounterMonsters = saved.mons; battleSt.battleAllies = saved.allies;
      battleSt.isRandomEncounter = saved.rnd; battleSt.forcedEnemyTarget = saved.forced;
    }
  },
  // Regression — an in-battle item lands on the target the player PICKED.
  //
  // `_playerTurnConsumable` honoured `allyIndex` on its heal branch (with a
  // full dead-target redirect) and ignored it on the other two:
  //   cure_status — cured `ps` unconditionally. An Antidote used on a poisoned
  //     ALLY consumed the item, cured the PLAYER, and played its sparkle on the
  //     ally's portrait, so the animation pointed at one combatant while the
  //     effect landed on another.
  //   full_heal  — ran only when the target was the player with no ally picked,
  //     so an Elixir on an ally did NOTHING: item consumed, no heal, no number.
  // The out-of-battle path already handled both correctly, and the in-battle
  // cure comment claimed parity with it. v1.7.858.
  () => {
    const name = 'regression — in-battle items land on the picked target';
    if (!_romLoaded) return { pass: true, name, info: 'SKIPPED — no FF3-English.nes in this checkout' };
    const ANTIDOTE = 0xaf, ELIXIR = 0xa8, POTION = 0xa6;
    const saved = { state: battleSt.battleState, queue: battleSt.turnQueue,
                    mons: battleSt.encounterMonsters, allies: battleSt.battleAllies,
                    pending: inputSt.playerActionPending };
    try {
      const useItem = (itemId, allyIndex) => {
        setupEncounter({ monster: { ...goblin, hp: 200, maxHP: 200 }, seed: 5 });
        // The harness `ps` carries a top-level maxHP the real one does not (max
        // lives in ps.stats). Set both so `applyMagicHeal`'s lookup order
        // resolves the same 300 either way.
        ps.hp = 30; ps.maxHP = 300; ps.stats = { ...(ps.stats || {}), maxHP: 300, level: 1, agi: 5 };
        ps.status = createStatusState(); addStatus(ps.status, STATUS.POISON);
        const ally = battleSt.battleAllies[0];
        ally.hp = 20; ally.maxHP = 200;
        ally.status = createStatusState(); addStatus(ally.status, STATUS.POISON);
        addItem(itemId, 1);
        battleSt.turnQueue = [{ type: 'player' }];
        inputSt.playerActionPending = { command: 'item', itemId, target: 'player',
                                        allyIndex, targetMode: 'single' };
        battleSt.battleState = 'menu-open';
        processNextTurn();
        return { psHp: ps.hp, allyHp: ally.hp,
                 psPoisoned: hasStatus(ps.status, STATUS.POISON),
                 allyPoisoned: hasStatus(ally.status, STATUS.POISON) };
      };

      // 1. Antidote on the ALLY cures the ally and leaves the player poisoned.
      let r = useItem(ANTIDOTE, 0);
      if (r.allyPoisoned) return { pass: false, name, reason: 'Antidote on ally did not cure the ally' };
      if (!r.psPoisoned)  return { pass: false, name, reason: 'Antidote on ally cured the PLAYER instead' };

      // 2. ...and on the player it still cures the player, not the ally.
      r = useItem(ANTIDOTE, -1);
      if (r.psPoisoned)    return { pass: false, name, reason: 'Antidote on self did not cure the player' };
      if (!r.allyPoisoned) return { pass: false, name, reason: 'Antidote on self also cured the ally' };

      // 3. Elixir on the ALLY fills the ally, not the player.
      r = useItem(ELIXIR, 0);
      if (r.allyHp !== 200) return { pass: false, name, reason: `Elixir on ally left it at ${r.allyHp}/200` };
      if (r.psHp !== 30)    return { pass: false, name, reason: `Elixir on ally also healed the player to ${r.psHp}` };

      // 4. Elixir on the player still fills the player.
      r = useItem(ELIXIR, -1);
      if (r.psHp !== 300)   return { pass: false, name, reason: `Elixir on self left the player at ${r.psHp}/300` };

      // 5. The heal branch that always worked must keep working.
      r = useItem(POTION, 0);
      if (r.allyHp !== 70)  return { pass: false, name, reason: `Potion(50) on ally gave ${r.allyHp}, wanted 70` };
      if (r.psHp !== 30)    return { pass: false, name, reason: `Potion on ally also healed the player` };

      return { pass: true, name, info: 'cure_status / full_heal / heal all honour allyIndex' };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.turnQueue = saved.queue;
      battleSt.encounterMonsters = saved.mons; battleSt.battleAllies = saved.allies;
      inputSt.playerActionPending = saved.pending;
    }
  },
  // Regression — a two-handed weapon occupies BOTH hands.
  //
  // The `twoHanded` flag sat on eight weapons (0x46, 0x48-0x4e) and was read by
  // nothing, so a two-hander could be paired with a second weapon or a shield
  // and collect the offhand's ATK, DEF and — worst — the dual-wield hit count,
  // doubling its swings. v1.7.859.
  //
  // The rule is enforced where stats are DERIVED (`normalizeGrip`), not at the
  // equip screens, because equipment reaches `ps` from five call sites plus the
  // wire, and saves written before this version can already hold an illegal
  // pair. Anything that reads a loadout gets the legal one.
  () => {
    const name = 'regression — a two-handed weapon occupies both hands';
    const TWO = 0x46, SWORD = 0x01, SHIELD = 0x58;
    const savedR = ps.weaponR, savedL = ps.weaponL;
    try {
      // 1. The offhand is blanked whichever hand holds the two-hander.
      if (normalizeGrip({ weaponR: TWO, weaponL: SWORD }).weaponL !== 0) {
        return { pass: false, name, reason: 'two-hander in R did not blank the left hand' };
      }
      if (normalizeGrip({ weaponR: SWORD, weaponL: TWO }).weaponR !== 0) {
        return { pass: false, name, reason: 'two-hander in L did not blank the right hand' };
      }
      // ...and a legal pair is left completely alone.
      const legal = normalizeGrip({ weaponR: SWORD, weaponL: SWORD });
      if (legal.weaponR !== SWORD || legal.weaponL !== SWORD) {
        return { pass: false, name, reason: 'a legal dual wield was altered' };
      }

      // 2. Hit count — the headline consequence. A two-hander must roll the
      //    same number of swings with a sword in the offhand as with nothing.
      if (isDualWield(TWO, SWORD)) return { pass: false, name, reason: 'two-hander + sword still counts as dual wield' };
      if (isDualWield(TWO, SHIELD)) return { pass: false, name, reason: 'two-hander + shield still counts as dual wield' };
      if (!isDualWield(SWORD, SWORD)) return { pass: false, name, reason: 'a real dual wield stopped counting' };
      if (!isDualWield(0, 0)) return { pass: false, name, reason: 'bare fists stopped counting as dual wield' };
      const paired = calcPotentialHits(10, 20, isDualWield(TWO, SWORD));
      const alone  = calcPotentialHits(10, 20, isDualWield(TWO, 0));
      if (paired !== alone) {
        return { pass: false, name, reason: `two-hander swings ${paired} with an offhand vs ${alone} without` };
      }

      // 3. The illegal offhand contributes no stats either.
      const base = { stats: { level: 10, str: 20, agi: 10, vit: 10, int: 10, mnd: 10 }, jobIdx: 0, jobLevel: 1 };
      const solo = computeRealizedStats({ ...base, equipped: { weaponR: TWO, weaponL: 0, head: 0, body: 0, arms: 0 } });
      const withShield = computeRealizedStats({ ...base, equipped: { weaponR: TWO, weaponL: SHIELD, head: 0, body: 0, arms: 0 } });
      if (withShield.def !== solo.def) {
        return { pass: false, name, reason: `shield gave the two-hander DEF ${solo.def} -> ${withShield.def}` };
      }
      const withSword = computeRealizedStats({ ...base, equipped: { weaponR: TWO, weaponL: SWORD, head: 0, body: 0, arms: 0 } });
      if (withSword.atk !== solo.atk) {
        return { pass: false, name, reason: `offhand sword gave the two-hander ATK ${solo.atk} -> ${withSword.atk}` };
      }

      // 4. Equipping into a hand sends the other one back to the bag, keeping
      //    what the player just chose.
      ps.weaponR = TWO; ps.weaponL = SWORD;
      let freed = releaseOffhandForTwoHanded(-100);      // just equipped the two-hander
      if (freed !== SWORD || ps.weaponL !== 0) {
        return { pass: false, name, reason: `equipping the two-hander left ${ps.weaponL} in the offhand` };
      }
      ps.weaponR = TWO; ps.weaponL = SWORD;
      freed = releaseOffhandForTwoHanded(-101);          // just equipped the sword
      if (freed !== TWO || ps.weaponR !== 0) {
        return { pass: false, name, reason: 'equipping into the offhand did not remove the two-hander' };
      }
      ps.weaponR = SWORD; ps.weaponL = SWORD;
      if (releaseOffhandForTwoHanded(-100) !== 0 || ps.weaponL !== SWORD) {
        return { pass: false, name, reason: 'a legal dual wield was unequipped' };
      }
      return { pass: true, name, info: 'grip normalised for hits, stats and the equip screen' };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      ps.weaponR = savedR; ps.weaponL = savedL;
    }
  },
  // Regression — an elemental weapon resolves against the target on EVERY
  // attack path, and each hand resolves its own element.
  //
  // 43 weapons carry `element`. The PLAYER's path has always passed
  // `elemMult`, because it rolls each hand with a separate `rollHits` call.
  // The ally and PVP paths roll both hands in ONE call using `splitRH`/`lAtk`
  // and passed no `elemMult` at all — so an ally swinging a fire sword at a
  // fire-weak monster dealt flat neutral damage where the player with the same
  // sword got double. `rollHits` gained `lElemMult` alongside the `lAtk` it
  // already had, so a mixed pair resolves per hand. v1.7.860.
  () => {
    const name = 'regression — elemental weapons resolve per hand on every path';
    const FIRE_SWORD = 0x0a;   // element: 'fire'
    const saved = { state: battleSt.battleState, queue: battleSt.turnQueue,
                    mons: battleSt.encounterMonsters, allies: battleSt.battleAllies };
    try {
      // 1. The mechanic: with the hands split, each half takes its own
      //    multiplier. Fixed rand → fully determined damage.
      const half = () => 0.5;
      const hits = rollHits(10, 0, 100, 4, { splitRH: true, lAtk: 10, elemMult: 2, lElemMult: 1, rand: half });
      const dmg = hits.map(h => h.damage);
      if (dmg.length !== 4 || dmg[0] !== dmg[1] || dmg[2] !== dmg[3] || dmg[0] !== dmg[2] * 2) {
        return { pass: false, name, reason: `per-hand elements did not split: ${JSON.stringify(dmg)}` };
      }
      // A caller that passes only `elemMult` must still get it on BOTH hands.
      const legacy = rollHits(10, 0, 100, 4, { splitRH: true, lAtk: 10, elemMult: 2, rand: half });
      if (legacy.some(h => h.damage !== legacy[0].damage)) {
        return { pass: false, name, reason: 'omitting lElemMult changed the offhand — not backward compatible' };
      }

      // 2. The plumbing: drive a real ally turn and confirm the call site
      //    actually passes it. Same seed, same weapon, two targets.
      const allyTurnDamage = (weakness) => {
        setupEncounter({ monster: { ...goblin, hp: 500, maxHP: 500, def: 0, evade: 0, weakness }, seed: 11 });
        const ally = battleSt.battleAllies[0];
        ally.hp = 100; ally.maxHP = 100; ally.atk = 30; ally.agi = 5; ally.level = 3;
        ally.weaponId = FIRE_SWORD; ally.weaponL = 0xFF;
        ally.knownSpells = []; ally.status = createStatusState();
        battleSt.turnQueue = [{ type: 'ally', index: 0 }];
        battleSt.battleState = 'menu-open';
        processNextTurn();
        return (battleSt.allyHitResults || []).reduce((t, h) => t + (h.damage || 0), 0);
      };
      const vsWeak    = allyTurnDamage(['fire']);
      const vsNeutral = allyTurnDamage(null);
      if (vsNeutral === 0) return { pass: false, name, reason: 'ally rolled no damage at all — setup is wrong' };
      if (vsWeak <= vsNeutral) {
        return { pass: false, name, reason: `ally's fire sword dealt ${vsWeak} to a fire-WEAK target vs ${vsNeutral} to a neutral one` };
      }
      return { pass: true, name, info: `per-hand split ok; ally fire sword ${vsNeutral} -> ${vsWeak} vs weakness` };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.turnQueue = saved.queue;
      battleSt.encounterMonsters = saved.mons; battleSt.battleAllies = saved.allies;
    }
  },
  // Regression — a cast from an equipped weapon's `casts:` field keeps the
  // full cast timeline; only a CONSUMABLE skips it.
  //
  // `isItemUse` was doing two jobs: "no caster pose / no MP / item name on the
  // strip" AND "skip the cast timeline entirely". Those agree for a thrown
  // flask and disagree for a magic sword, which is still a spell going off. The
  // conflation made `getCastAnimElapsedMs()` return -1 for every item-use cast,
  // and the friendly-target sparkle is gated on that — so the four
  // friendly-target casting weapons (0x14 Cure, 0xdd Cure3, 0x31 Safe,
  // 0xd2 Wall) landed their effect and rendered nothing at all. Enemy-target
  // casts were unaffected: that path has its own early item-use branch.
  // v1.7.861.
  () => {
    const name = 'regression — equipment casts keep the cast timeline, consumables skip it';
    const saved = { state: battleSt.battleState, timer: battleSt.battleTimer,
                    mons: battleSt.encounterMonsters, queue: battleSt.turnQueue,
                    pending: inputSt.playerActionPending };
    try {
      // Runs a cast to the end of its windup and reports how long the
      // `magic-cast` state lasted, plus the range `getCastAnimElapsedMs()`
      // covered — which is what every on-target visual keys off.
      const runWindup = (spellId, target, opts) => {
        setupEncounter({ monster: { ...goblin, hp: 400, maxHP: 400 }, seed: 3 });
        ps.hp = 200; ps.maxHP = 200; ps.mp = 99;
        startSpellCast(spellId, target, opts);
        if (battleSt.battleState !== 'magic-cast') return { castMs: -1, maxElapsed: -1 };
        let t = 0, maxElapsed = getCastAnimElapsedMs();
        while (battleSt.battleState === 'magic-cast' && t < 5000) {
          battleSt.battleTimer += 1; t += 1;
          updateSpellCast(1);
          const e = getCastAnimElapsedMs();
          if (e > maxElapsed) maxElapsed = e;
        }
        return { castMs: t, maxElapsed };
      };

      const ENEMY = { enemyIndex: 0, targetMode: 'single' };
      const SELF  = { allyIndex: -1, targetMode: 'single' };
      const FIRE = 0x31, CURE = 0x34;
      const BUILDUP = CAST_PHASE_MS.buildup;

      // 1. A normal cast is the reference.
      const normal = runWindup(FIRE, ENEMY, {});
      if (normal.castMs !== BUILDUP) {
        return { pass: false, name, reason: `normal cast windup was ${normal.castMs}ms, wanted ${BUILDUP}` };
      }
      // 2. An equipment cast matches it — that is the whole point.
      const equip = runWindup(FIRE, ENEMY, { isItemUse: true, itemId: 0x0f, fromEquipment: true });
      if (equip.castMs !== BUILDUP) {
        return { pass: false, name, reason: `equipment cast windup was ${equip.castMs}ms, wanted ${BUILDUP}` };
      }
      // 3. A consumable still skips it. Unchanged behaviour, asserted so this
      //    fix cannot quietly re-time LamiaScale and friends.
      const consumable = runWindup(FIRE, ENEMY, { isItemUse: true, itemId: 0xb1 });
      if (consumable.castMs >= BUILDUP) {
        return { pass: false, name, reason: `consumable windup grew to ${consumable.castMs}ms — it should skip the timeline` };
      }
      if (consumable.maxElapsed !== -1) {
        return { pass: false, name, reason: 'a consumable cast now reports a live cast clock' };
      }

      // 4. The actual bug: a friendly-target equipment cast must reach the
      //    sparkle window. Every on-target visual is gated on this clock, and
      //    it used to sit at -1 for the entire cast.
      const healEquip = runWindup(CURE, SELF, { isItemUse: true, itemId: 0x14, fromEquipment: true });
      if (healEquip.maxElapsed < 0) {
        return { pass: false, name, reason: 'friendly equipment cast still reports no cast clock — sparkle stays dark' };
      }
      // Walk the hit phase too: the window opens inside `magic-hit`.
      let sawSparkleWindow = false;
      for (let t = 0; t < 4000 && battleSt.battleState === 'magic-hit'; t++) {
        const e = getCastAnimElapsedMs();
        if (e >= CAST_T_HEAL_ANIM_START && e < CAST_T_HEAL_ANIM_END) { sawSparkleWindow = true; break; }
        battleSt.battleTimer += 1;
        updateSpellCast(1);
      }
      if (!sawSparkleWindow) {
        return { pass: false, name, reason: 'friendly equipment cast never entered the sparkle window' };
      }
      // 5. The CALL SITE. Everything above drives `startSpellCast` directly, so
      //    it all still passed with `opts.fromEquipment` deleted from
      //    `_playerTurnMagic` — the gate proved the engine and not the wiring.
      //    Drive a real weapon cast through the turn dispatcher instead.
      setupEncounter({ monster: { ...goblin, hp: 400, maxHP: 400 }, seed: 3 });
      ps.hp = 200; ps.maxHP = 200; ps.mp = 99;
      inputSt.playerActionPending = { command: 'magic', spellId: FIRE, fromItemId: 0x0f };
      inputSt.itemTargetType = 'enemy'; inputSt.itemTargetIndex = 0;
      battleSt.turnQueue = [{ type: 'player' }];
      battleSt.battleState = 'menu-open';
      processNextTurn();
      if (battleSt.battleState !== 'magic-cast') {
        return { pass: false, name, reason: `weapon cast did not reach magic-cast (got ${battleSt.battleState})` };
      }
      let wired = 0;
      while (battleSt.battleState === 'magic-cast' && wired < 5000) {
        battleSt.battleTimer += 1; wired += 1; updateSpellCast(1);
      }
      if (wired !== BUILDUP) {
        return { pass: false, name, reason: `weapon cast through the turn dispatcher ran ${wired}ms, wanted ${BUILDUP} — is opts.fromEquipment still set?` };
      }
      return { pass: true, name, info: `equipment windup ${equip.castMs}ms = normal, consumable ${consumable.castMs}ms, sparkle reached, call site wired` };
    } catch (e) {
      return { pass: false, name, reason: `threw: ${e && e.message ? e.message : String(e)}` };
    } finally {
      battleSt.battleState = saved.state; battleSt.battleTimer = saved.timer;
      battleSt.encounterMonsters = saved.mons; battleSt.turnQueue = saved.queue;
      inputSt.playerActionPending = saved.pending;
    }
  },
  // Regression — quest items cannot be sold, and every shop catalog is real.
  //
  // All three key items (0x98 Magic Key, 0x99, 0xa4) carry a `price`, and the
  // sell list was built from "has a price". So the shop bought the Magic Key —
  // the thing that opens the Altar Cave locked rooms — for 100 gil, and the
  // server agreed. The TRADE path had blocked key items since v1.7.616 with its
  // own `new Set(['key'])`, stating the reason plainly: they are quest flags,
  // not goods. One rule, enforced in one sibling and not the other. Both now
  // read the shared `isQuestItem`. v1.7.862.
  () => {
    const name = 'regression — quest items are unsellable and shop catalogs are valid';
    const bad = [];
    // 0. Pin the known key items BY ID. Looping the type set alone passes
    //    vacuously if someone empties `QUEST_ITEM_TYPES` — which is exactly
    //    what the first version of this gate did.
    for (const id of [0x98, 0x99, 0xa4]) {
      if (!isQuestItem(id)) bad.push(`0x${id.toString(16)} is no longer a quest item`);
      if (isSellable(id))   bad.push(`0x${id.toString(16)} is SELLABLE`);
    }
    if (!QUEST_ITEM_TYPES.has('key')) bad.push("QUEST_ITEM_TYPES no longer covers 'key'");
    // 1. And nothing else in a quest type may be sellable either.
    for (const [id, it] of ITEMS) {
      if (!QUEST_ITEM_TYPES.has(it.type)) continue;
      if (!isQuestItem(id)) bad.push(`0x${id.toString(16)} not flagged quest`);
      if (isSellable(id))   bad.push(`0x${id.toString(16)} (${it.type}) is SELLABLE`);
    }
    if (bad.length) return { pass: false, name, reason: bad.join(', ') };
    if (!isSellable(0xa6)) return { pass: false, name, reason: 'an ordinary potion stopped being sellable' };
    if (isQuestItem(0xa6)) return { pass: false, name, reason: 'a potion is flagged as a quest item' };

    // 2. Every shop catalog entry exists and has a price — a missing price
    //    silently reads as free on one side and rejects on the other.
    const shopBad = [];
    for (const [shopId, shop] of SHOPS) {
      for (const id of (shop.items || [])) {
        const it = ITEMS.get(id);
        if (!it) { shopBad.push(`${shopId}: 0x${id.toString(16)} not in ITEMS`); continue; }
        if (!(it.price > 0)) shopBad.push(`${shopId}: 0x${id.toString(16)} has no price`);
        if (isQuestItem(id)) shopBad.push(`${shopId}: sells quest item 0x${id.toString(16)}`);
      }
      // 3. A shop that ever declares `spells` must price them. `SPELL_BUY_PRICE`
      //    covers 6 of 56 and `getSpellBuyPrice` returns 0 for the rest, so the
      //    day someone adds a spell catalog, 50 spells would be free. No shop
      //    declares one today, so this is a tripwire rather than a live check.
      for (const sid of (shop.spells || [])) {
        if (!(getSpellBuyPrice(sid) > 0)) shopBad.push(`${shopId}: spell 0x${sid.toString(16)} would be FREE`);
      }
    }
    if (shopBad.length) return { pass: false, name, reason: shopBad.join(', ') };
    const quest = [...ITEMS].filter(([id]) => isQuestItem(id)).length;
    return { pass: true, name, info: `${quest} quest items unsellable, ${SHOPS.size} shop catalogs valid` };
  },
  // Regression — every dungeon floor generates a playable map, on the kind of
  // seeds the game actually uses.
  //
  // `map-triggers.js` seeds with `Date.now()`, so consecutive small seeds prove
  // nothing about live floors. This runs 60 timestamp-style seeds per floor
  // through the shared `sweepFloors` and fails on the unambiguous breakage: a
  // floor that throws, a floor with essentially nothing reachable, or an exit
  // staircase the player cannot walk to.
  //
  // The "nothing reachable" arm is the one with a story. `floor-view.mjs` — the
  // tool CLAUDE.md tells you to validate gen changes with — seeded its flood at
  // the entrance and the four tiles BELOW it. Floor 4's entrance is at the
  // BOTTOM with the boss chamber above, so the flood never started and the
  // viewer reported that entire floor unreachable, on every seed, for as long
  // as it has existed. v1.7.865.
  () => {
    const name = 'regression — every dungeon floor is generable and traversable';
    if (!_romLoaded) return { pass: true, name, info: 'SKIPPED — no FF3-English.nes in this checkout' };
    const { hard, rows } = sweepFloors(_romBytes, 60);
    if (hard.length) {
      return { pass: false, name, reason: hard.slice(0, 4).join('; ') + (hard.length > 4 ? ` (+${hard.length - 4} more)` : '') };
    }
    const seeds = rows.reduce((a, r) => a + r.seeds, 0);
    return { pass: true, name, info: `${rows.length} floors x 60 timestamp seeds = ${seeds} maps, all traversable` };
  },
  // Regression — the dungeon sweep's walkability approximation must never be
  // OPTIMISTIC about the real game.
  //
  // `tools/dungeon-sweep.mjs` floods generated floors with a hand-written tile-id
  // set, because the real `MapRenderer.isPassable` needs a DOM and cannot run in
  // a plain node tool. Every reachability claim that gate makes — "the exit is
  // reachable", "this floor has a real region" — rests on that list never
  // calling something passable that the game blocks. If it ever does, the gate
  // starts passing floors the player cannot actually walk. The opposite
  // direction is fine and expected: the list is stricter than the game on 9 ids
  // (0x70 door, 0x04 water, 0x61, 0x3a-0x3f), so its `stranded` counts are
  // upper bounds. v1.7.866.
  () => {
    const name = 'regression — dungeon walkability set is never more permissive than the game';
    if (!_romLoaded) return { pass: true, name, info: 'SKIPPED — no FF3-English.nes in this checkout' };
    const optimistic = new Map();
    let compared = 0, stricter = 0;
    for (let k = 0; k < 12; k++) {
      for (const f of [0, 1, 2, 3, 4]) {
        const r = generateFloor(_romBytes, f, 1754900000000 + k * 7919);
        const mr = new MapRenderer(r, r.entranceX, r.entranceY);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
          // The entrance is special-cased passable by the renderer; skip it.
          if (x === r.entranceX && y === r.entranceY) continue;
          const tile = r.tilemap[y * 32 + x];
          mr._playerZ = 0;
          const game = mr.isPassable(x, y);
          const tool = PASS.has(tile);
          compared++;
          if (tool && !game) optimistic.set(tile, (optimistic.get(tile) || 0) + 1);
          else if (!tool && game) stricter++;
        }
      }
    }
    if (optimistic.size) {
      const list = [...optimistic].map(([t, n]) => `0x${t.toString(16)} x${n}`).join(', ');
      return { pass: false, name, reason: `PASS claims walkable where the game blocks: ${list}` };
    }
    return { pass: true, name, info: `${compared} tiles compared, 0 optimistic, ${stricter} conservatively strict` };
  },
];

// ── Runner ─────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const filter = [...args].find(a => a.startsWith('--filter='));
const pat = filter ? filter.slice('--filter='.length).toLowerCase() : null;

let passed = 0, failed = 0;
const failures = [];

for (const t of tests) {
  let result;
  try {
    result = t();
  } catch (e) {
    result = { pass: false, name: '(threw)', reason: e && e.stack ? e.stack : String(e) };
  }
  if (pat && !result.name.toLowerCase().includes(pat)) continue;
  if (result.pass) {
    passed++;
    const info = result.info ? `  (${result.info})` : '';
    process.stdout.write(`  ok    ${result.name}${info}\n`);
  } else {
    failed++;
    failures.push(result);
    process.stdout.write(`  FAIL  ${result.name}\n        ${result.reason}\n`);
  }
}

process.stdout.write('\n');
if (failed === 0) {
  process.stdout.write(`encounter-sim — ${passed} passed\n`);
  process.exit(0);
} else {
  process.stdout.write(`encounter-sim — ${passed} passed / ${failed} FAILED\n`);
  process.exit(1);
}
