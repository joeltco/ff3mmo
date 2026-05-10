#!/usr/bin/env node
// tools/battle-sim.js — terminal battle simulator
// Spec: tools/battle-sim.PLAN.md
//
// Mirrors prod attack call shapes from battle-turn.js + input-handler.js + pvp.js.
// Runs without a browser so Claude can observe combat output directly.
//
//   node tools/battle-sim.js                                # default RM7 vs BM4
//   node tools/battle-sim.js --p1=RM7 --p2=BM4 --seed=42
//   node tools/battle-sim.js --help

import { calcAttackerAtk, calcPotentialHits, rollHits, elemMultiplier } from '../src/battle-math.js';
import { ITEMS, isWeapon } from '../src/data/items.js';
import { JOBS } from '../src/data/jobs.js';
import { generateAllyStats } from '../src/data/players.js';

// ─── Job shorthand ──────────────────────────────────────────────────────
const JOB_PREFIX = {
  OK:  0, FI:  1, MO:  2, WM:  3, BM:  4, RM:  5, RA:  6, KN:  7,
  TH:  8, SC:  9, GE: 10, DR: 11, VI: 12, BB: 13, MK: 14, CO: 15,
  BA: 16, SU: 17, DE: 18, MG: 19, SA: 20, NI: 21,
};

// ─── Mulberry32 seeded RNG ──────────────────────────────────────────────
function seedRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { p1Over: {}, p2Over: {} };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [rawKey, ...rest] = a.slice(2).split('=');
    const val = rest.join('=');
    if (rawKey === 'help' || rawKey === 'h') { out.help = true; continue; }
    if (rawKey.startsWith('p1.')) { out.p1Over[rawKey.slice(3)] = parseVal(val); continue; }
    if (rawKey.startsWith('p2.')) { out.p2Over[rawKey.slice(3)] = parseVal(val); continue; }
    out[rawKey] = parseVal(val);
  }
  return out;
}

function parseVal(v) {
  if (v === '' || v == null) return true;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return parseInt(v, 16);
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// ─── Profile resolver ───────────────────────────────────────────────────
function resolveProfile(spec, overrides = {}) {
  const m = String(spec).match(/^([A-Z]{2})(\d+)$/);
  if (!m) throw new Error(`Bad profile "${spec}" — expected like RM7 or BM4`);
  const jobIdx = JOB_PREFIX[m[1]];
  if (jobIdx == null) throw new Error(`Unknown job prefix "${m[1]}"`);
  const level = parseInt(m[2], 10);
  // Default loadout location by level tier (drives generateAllyStats fallback armor/weapon)
  const loc =
    level <= 2 ? 'world' :
    level <= 4 ? 'cave-1' :
    level <= 6 ? 'cave-2' : 'cave-3';
  const player = {
    name: spec,
    level,
    palIdx: 0,
    jobIdx,
    loc,
    armorId: 0x73, // body — def 2
    helmId:  0x62, // helmet — def 1
    ...overrides, // weaponR / weaponL / armorId / helmId / shieldId / knownSpells
  };
  const stats = generateAllyStats(player);
  // Stash equipment IDs on the result for the per-hand path (which needs raw weapon ATKs)
  stats.weaponR = player.weaponR != null ? player.weaponR : stats.weaponId;
  stats.weaponL = player.weaponL != null ? player.weaponL : null;
  stats._spec = spec;
  return stats;
}

function describeProfile(p, label) {
  const job = JOBS[p.jobIdx]?.name || `job#${p.jobIdx}`;
  const r = ITEMS.get(p.weaponR);
  const l = p.weaponL != null ? ITEMS.get(p.weaponL) : null;
  const wpnStr = `R: ${itemStr(p.weaponR, r)}   L: ${itemStr(p.weaponL, l)}`;
  return [
    `${label}: ${p._spec}  ${job} L${p.level}  HP ${p.hp}  ATK ${p.atk}  DEF ${p.def}  AGI ${p.agi}  hitRate ${p.hitRate}`,
    `    ${wpnStr}   evade ${p.evade}   shieldEvade ${p.shieldEvade}`,
  ].join('\n');
}

function itemStr(id, item) {
  if (item == null) return id == null ? '-' : `0x${id.toString(16)} (unknown)`;
  if (item.type !== 'weapon' || item.subtype === 'shield') {
    return `${item.subtype} (no atk)`;
  }
  return `${item.subtype} atk ${item.atk}, hit ${item.hit}`;
}

// ─── Three attack call shapes ───────────────────────────────────────────
//
// 1. Player single-wield: battle-turn.js:106. One rollHits call, dualWield=false.
// 2. Player dual-wield:   input-handler.js:173-212. TWO rollHits (R then L),
//    per-hand atk = (att.atk - rWpn - lWpn) + handWpn  ← suspect for L7 RM bug
// 3. PVP / ally:          battle-turn.js:187, pvp.js:386. ONE rollHits using
//    att.atk precomputed, dualWield flag passed to calcPotentialHits.

function attackPlayerSingleWield(att, def, opts = {}) {
  const job = JOBS[att.jobIdx] || {};
  const wpnElem = ITEMS.get(att.weaponR)?.element || null;
  const elemMult = elemMultiplier(wpnElem, def.weakness, def.resist);
  const hits = calcPotentialHits(att.level, att.agi, false);
  const results = rollHits(att.atk, def.def, att.hitRate, hits, {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    elemMult,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: !!opts.targetProtected,
  });
  return { path: 'player-single', atkUsed: att.atk, hitsRolled: hits, results };
}

function attackPlayerDualWield(att, def, opts = {}) {
  const job = JOBS[att.jobIdx] || {};
  const rWpn = ITEMS.get(att.weaponR);
  const lWpn = att.weaponL != null ? ITEMS.get(att.weaponL) : null;
  const rWpnAtk = (rWpn?.atk) || 0;
  const lWpnAtk = (lWpn?.atk) || 0;
  const rArmed = isWeapon(att.weaponR);
  const lArmed = att.weaponL != null && isWeapon(att.weaponL);
  // input-handler.js:178 — strip the AVERAGE of weapon ATKs (matches what
  // calcAttackerAtk added for dual-wield). Single-wield strips the equipped
  // weapon (one of the two ATKs is 0).
  const wpnAtkComponent = (rArmed && lArmed)
    ? Math.floor((rWpnAtk + lWpnAtk) / 2)
    : rWpnAtk + lWpnAtk;
  const baseAtk = att.atk - wpnAtkComponent;
  const hitsPerHand = calcPotentialHits(att.level, att.agi, false);
  const critOpts = {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: !!opts.targetProtected,
  };
  function rollHand(wpn) {
    const handAtk = baseAtk + (wpn ? (wpn.atk || 0) : 0);
    const handHit = wpn ? (wpn.hit || 80) : 80;
    return {
      atk: handAtk,
      hit: handHit,
      results: rollHits(handAtk, def.def, handHit, hitsPerHand, critOpts),
    };
  }
  const r = rollHand(rWpn);
  const l = rollHand(lWpn);
  return {
    path: 'player-dual',
    baseAtk,
    rHand: r,
    lHand: l,
    hitsRolled: hitsPerHand * 2,
    results: [...r.results, ...l.results],
  };
}

function attackPVP(att, def, opts = {}) {
  const job = JOBS[att.jobIdx] || {};
  const rArmed = isWeapon(att.weaponR);
  const lArmed = att.weaponL != null && isWeapon(att.weaponL);
  const isUnarmed = !rArmed && !lArmed;
  const dualWield = (rArmed && lArmed) || isUnarmed;
  const hits = calcPotentialHits(att.level, att.agi, dualWield);
  const results = rollHits(att.atk, def.def, att.hitRate, hits, {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: !!opts.targetProtected,
  });
  return { path: 'pvp', atkUsed: att.atk, hitsRolled: hits, dualWield, results };
}

function selectAttack(att, override) {
  if (override === 'player-single') return attackPlayerSingleWield;
  if (override === 'player-dual')   return attackPlayerDualWield;
  if (override === 'pvp')           return attackPVP;
  // Auto: matches input-handler.js:165-167 — dual if both hands armed OR unarmed (fists).
  const rArmed = isWeapon(att.weaponR);
  const lArmed = att.weaponL != null && isWeapon(att.weaponL);
  const unarmed = !rArmed && !lArmed;
  if ((rArmed && lArmed) || unarmed) return attackPlayerDualWield;
  return attackPlayerSingleWield;
}

// ─── Output ─────────────────────────────────────────────────────────────
function summarizeRoll(r) {
  if (r.shieldBlock) return 'shield';
  if (r.miss) return 'miss';
  return r.crit ? `${r.damage}!` : String(r.damage);
}

function printAttackResult(att, def, ar) {
  const lines = [];
  lines.push(`  ${att._spec} → ${def._spec}  [path: ${ar.path}]`);
  if (ar.path === 'player-dual') {
    const hitR = ar.rHand.results.map(summarizeRoll).join(', ');
    const hitL = ar.lHand.results.map(summarizeRoll).join(', ');
    const sumR = ar.rHand.results.reduce((s, h) => s + (h.damage || 0), 0);
    const sumL = ar.lHand.results.reduce((s, h) => s + (h.damage || 0), 0);
    lines.push(`    baseAtk = att.atk(${att.atk}) − rWpn − lWpn = ${ar.baseAtk}`);
    lines.push(`    R-hand  atk=${ar.rHand.atk} hit=${ar.rHand.hit}  rolls: [${hitR}]  sum=${sumR}`);
    lines.push(`    L-hand  atk=${ar.lHand.atk} hit=${ar.lHand.hit}  rolls: [${hitL}]  sum=${sumL}`);
  } else {
    const hits = ar.results.map(summarizeRoll).join(', ');
    const sum = ar.results.reduce((s, h) => s + (h.damage || 0), 0);
    const dwTag = ar.path === 'pvp' ? `  dualWield=${ar.dualWield}` : '';
    lines.push(`    atk=${ar.atkUsed} def=${def.def} hitRate=${att.hitRate}${dwTag}  rolls: [${hits}]  sum=${sum}`);
  }
  const total = ar.results.reduce((s, h) => s + (h.damage || 0), 0);
  lines.push(`    total dmg: ${total}`);
  return { lines: lines.join('\n'), total };
}

// ─── Main loop ──────────────────────────────────────────────────────────
function runBattle(p1, p2, opts) {
  const { mode = 'duel', turns = 30, p1Path = 'auto', p2Path = 'auto' } = opts;
  const a1 = selectAttack(p1, p1Path);
  const a2 = selectAttack(p2, p2Path);
  const lines = [];
  lines.push(describeProfile(p1, 'P1'));
  lines.push(describeProfile(p2, 'P2'));
  lines.push('');

  let turn = 0;
  let winner = null;
  while (turn < turns) {
    turn++;
    lines.push(`─── Turn ${turn} ───`);

    // P1 swings
    const r1 = a1(p1, p2);
    const o1 = printAttackResult(p1, p2, r1);
    lines.push(o1.lines);
    const p2HpBefore = p2.hp;
    p2.hp = Math.max(0, p2.hp - o1.total);
    lines.push(`    ${p2._spec} HP: ${p2HpBefore} → ${p2.hp}`);
    if (p2.hp <= 0) { winner = 'P1'; break; }

    // P2 swings (skip in dummy/solo)
    if (mode === 'duel') {
      const r2 = a2(p2, p1);
      const o2 = printAttackResult(p2, p1, r2);
      lines.push(o2.lines);
      const p1HpBefore = p1.hp;
      p1.hp = Math.max(0, p1.hp - o2.total);
      lines.push(`    ${p1._spec} HP: ${p1HpBefore} → ${p1.hp}`);
      if (p1.hp <= 0) { winner = 'P2'; break; }
    }
    lines.push('');
  }

  lines.push('');
  if (winner) {
    lines.push(`═══ ${winner === 'P1' ? p1._spec : p2._spec} wins on turn ${turn} ═══`);
  } else {
    lines.push(`═══ Stalemate after ${turns} turns. P1 HP ${p1.hp}/${p1.maxHP}, P2 HP ${p2.hp}/${p2.maxHP} ═══`);
  }
  return lines.join('\n');
}

// ─── Help ───────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
ff3mmo battle-sim — terminal combat simulator

USAGE
  node tools/battle-sim.js [options]

OPTIONS
  --p1=<spec>            P1 profile, e.g. RM7  (default: RM7)
  --p2=<spec>            P2 profile, e.g. BM4  (default: BM4)
  --p1.weaponR=0xNN      P1 right-hand weapon item ID (overrides loc default)
  --p1.weaponL=0xNN      P1 left-hand weapon (enables dual-wield)
  --p1.armorId=0xNN      P1 body armor   (default 0x73 — leather, def 2)
  --p1.helmId=0xNN       P1 helm         (default 0x62 — cap, def 1)
  --p1.shieldId=0xNN     P1 shield       (no default)
  --p2.* same as p1.*
  --p1.path=<auto|player-single|player-dual|pvp>
                         Force which attack call shape P1 uses.
                         "auto" picks dual if both hands armed, else single.
  --mode=<duel|dummy>    duel = both swing; dummy = only P1 swings (default duel)
  --turns=<N>            Max turns (default 30)
  --seed=<N>             Deterministic RNG via mulberry32 (default 1)
  --help                 Print this help

JOB PREFIXES
  OK FI MO WM BM RM RA KN TH SC GE DR VI BB MK CO BA SU DE MG SA NI

EXAMPLES
  # The L7 RM dual-dagger anomaly — observe per-hand atk going negative:
  node tools/battle-sim.js --p1=RM7 --p1.weaponR=0x1F --p1.weaponL=0x1F \\
                           --p2=BM4 --mode=dummy --turns=3 --seed=1

  # Same matchup, force PVP path to see the difference:
  node tools/battle-sim.js --p1=RM7 --p1.weaponR=0x1F --p1.weaponL=0x1F \\
                           --p2=BM4 --p1.path=pvp --mode=dummy --turns=3 --seed=1
`);
}

// ─── Entry ──────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const seed = args.seed != null ? args.seed : 1;
  Math.random = seedRandom(seed);

  const p1Spec = args.p1 || 'RM7';
  const p2Spec = args.p2 || 'BM4';

  let p1, p2;
  try {
    p1 = resolveProfile(p1Spec, args.p1Over);
    p2 = resolveProfile(p2Spec, args.p2Over);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  console.log(`═══ ff3mmo battle-sim  seed=${seed}  mode=${args.mode || 'duel'} ═══`);
  console.log('');
  const out = runBattle(p1, p2, {
    mode: args.mode || 'duel',
    turns: args.turns || 30,
    p1Path: args.p1Over.path || 'auto',
    p2Path: args.p2Over.path || 'auto',
  });
  console.log(out);
}

main();
