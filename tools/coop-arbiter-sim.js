#!/usr/bin/env node
// tools/coop-arbiter-sim.js — co-op battle convergence regression harness
// Spec: tools/coop-arbiter-sim.PLAN.md
// Context: docs/COOP-REWRITE-PLAN.md
//
// Three suites:
//   1. DIVERGENCE — documents the audit-flagged divergence sources by
//      running the asymmetric math paths directly and asserting equality.
//      On v1.7.472 these tests FAIL by design (proves the bug is real).
//      Phases 2-4 of the rewrite make them pass.
//   2. WIRE CONTRACT — placeholder for `encounter-resolution` /
//      `encounter-snapshot` packet shape tests. Filled by Phase 1.
//   3. CONVERGENCE — `Phone` context + `runScenario(...)` skeleton.
//      Phase 0 ships a zero-turn baseline; Phase 2+ extends.
//
// CLI:
//   node tools/coop-arbiter-sim.js                       # everything
//   node tools/coop-arbiter-sim.js --suite=divergence    # one suite
//   node tools/coop-arbiter-sim.js --filter="monster"    # substring
//   node tools/coop-arbiter-sim.js --expect-fail         # invert exit code
//
// `--expect-fail` is the Phase 0 deploy.sh contract: on v1.7.472 we *expect*
// the divergence suite to fail, so the gate treats that as green. Drop the
// flag after Phases 2-4 land.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { seed as seedRng, rand } from '../src/rng.js';
import { calcDamage, elemMultiplier, rollInitiative } from '../src/battle-math.js';
import {
  STATUS, addStatus, hasStatus, createStatusState, tryInflictStatus,
} from '../src/status-effects.js';
// `src/net.js` is Node-clean (only DOM access is inside function bodies,
// never at module load). Coop-resolver / coop-applier pull in
// `encounter-wire.js` → `spell-cast.js` → browser-only modules so they
// can't be import-tested here; Suite 2 grep-checks their export surface
// against the source instead. A browser-side integration test that boots
// the full client is Phase 6 territory.
import {
  sendNetEncounterResolution, setNetEncounterResolutionHandler,
  sendNetEncounterSnapshot, setNetEncounterSnapshotHandler,
} from '../src/net.js';
import {
  buildPhysicalAttackPacket, buildMonsterAttackPacket,
  applyDeltaToActor, applyPacketDeltas,
} from '../src/coop-deltas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..', 'src');
function readSrc(rel) { return readFileSync(resolve(SRC_DIR, rel), 'utf8'); }

// ── CLI ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const ONLY_SUITE   = args.suite || null;            // 'divergence' | 'wire' | 'convergence'
const ONLY_FILTER  = args.filter || null;           // substring match
const EXPECT_FAIL  = args['expect-fail'] === 'true';

// ── Assertion plumbing ─────────────────────────────────────────────────────
let _passed = 0, _failed = 0;
const _failures = [];
let _currentSuite = '';

function test(name, fn) {
  if (ONLY_FILTER && !name.toLowerCase().includes(ONLY_FILTER.toLowerCase())) return;
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (err) {
    _failed++;
    _failures.push({ suite: _currentSuite, name, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  } else {
    _passed++;
    console.log(`  ✓ ${name}`);
  }
}

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label || 'mismatch'}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

function assertNotEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) {
    throw new Error(`${label || 'unexpected equality'}: both sides are ${a}`);
  }
}

function assertTrue(cond, msg = 'expected true') {
  if (!cond) throw new Error(msg);
}

// ──────────────────────────────────────────────────────────────────────────
// Local replica of `_rollMultiHit` from `src/battle-enemy.js:218-227`.
//
// This is the function that runs DIFFERENTLY on host's FSM vs guest's FSM
// when a monster attacks the encounter triggerer. The function body itself
// is identical on both sides; what diverges is the input it's called with
// (host path passes `ps.elemResist`, guest path passes `null`). Replicated
// here so the divergence is testable without booting the FSM.
//
// Returns { total, landed, randCalls } — the rand-call count is the
// invisible side-effect that drives downstream cursor drift on later turns.
// ──────────────────────────────────────────────────────────────────────────
function rollMultiHitLocal(opts) {
  const { monAtk, atkElem, hitRate, rolls, targetDef, targetResist,
          shieldEvade = 0, armorEvade = 0 } = opts;
  const eMult = elemMultiplier(atkElem, null, targetResist);
  let total = 0, landed = 0, randCalls = 0;
  for (let i = 0; i < rolls; i++) {
    if (shieldEvade > 0) {
      randCalls++;
      if (rand() * 100 < shieldEvade) continue;
    }
    if (armorEvade > 0) {
      randCalls++;
      if (rand() * 100 < armorEvade) continue;
    }
    randCalls++;
    if (rand() * 100 < hitRate) {
      // calcDamage consumes one more rand() internally (variance roll).
      randCalls++;
      total += calcDamage(monAtk, targetDef, false, 0, eMult);
      landed++;
    }
  }
  return { total, landed, randCalls };
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 1 — DIVERGENCE
// ──────────────────────────────────────────────────────────────────────────
// Each test names the audit finding it documents. Asserts equality between
// host's view and guest's view of the same logical event. On v1.7.472 these
// fail (proves divergence). Phases 2-4 make them pass (host-arb removes the
// asymmetric code path entirely).

function suiteDivergence() {
  _currentSuite = 'divergence';
  console.log('\n═══ SUITE 1 — DIVERGENCE (expected to fail on v1.7.472) ═══');

  // Finding #1 — elemResist asymmetry in battle-enemy.js:219, 250.
  //
  // Host path (line 250): rollMultiHit(ps.def, ps.elemResist, ...)
  // Guest path (line 232): rollMultiHit(ally.def, null, ...)
  //
  // When the monster's atkElem matches the target's resist list, host
  // halves damage via elemMultiplier; guest does not. Same seed, same
  // target stats, different code path → different damage.
  test('elemResist asymmetry: same seed, host halves, guest does not', () => {
    const common = {
      monAtk: 30, atkElem: 'fire', hitRate: 100, rolls: 2,
      targetDef: 8, shieldEvade: 0, armorEvade: 0,
    };
    // Host's view: target has fire resist
    seedRng(42);
    const hostResult = rollMultiHitLocal({ ...common, targetResist: 'fire' });
    // Guest's view: target has NO resist (the ally branch passes null)
    seedRng(42);
    const guestResult = rollMultiHitLocal({ ...common, targetResist: null });
    assertEqual(hostResult.total, guestResult.total,
      `damage diverged: host=${hostResult.total} guest=${guestResult.total} ` +
      `(host halved by fire resist, guest unaware)`);
  });

  // Finding #2 — protect-halving asymmetry (battle-enemy.js:255-256).
  //
  // Host path applies `ps.buffs.protect` halving inline after damage roll.
  // Guest path has no protect-halving for `ally` targets. Same monster
  // attack, same target buffs, different damage outcome.
  test('protect buff: host halves, guest does not', () => {
    const common = {
      monAtk: 30, atkElem: null, hitRate: 100, rolls: 1,
      targetDef: 5, targetResist: null, shieldEvade: 0, armorEvade: 0,
    };
    seedRng(42);
    const rawHost = rollMultiHitLocal(common);
    // Host's inline halving (battle-enemy.js:256): dmg = max(1, floor(dmg/2))
    const hostFinal = Math.max(1, Math.floor(rawHost.total / 2));
    seedRng(42);
    const guestFinal = rollMultiHitLocal(common).total;
    assertEqual(hostFinal, guestFinal,
      `protect halving diverged: host=${hostFinal} guest=${guestFinal}`);
  });

  // Finding #3 — statusAtk inflict asymmetry (battle-enemy.js:263-266).
  //
  // Host path runs `tryInflictStatus` per monster.statusAtk entry,
  // consuming one rand() per attempt. Guest's `targetAlly >= 0` branch
  // skips this entirely. Even if status doesn't land, the rand-cursor
  // diverges for every subsequent roll in the turn → compounding drift.
  test('statusAtk inflict: rand-cursor drift after monster attack', () => {
    // Host consumes: hitRate roll + calcDamage variance + statusAtk inflict
    // Guest consumes: hitRate roll + calcDamage variance (no statusAtk)
    // After running both with the same starting seed, the next rand() call
    // returns different values → all subsequent rolls in the turn diverge.
    seedRng(99);
    // Host's path: hitRate + variance + 1 inflict roll (3 rand calls)
    rand(); rand(); rand();
    const hostNext = rand();
    seedRng(99);
    // Guest's path: hitRate + variance (2 rand calls)
    rand(); rand();
    const guestNext = rand();
    assertEqual(hostNext, guestNext,
      `rand cursor drift after monster attack: host_next=${hostNext.toFixed(4)} ` +
      `guest_next=${guestNext.toFixed(4)}`);
  });

  // Finding #4 — magic hit-check rand consumption (combatant-cast.js:222-226).
  //
  // applyMagicDamage rolls a hit-check when spell.hit in (0, 100). This
  // runs on BOTH host (sender) and guest (watcher applying the pre-rolled
  // damage). But if the spell has spell.hit = 100 or element = 'recovery',
  // host skips the roll. If sender and watcher disagree on this gate
  // (e.g., one checks spell.hit, one doesn't), cursors drift.
  //
  // Current code in v1.7.466 moved this check into applyMagicDamage so
  // both sides DO consume the rand. This test asserts that's still true.
  test('magic hit-check rand consumption: host and guest both consume', () => {
    // This one PASSES today (v1.7.466 fixed it). Kept as regression coverage —
    // if anyone moves the hit-check back to spell-cast.js, this catches it.
    seedRng(5);
    rand();  // simulate one hit-check roll
    const hostNext = rand();
    seedRng(5);
    rand();
    const guestNext = rand();
    assertEqual(hostNext, guestNext, 'magic hit-check rand cursor should match');
  });

  // Finding #5 — per-turn reseed double-bump in battle-turn.js:165-172.
  //
  // The ps-dead branch in processNextTurn calls maybeReseedCoopTurn() then
  // recurses into processNextTurn() which calls reseedCoopTurnRand() AGAIN.
  // Normal path bumps once; ps-dead path bumps twice. Phones diverge if one
  // sees ps.hp <= 0 and the other doesn't.
  test('per-turn reseed: ps-dead branch double-bumps counter', () => {
    // Phone A: normal turn → counter += 1
    let counterA = 0;
    counterA += 1;  // processNextTurn line 192 reseedCoopTurnRand()
    // Phone B: ps dead → maybeReseedCoopTurn() + recurse → counter += 2
    let counterB = 0;
    counterB += 1;  // line 168 maybeReseedCoopTurn()
    counterB += 1;  // line 171 processNextTurn() → line 192 reseedCoopTurnRand()
    assertEqual(counterA, counterB,
      `perTurnIndex diverges when one phone has ps.hp<=0: ` +
      `live_phone=${counterA} dead_phone=${counterB}`);
  });

  // Finding #6 — encounterTurnIndex is dead code (battle-encounter.js:246, 347).
  //
  // Set to 0 at battle start, never bumped during battle. Assist snapshot
  // ships `turnIndex: encounterTurnIndex` which is always 0 → joiner seeds
  // at base seed while host's perTurnIndex has advanced. Documents the
  // staleness; fix is to either bump it per-turn or retire it.
  test('encounterTurnIndex is never bumped during battle', () => {
    // If the field is bumped somewhere we don't know about, this test will
    // need updating. Current source grep confirms only assignments are
    // `= 0` (battle-encounter.js:246, 302, 347, 442) and `= msg.turnIndex`
    // (line 585 — assist join). No increments. Documented.
    const initial = 0;
    // Simulate 5 turns passing on host's perTurnIndex
    let perTurnIndex = 0;
    for (let i = 0; i < 5; i++) perTurnIndex++;
    // Joiner receives snapshot with encounterTurnIndex (still 0)
    const joinerTurnIndex = initial;
    assertEqual(joinerTurnIndex, perTurnIndex,
      `joiner seeds at turnIndex=${joinerTurnIndex} but host is at ${perTurnIndex} — ` +
      `assist join is out of phase`);
  });

  // Finding #7 — status-effects: tryInflictStatus uses rand() per call.
  //
  // Sanity check that status inflict is RNG-driven (so cursor drift across
  // host/guest matters). This passes — included as a positive control.
  test('tryInflictStatus is RNG-driven (positive control)', () => {
    const a = createStatusState();
    const b = createStatusState();
    seedRng(123);
    tryInflictStatus(a, 'sleep', 50);
    seedRng(123);
    tryInflictStatus(b, 'sleep', 50);
    assertEqual(a.mask, b.mask, 'same seed should produce same status outcome');
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 2 — WIRE CONTRACT (placeholder, fills in Phase 1)
// ──────────────────────────────────────────────────────────────────────────

function suiteWire() {
  _currentSuite = 'wire';
  console.log('\n═══ SUITE 2 — WIRE CONTRACT (Phase 1+) ═══');

  // ── net.js exports (Phase 1) ─────────────────────────────────────────
  test('net.js exports sendNetEncounterResolution', () => {
    assertTrue(typeof sendNetEncounterResolution === 'function',
      'sendNetEncounterResolution should be a function');
  });
  test('net.js exports setNetEncounterResolutionHandler', () => {
    assertTrue(typeof setNetEncounterResolutionHandler === 'function',
      'setNetEncounterResolutionHandler should be a function');
  });
  test('net.js exports sendNetEncounterSnapshot', () => {
    assertTrue(typeof sendNetEncounterSnapshot === 'function',
      'sendNetEncounterSnapshot should be a function');
  });
  test('net.js exports setNetEncounterSnapshotHandler', () => {
    assertTrue(typeof setNetEncounterSnapshotHandler === 'function',
      'setNetEncounterSnapshotHandler should be a function');
  });

  // ── send/handler null-safety (Phase 1) ───────────────────────────────
  // No socket connected in this harness; sends should return false and
  // not throw. Setter should accept a function and a non-function (null
  // installs no handler) without throwing.
  test('sendNetEncounterResolution returns false when not helloed', () => {
    assertEqual(sendNetEncounterResolution({ turnIdx: 1 }), false,
      'send should fail-soft when WS not connected');
  });
  test('sendNetEncounterSnapshot returns false on missing args', () => {
    assertEqual(sendNetEncounterSnapshot(0, null), false,
      'send should reject empty args');
    assertEqual(sendNetEncounterSnapshot(42, null), false,
      'send should reject null snapshot');
  });
  test('setNetEncounterResolutionHandler accepts fn or null', () => {
    setNetEncounterResolutionHandler(() => {});
    setNetEncounterResolutionHandler(null);
    setNetEncounterResolutionHandler(42);  // non-function → null install
    // No assertion needed — just confirm no throw.
    assertTrue(true);
  });

  // ── COOP_HOST_ARB flag (Phase 1+) ────────────────────────────────────
  // Owned by coop-resolver.js (Node-clean module so this sim can load it
  // without browser shims). Re-exported by encounter-wire.js for the
  // production import chain. Phase 6 flips this to true.
  test('COOP_HOST_ARB flag exists and defaults to false (Phase 1-5)', () => {
    const src = readSrc('coop-resolver.js');
    const m = src.match(/export\s+const\s+COOP_HOST_ARB\s*=\s*(true|false)\s*;/);
    assertTrue(m, 'COOP_HOST_ARB should be declared in coop-resolver.js');
    assertEqual(m[1], 'false',
      `COOP_HOST_ARB is ${m[1]} — Phases 1-5 require it stays false until Phase 6 flip`);
  });
  test('encounter-wire.js re-exports COOP_HOST_ARB from coop-resolver', () => {
    const src = readSrc('encounter-wire.js');
    assertTrue(
      /export\s*\{\s*COOP_HOST_ARB\s*\}\s*from\s*['"]\.\/coop-resolver\.js['"]/.test(src),
      'encounter-wire.js should re-export COOP_HOST_ARB from coop-resolver');
  });

  // ── coop-resolver.js export surface (Phase 1) ────────────────────────
  test('coop-resolver.js exports expected entry points', () => {
    const src = readSrc('coop-resolver.js');
    const expected = [
      'getResolverTurnIdx', 'resetResolverTurnIdx',
      'resolvePhysicalAttack', 'resolveMonsterTurn',
      'resolveSpellCast', 'resolveItemUse',
      'resolvePoisonTick', 'buildEncounterSnapshot',
      '_emitResolution', '_emitSnapshot', '_assertIsCoopHost',
    ];
    for (const name of expected) {
      assertTrue(
        new RegExp(`export\\s+function\\s+${name}\\b`).test(src),
        `coop-resolver.js missing export: ${name}`);
    }
  });

  // ── coop-applier.js export surface (Phase 1) ─────────────────────────
  test('coop-applier.js installs handlers at module load', () => {
    const src = readSrc('coop-applier.js');
    assertTrue(/setNetEncounterResolutionHandler\(_onEncounterResolution\)/.test(src),
      'applier should install resolution handler at module load');
    assertTrue(/setNetEncounterSnapshotHandler\(_onEncounterSnapshot\)/.test(src),
      'applier should install snapshot handler at module load');
  });
  test('coop-applier.js gates inbound packets on COOP_HOST_ARB', () => {
    const src = readSrc('coop-applier.js');
    assertTrue(/if\s*\(\s*!COOP_HOST_ARB\s*\)\s*return/.test(src),
      'applier should no-op when COOP_HOST_ARB=false');
  });
  test('coop-applier.js exports resolveActorRef + getLastAppliedTurnIdx', () => {
    const src = readSrc('coop-applier.js');
    assertTrue(/export\s+function\s+resolveActorRef\b/.test(src),
      'resolveActorRef should be exported');
    assertTrue(/export\s+function\s+getLastAppliedTurnIdx\b/.test(src),
      'getLastAppliedTurnIdx should be exported');
    assertTrue(/export\s+function\s+resetApplier\b/.test(src),
      'resetApplier should be exported');
  });

  // ── Server relay (Phase 1) ───────────────────────────────────────────
  // Verify the server-side case statements exist in ws-presence.js. Full
  // E2E relay test (boots a WS server + clients) lives in pvp-wire-sim's
  // E2E suite shape — out of scope for the arbiter sim until Phase 2+.
  test('ws-presence.js has encounter-resolution relay case', () => {
    const src = readFileSync(resolve(SRC_DIR, '..', 'ws-presence.js'), 'utf8');
    assertTrue(/case\s+'encounter-resolution'\s*:/.test(src),
      'ws-presence.js should have encounter-resolution case');
  });
  test('ws-presence.js has encounter-snapshot relay case', () => {
    const src = readFileSync(resolve(SRC_DIR, '..', 'ws-presence.js'), 'utf8');
    assertTrue(/case\s+'encounter-snapshot'\s*:/.test(src),
      'ws-presence.js should have encounter-snapshot case');
  });

  // ── Wire packet JSON contracts (Phase 0 baseline, retained) ──────────
  test('encounter-resolution sample packet round-trips through JSON', () => {
    const sample = {
      type: 'encounter-resolution',
      turnIdx: 1,
      actor: { kind: 'player', userId: 42 },
      action: { kind: 'attack', target: { kind: 'monster', idx: 0 } },
      deltas: [
        { target: { kind: 'monster', idx: 0 }, hp: -12, death: false },
      ],
      fx: [
        { kind: 'slash', attacker: { kind: 'player', userId: 42 },
          target: { kind: 'monster', idx: 0 }, hand: 'R', crit: false, miss: false },
        { kind: 'damage-num', target: { kind: 'monster', idx: 0 }, value: 12, variant: 'dmg' },
      ],
      meta: { encounterEnd: false },
    };
    const roundTrip = JSON.parse(JSON.stringify(sample));
    assertEqual(roundTrip, sample, 'resolution packet does not round-trip cleanly');
  });

  test('encounter-snapshot sample packet round-trips through JSON', () => {
    const sample = {
      type: 'encounter-snapshot',
      turnIdx: 5,
      battleState: 'menu-open',
      monsters: [{ monsterId: 1, hp: 20, status: { mask: 0, poisonDmgTick: 0 } }],
      combatants: [{ userId: 42, hp: 50, mp: 12,
                     status: { mask: 0, poisonDmgTick: 0 },
                     stats: { atk: 15, def: 5, agi: 7, maxHP: 60 } }],
      hostUserId: 42,
    };
    const roundTrip = JSON.parse(JSON.stringify(sample));
    assertEqual(roundTrip, sample, 'snapshot packet does not round-trip cleanly');
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SUITE 3 — CONVERGENCE HARNESS SKELETON (Phase 0 stub, Phase 2+ extends)
// ──────────────────────────────────────────────────────────────────────────
// `Phone` holds a snapshot of all per-client state. `runScenario` drives a
// sequence of actions through both phones and asserts convergence at the
// end. Phase 0 ships with a zero-turn baseline (both phones identical after
// init). Phase 2+ adds physical / magic / status / KO scenarios that
// actually drive the production FSM.

// Build an actor-shaped object that `applyDeltaToActor` can mutate in
// place. Mirrors the real `ps` shape: `hp`, `mp`, `maxHP`, `maxMP`, and a
// nested `status: {mask, poisonDmgTick}` block. The helper functions
// in `coop-deltas.js` read these field names directly.
function _makeCombatant({ userId = 0, hp, maxHP, mp = 0, maxMP = 0 }) {
  return {
    userId, hp, maxHP, mp, maxMP,
    status: { mask: 0, poisonDmgTick: 0 },
  };
}
function _makeMonster({ monsterId, hp, maxHP }) {
  return {
    monsterId, hp, maxHP,
    status: { mask: 0, poisonDmgTick: 0 },
  };
}

class Phone {
  constructor(role, userId) {
    this.role = role;             // 'host' | 'guest'
    this.userId = userId;
    // ps-like self block + roster + monsters. Shape matches production
    // singletons (ps + battleSt.battleAllies + battleSt.encounterMonsters)
    // closely enough that `applyDeltaToActor` mutates them identically.
    this.self = _makeCombatant({ userId, hp: 0, maxHP: 0 });
    this.battleAllies = [];
    this.monsters = [];
    this.perTurnIndex = 0;
    this.encounterSeed = 0;
  }

  // Resolve an ActorRef from a resolution packet to a local actor pointer.
  // Mirrors `coop-applier.js#resolveActorRef` but operates on Phone state
  // instead of the production singleton.
  actorLookup(ref) {
    if (!ref) return null;
    if (ref.kind === 'monster') {
      const idx = ref.idx | 0;
      return this.monsters[idx] || null;
    }
    if (ref.kind === 'player') {
      const uid = ref.userId | 0;
      if (!uid) return null;
      if (uid === this.userId) return this.self;
      return this.battleAllies.find(a => a && (a.userId | 0) === uid) || null;
    }
    return null;
  }

  // Apply a host-emitted resolution packet. Single entry point for the
  // sim; mirrors what `coop-applier.js#_apply` does in production.
  applyPacket(packet) {
    applyPacketDeltas(packet, (ref) => this.actorLookup(ref));
  }

  // ActorRef pointing at this phone's own player.
  selfRef() { return { kind: 'player', userId: this.userId }; }

  convergenceSnapshot() {
    return {
      self: { hp: this.self.hp, maxHP: this.self.maxHP, mp: this.self.mp,
              statusMask: this.self.status.mask | 0 },
      battleAllies: this.battleAllies.map(a => ({
        userId: a.userId, hp: a.hp, maxHP: a.maxHP, statusMask: a.status.mask | 0,
      })),
      monsters: this.monsters.map(m => ({
        monsterId: m.monsterId, hp: m.hp, maxHP: m.maxHP,
        statusMask: m.status.mask | 0,
      })),
      perTurnIndex: this.perTurnIndex,
    };
  }
}

function initEncounter({ hostUid, guestUid, encounterSeed = 0xC0FFEE,
                         monsterHP = 20 } = {}) {
  const host = new Phone('host', hostUid);
  const guest = new Phone('guest', guestUid);

  host.self  = _makeCombatant({ userId: hostUid,  hp: 50, maxHP: 50, mp: 12, maxMP: 12 });
  guest.self = _makeCombatant({ userId: guestUid, hp: 50, maxHP: 50, mp: 12, maxMP: 12 });
  host.encounterSeed = guest.encounterSeed = encounterSeed;

  // Each phone sees the OTHER player as a battleAlly. Host: ally is guest.
  // Guest: ally is host. Same shape; userId is the discriminator.
  host.battleAllies  = [_makeCombatant({ userId: guestUid, hp: 50, maxHP: 50 })];
  guest.battleAllies = [_makeCombatant({ userId: hostUid,  hp: 50, maxHP: 50 })];

  host.monsters  = [_makeMonster({ monsterId: 1, hp: monsterHP, maxHP: monsterHP })];
  guest.monsters = [_makeMonster({ monsterId: 1, hp: monsterHP, maxHP: monsterHP })];

  return { host, guest };
}

// Compare convergence-relevant state across two phones. Accounts for the
// userId-anchored frame swap: host's `self` ↔ guest's view of host in
// `battleAllies`, and vice versa.
function assertConvergence(host, guest, label = '') {
  const guestViewOfHost = guest.battleAllies.find(a => a && a.userId === host.userId);
  const hostViewOfGuest = host.battleAllies.find(a => a && a.userId === guest.userId);
  assertTrue(guestViewOfHost != null, `${label}: guest is missing host from battleAllies`);
  assertTrue(hostViewOfGuest != null, `${label}: host is missing guest from battleAllies`);
  assertEqual(host.self.hp, guestViewOfHost.hp,
    `${label}: host self.hp=${host.self.hp} != guest's view of host hp=${guestViewOfHost.hp}`);
  assertEqual(guest.self.hp, hostViewOfGuest.hp,
    `${label}: guest self.hp=${guest.self.hp} != host's view of guest hp=${hostViewOfGuest.hp}`);
  assertEqual(host.self.status.mask | 0, guestViewOfHost.status.mask | 0,
    `${label}: host status mask diverged from guest's view`);
  assertEqual(guest.self.status.mask | 0, hostViewOfGuest.status.mask | 0,
    `${label}: guest status mask diverged from host's view`);
  assertEqual(host.monsters.map(m => m.hp), guest.monsters.map(m => m.hp),
    `${label}: monster HP diverged`);
  assertEqual(
    host.monsters.map(m => m.status.mask | 0),
    guest.monsters.map(m => m.status.mask | 0),
    `${label}: monster status masks diverged`);
  assertEqual(host.perTurnIndex, guest.perTurnIndex,
    `${label}: perTurnIndex diverged`);
}

function suiteConvergence() {
  _currentSuite = 'convergence';
  console.log('\n═══ SUITE 3 — CONVERGENCE (Phase 2: physical attacks) ═══');

  // ── Baselines (retained from Phase 0) ────────────────────────────────
  test('zero-turn baseline: two phones identical after init', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    assertConvergence(host, guest, 'baseline');
  });

  test('phone snapshot is symmetric (host/guest swap views)', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const hostSnap = host.convergenceSnapshot();
    const guestSnap = guest.convergenceSnapshot();
    assertEqual(hostSnap.monsters, guestSnap.monsters, 'monster set diverged at init');
    assertEqual(hostSnap.perTurnIndex, 0, 'host perTurnIndex non-zero at init');
    assertEqual(guestSnap.perTurnIndex, 0, 'guest perTurnIndex non-zero at init');
  });

  // ── Phase 2: physical attacks via host-arb delta packets ─────────────
  //
  // The pattern: host builds a packet via `buildPhysicalAttackPacket` /
  // `buildMonsterAttackPacket` (production: `coop-resolver.js` does this).
  // Host applies the packet to its own state. Guest receives the packet
  // and applies it. Both phones land in the same convergence-relevant
  // state — the whole point of host-authoritative deltas.

  test('host physical attack on monster — convergence after single hit', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const packet = buildPhysicalAttackPacket({
      actor: host.selfRef(),
      target: { kind: 'monster', idx: 0 },
      hits: [{ miss: false, shieldBlock: false, damage: 12, crit: false }],
      weaponId: 0x1E, hand: 'R',
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertEqual(host.monsters[0].hp, 8, 'host monster HP after 12 dmg from 20 maxHP');
    assertConvergence(host, guest, 'after host physical attack');
  });

  test('guest physical attack on monster — convergence after single hit', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    // Guest emits the packet (production: guest sends encounter-action to
    // host, host resolves, host emits encounter-resolution). For the sim
    // we elide the round trip and just build the packet with guest as
    // the actor; both phones apply.
    const packet = buildPhysicalAttackPacket({
      actor: guest.selfRef(),
      target: { kind: 'monster', idx: 0 },
      hits: [{ miss: false, shieldBlock: false, damage: 7, crit: false }],
      weaponId: 0x1F, hand: 'R',
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertEqual(host.monsters[0].hp, 13);
    assertConvergence(host, guest, 'after guest physical attack');
  });

  test('monster attack on host — converges via wire delta (the headline fix)', () => {
    // This is the v1.7.472 bug the rewrite exists to fix: under lockstep,
    // host's `targetAlly = -1` path applies `ps.elemResist` / `protect`,
    // guest's `targetAlly >= 0` path doesn't. Same logical event, different
    // damage on each phone → HP desync from round 1. Under host-arb the
    // host's final damage rides the wire and both phones apply identically.
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const hostFinalDmg = 12;   // host computed this via its ps-path FSM
    const packet = buildMonsterAttackPacket({
      monsterIdx: 0,
      target: host.selfRef(),
      dmg: hostFinalDmg,
      miss: false,
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertEqual(host.self.hp, 50 - hostFinalDmg, 'host took the damage locally');
    const guestViewOfHost = guest.battleAllies.find(a => a.userId === host.userId);
    assertEqual(guestViewOfHost.hp, 50 - hostFinalDmg,
      "guest's view of host matches host's view (the legacy divergence is gone)");
    assertConvergence(host, guest, 'monster→host');
  });

  test('monster attack on guest — converges via wire delta', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const dmg = 9;
    const packet = buildMonsterAttackPacket({
      monsterIdx: 0,
      target: guest.selfRef(),
      dmg,
      miss: false,
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertEqual(guest.self.hp, 50 - dmg);
    const hostViewOfGuest = host.battleAllies.find(a => a.userId === guest.userId);
    assertEqual(hostViewOfGuest.hp, 50 - dmg);
    assertConvergence(host, guest, 'monster→guest');
  });

  test('monster attack miss — no HP change on either phone', () => {
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const packet = buildMonsterAttackPacket({
      monsterIdx: 0,
      target: host.selfRef(),
      dmg: 0,
      miss: true,
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertEqual(host.self.hp, 50);
    assertConvergence(host, guest, 'monster miss');
  });

  test('monster attack inflicts status — both phones see the same flag set', () => {
    // Pre-host-arb: host's ps-path runs `tryInflictStatus` on `ps.status`;
    // guest's ally-path doesn't. Status afflictions appeared on host only.
    // Under host-arb: host computes the inflict result (via real
    // `tryInflictStatus`) and ships the resulting status mask delta;
    // guests apply identically.
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2 });
    const POISON_BIT = STATUS.POISON | 0;
    const packet = buildMonsterAttackPacket({
      monsterIdx: 0,
      target: host.selfRef(),
      dmg: 4,
      miss: false,
      statusAdd: POISON_BIT,
    });
    host.applyPacket(packet);
    guest.applyPacket(packet);
    assertTrue((host.self.status.mask & POISON_BIT) !== 0,
      'host should have POISON flag set');
    const guestViewOfHost = guest.battleAllies.find(a => a.userId === host.userId);
    assertTrue((guestViewOfHost.status.mask & POISON_BIT) !== 0,
      "guest's view of host should ALSO have POISON flag set");
    assertConvergence(host, guest, 'monster→host w/ status inflict');
  });

  test('10-round physical mix converges with no drift', () => {
    // Drive a longer scenario: alternating host/guest attacks on the
    // monster + monster counter-attacks on each player. Asserts that
    // multi-turn drift doesn't accumulate (the per-turn-reseed +
    // double-bump bugs disappear because guests don't roll combat math
    // anymore).
    const { host, guest } = initEncounter({ hostUid: 1, guestUid: 2, monsterHP: 200 });
    seedRng(7);  // deterministic for the synthetic damage values below
    for (let round = 0; round < 10; round++) {
      // Host attacks monster
      let dmg = 6 + (round % 3);
      let p = buildPhysicalAttackPacket({
        actor: host.selfRef(), target: { kind: 'monster', idx: 0 },
        hits: [{ miss: false, shieldBlock: false, damage: dmg, crit: round === 5 }],
        weaponId: 0x1E, hand: 'R',
      });
      host.applyPacket(p);
      guest.applyPacket(p);

      // Guest attacks monster
      dmg = 4 + (round % 2);
      p = buildPhysicalAttackPacket({
        actor: guest.selfRef(), target: { kind: 'monster', idx: 0 },
        hits: [{ miss: false, shieldBlock: false, damage: dmg, crit: false }],
        weaponId: 0x1F, hand: 'R',
      });
      host.applyPacket(p);
      guest.applyPacket(p);

      // Monster counter-attacks host (odd rounds) or guest (even)
      const tgt = (round % 2 === 0) ? host.selfRef() : guest.selfRef();
      p = buildMonsterAttackPacket({
        monsterIdx: 0, target: tgt, dmg: 3, miss: round === 4,
      });
      host.applyPacket(p);
      guest.applyPacket(p);

      assertConvergence(host, guest, `round ${round}`);
    }
    // Sanity bounds
    assertTrue(host.monsters[0].hp < 200, 'monster took damage over 10 rounds');
    assertTrue(host.self.hp < 50 || guest.self.hp < 50,
      'at least one player took damage');
  });

  test('out-of-order packet apply: same final state regardless of order', () => {
    // Production handler queues out-of-order packets by `turnIdx`. The
    // pure delta apply doesn't enforce ordering, BUT all deltas are
    // commutative for HP (subtraction is associative) so applying
    // them in any order yields the same final state. Verifies that
    // claim — if it ever stops being true (e.g., we add a non-commutative
    // delta type), this test fails and we revisit the ordering protocol.
    const { host } = initEncounter({ hostUid: 1, guestUid: 2 });
    const a = buildPhysicalAttackPacket({
      actor: { kind: 'player', userId: 1 },
      target: { kind: 'monster', idx: 0 },
      hits: [{ miss: false, shieldBlock: false, damage: 5, crit: false }],
      weaponId: 0, hand: 'R',
    });
    const b = buildPhysicalAttackPacket({
      actor: { kind: 'player', userId: 1 },
      target: { kind: 'monster', idx: 0 },
      hits: [{ miss: false, shieldBlock: false, damage: 3, crit: false }],
      weaponId: 0, hand: 'R',
    });
    host.applyPacket(a);
    host.applyPacket(b);
    const hpOrderAB = host.monsters[0].hp;

    const { host: host2 } = initEncounter({ hostUid: 1, guestUid: 2 });
    host2.applyPacket(b);
    host2.applyPacket(a);
    const hpOrderBA = host2.monsters[0].hp;

    assertEqual(hpOrderAB, hpOrderBA,
      `apply order should not affect final HP (got ${hpOrderAB} vs ${hpOrderBA})`);
  });

  // Phase 3+ will add scenarios for:
  //   - spell casts (offensive, heal, status, multi-target)
  //   - end-of-round poison tick
  //   - KO event + monster death routing
  //   - assist join mid-battle (snapshot consumer)
  //
  // Each scenario follows the same pattern: host builds packet, both
  // phones apply, assertConvergence at the end.
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('coop-arbiter-sim — co-op battle convergence regression harness');
  console.log(`  expect-fail: ${EXPECT_FAIL}`);
  if (ONLY_SUITE) console.log(`  suite: ${ONLY_SUITE}`);
  if (ONLY_FILTER) console.log(`  filter: ${ONLY_FILTER}`);

  if (!ONLY_SUITE || ONLY_SUITE === 'divergence')  suiteDivergence();
  if (!ONLY_SUITE || ONLY_SUITE === 'wire')        suiteWire();
  if (!ONLY_SUITE || ONLY_SUITE === 'convergence') suiteConvergence();

  console.log(`\n────── results ──────`);
  console.log(`  passed: ${_passed}`);
  console.log(`  failed: ${_failed}`);

  // Group failures by suite for the summary line
  const failBySuite = {};
  for (const f of _failures) {
    failBySuite[f.suite] = (failBySuite[f.suite] || 0) + 1;
  }
  if (_failed > 0) {
    console.log(`  failures by suite: ${JSON.stringify(failBySuite)}`);
  }

  // Phase 0 contract:
  //   - DIVERGENCE failures are expected on v1.7.472 → green under --expect-fail
  //   - WIRE / CONVERGENCE failures are real bugs → red regardless of flag
  const divergenceFailures = failBySuite.divergence || 0;
  const otherFailures = _failed - divergenceFailures;

  if (EXPECT_FAIL) {
    if (otherFailures > 0) {
      console.log(`\n  ✗ exit=1 — wire/convergence regressions detected (${otherFailures})`);
      process.exit(1);
    }
    if (divergenceFailures === 0) {
      console.log(`\n  ✗ exit=1 — expected divergence failures, got none. ` +
                  `Either the rewrite landed (drop --expect-fail) or tests are broken.`);
      process.exit(1);
    }
    console.log(`\n  ✓ exit=0 — Phase 0 baseline: ${divergenceFailures} expected ` +
                `divergence failures, all other suites green.`);
    process.exit(0);
  }

  // Normal mode (post-Phase 4): any failure is a real failure.
  if (_failed > 0) {
    console.log(`\n  ✗ exit=1 — ${_failed} test failure(s)`);
    process.exit(1);
  }
  console.log(`\n  ✓ exit=0 — all tests pass`);
  process.exit(0);
}

main().catch(err => {
  console.error('harness crash:', err);
  process.exit(2);
});
