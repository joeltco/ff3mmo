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
