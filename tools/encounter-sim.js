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
const { spellUsesCastAnim } = await import('../src/spell-cast.js');

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
    const spills = [];
    for (const [id, e] of CAPTURED_SPELL_ANIMS) {
      if (e.anchor !== 'screen') continue;
      const f = HUD_VIEW_W / e.width;
      let maxX = 0;
      for (const layout of e.layouts) for (const l of layout) maxX = Math.max(maxX, Math.round(l[1] * f) + TILE);
      if (maxX > HUD_VIEW_W) spills.push(`0x${id.toString(16)} reaches x=${maxX}`);
    }
    if (spills.length) {
      return { pass: false, name, reason: `spills into the roster box (x>=${HUD_VIEW_W}): ${spills.join(', ')}` };
    }
    return { pass: true, name, info: `all screen-anchored effects within x<${HUD_VIEW_W}` };
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
