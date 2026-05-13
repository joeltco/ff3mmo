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
import { SPELLS } from '../src/data/spells.js';
import { MONSTERS } from '../src/data/monsters.js';
import {
  STATUS, STATUS_NAMES, addStatus, removeStatus, hasStatus, createStatusState,
  tryInflictStatus, processTurnStart, blindHitPenalty, miniToadAtkMult,
  canCastMagic, wakeOnHit,
} from '../src/status-effects.js';
import { applyBuff, hasBuff, BUFF_HASTE, BUFF_PROTECT } from '../src/buffs.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const out = { p1Over: {}, p2Over: {}, pOver: {} };
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [rawKey, ...rest] = a.slice(2).split('=');
    const val = rest.join('=');
    if (rawKey === 'help' || rawKey === 'h') { out.help = true; continue; }
    // Generalized --pN.<key>=<value> for parties up to N members.
    const pMatch = rawKey.match(/^p(\d+)\.(.+)$/);
    if (pMatch) {
      const n = parseInt(pMatch[1], 10);
      const subkey = pMatch[2];
      const v = parseVal(val);
      if (!out.pOver[n]) out.pOver[n] = {};
      out.pOver[n][subkey] = v;
      // Backward-compat aliases for the 1v1 code path.
      if (n === 1) out.p1Over[subkey] = v;
      if (n === 2) out.p2Over[subkey] = v;
      continue;
    }
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
  if (p.kind === 'monster') {
    const tags = [];
    if (p.boss) tags.push('BOSS');
    if (p.atkElem) tags.push(`elem:${Array.isArray(p.atkElem) ? p.atkElem.join('/') : p.atkElem}`);
    if (p.weakness) tags.push(`weak:${Array.isArray(p.weakness) ? p.weakness.join('/') : p.weakness}`);
    if (p.resist) tags.push(`resist:${Array.isArray(p.resist) ? p.resist.join('/') : p.resist}`);
    if (p.spAtkRate) tags.push(`spAtk:${p.spAtkRate}%`);
    return [
      `${label}: ${p._spec}  L${p.level}  HP ${p.hp}/${p.maxHP}  ATK ${p.atk}×${p.attackRoll}  DEF ${p.def}  AGI ${p.agi}  mdef ${p.mdef}  hitRate ${p.hitRate}` +
        (tags.length ? `  [${tags.join(' ')}]` : ''),
    ].join('\n');
  }
  const job = JOBS[p.jobIdx]?.name || `job#${p.jobIdx}`;
  const r = ITEMS.get(p.weaponR);
  const l = p.weaponL != null ? ITEMS.get(p.weaponL) : null;
  const wpnStr = `R: ${itemStr(p.weaponR, r)}   L: ${itemStr(p.weaponL, l)}`;
  return [
    `${label}: ${p._spec}  ${job} L${p.level}  HP ${p.hp}  ATK ${p.atk}  DEF ${p.def}  AGI ${p.agi}  INT ${p.int} MND ${p.mnd} mdef ${p.mdef||0}  hitRate ${p.hitRate}`,
    `    ${wpnStr}   evade ${p.evade}   shieldEvade ${p.shieldEvade}${describeStatusBuffs(p)}`,
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
  const blindMult = att.status ? blindHitPenalty(att.status) : 1;
  const atkMult   = att.status ? miniToadAtkMult(att.status) : 1;
  const hasted    = !!hasBuff(att, BUFF_HASTE);
  const protected_ = !!hasBuff(def, BUFF_PROTECT);
  const hits = calcPotentialHits(att.level, att.agi, false, hasted);
  const effAtk = Math.floor(att.atk * atkMult);
  const effHit = att.hitRate * blindMult;
  const results = rollHits(effAtk, def.def, effHit, hits, {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    elemMult,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: protected_,
  });
  if (def.status && hasStatus(def.status, STATUS.SLEEP)) wakeOnHit(def.status);
  return { path: 'player-single', atkUsed: effAtk, hitsRolled: hits, results, hasted, protectedTarget: protected_ };
}

function attackPlayerDualWield(att, def, opts = {}) {
  const job = JOBS[att.jobIdx] || {};
  const rWpn = ITEMS.get(att.weaponR);
  const lWpn = att.weaponL != null ? ITEMS.get(att.weaponL) : null;
  const rWpnAtk = (rWpn?.atk) || 0;
  const lWpnAtk = (lWpn?.atk) || 0;
  const rArmed = isWeapon(att.weaponR);
  const lArmed = att.weaponL != null && isWeapon(att.weaponL);
  // Strip the MAX of weapon ATKs (matches calcAttackerAtk's wpnAtk =
  // max(r, l) — v1.7.321). Single-wield: one ATK is 0, so max == equipped.
  const wpnAtkComponent = Math.max(rWpnAtk, lWpnAtk);
  const blindMult = att.status ? blindHitPenalty(att.status) : 1;
  const atkMult   = att.status ? miniToadAtkMult(att.status) : 1;
  const hasted    = !!hasBuff(att, BUFF_HASTE);
  const protected_ = !!hasBuff(def, BUFF_PROTECT);
  const baseAtk = (att.atk - wpnAtkComponent) * atkMult;
  const hitsPerHand = calcPotentialHits(att.level, att.agi, false, hasted);
  const critOpts = {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: protected_,
  };
  function rollHand(wpn) {
    const handAtk = baseAtk + (wpn ? (wpn.atk || 0) : 0);
    const handHit = (wpn ? (wpn.hit || 80) : 80) * blindMult;
    return {
      atk: handAtk,
      hit: handHit,
      results: rollHits(handAtk, def.def, handHit, hitsPerHand, critOpts),
    };
  }
  const r = rollHand(rWpn);
  const l = rollHand(lWpn);
  if (def.status && hasStatus(def.status, STATUS.SLEEP)) wakeOnHit(def.status);
  return {
    path: 'player-dual',
    baseAtk,
    rHand: r,
    lHand: l,
    hitsRolled: hitsPerHand * 2,
    results: [...r.results, ...l.results],
    hasted,
    protectedTarget: protected_,
  };
}

function attackPVP(att, def, opts = {}) {
  const job = JOBS[att.jobIdx] || {};
  const rArmed = isWeapon(att.weaponR);
  const lArmed = att.weaponL != null && isWeapon(att.weaponL);
  const isUnarmed = !rArmed && !lArmed;
  const dualWield = (rArmed && lArmed) || isUnarmed;
  const blindMult = att.status ? blindHitPenalty(att.status) : 1;
  const atkMult   = att.status ? miniToadAtkMult(att.status) : 1;
  const hasted    = !!hasBuff(att, BUFF_HASTE);
  const protected_ = !!hasBuff(def, BUFF_PROTECT);
  const hits = calcPotentialHits(att.level, att.agi, dualWield, hasted);
  const effAtk = Math.floor(att.atk * atkMult);
  const effHit = att.hitRate * blindMult;
  const results = rollHits(effAtk, def.def, effHit, hits, {
    critPct: job.critPct || 0,
    critBonus: job.critBonus || 0,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: protected_,
  });
  if (def.status && hasStatus(def.status, STATUS.SLEEP)) wakeOnHit(def.status);
  return { path: 'pvp', atkUsed: effAtk, hitsRolled: hits, dualWield, results, hasted, protectedTarget: protected_ };
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

// ════════════════════════════════════════════════════════════════════════
// Phase 2 — spells, status, buffs
// ════════════════════════════════════════════════════════════════════════

// ─── Spell name → ID (lowercase) ────────────────────────────────────────
// Subset covering common starter / mid-game spells. Extend as needed.
const SPELL_BY_NAME = {
  // Black magic — damage
  fire:    0x31, fira:   0x23, firaga:  0x0e,
  bzzard:  0x32, bzzara: 0x24, bzzaga:  0x1d,
  thunder: 0x2a, tara:   0x25, taga:    0x15,
  spark:   0x29, heatra: 0x22, icen:    0x30,
  bio:     0x0f, holy:   0x05, flare:   0x00, meteor: 0x02,
  // Black magic — status
  poison:  0x2b, blind:  0x2c, sleep:   0x33,
  silence: 0x21, confuse:0x20, break:   0x1c, breakga:0x08,
  death:   0x01, raze:   0x16, toad:    0x2e, mini:   0x2f,
  // White magic — heal
  cure:    0x34, cura:   0x26, curaga:  0x18, curaja: 0x0a,
  // White magic — cure-status
  poisona: 0x35, bndna:  0x28, esuna:   0x0b,
  // Buffs
  haste:   0x13, protect:0x1a, reflect: 0x0c,
  // Drain / utility
  drain:   0x09, libra:  0x1f, erase:   0x17,
};

function resolveSpell(name) {
  if (typeof name === 'number') return { id: name, spell: SPELLS.get(name) };
  if (/^0x[0-9a-fA-F]+$/.test(name)) {
    const id = parseInt(name, 16);
    return { id, spell: SPELLS.get(id) };
  }
  const id = SPELL_BY_NAME[name.toLowerCase()];
  if (id == null) throw new Error(`Unknown spell "${name}". Known: ${Object.keys(SPELL_BY_NAME).join(', ')}`);
  return { id, spell: SPELLS.get(id) };
}

function spellName(id) {
  for (const [n, sid] of Object.entries(SPELL_BY_NAME)) if (sid === id) return n;
  return `0x${id.toString(16).padStart(2, '0')}`;
}

// ─── Magic damage / heal math (port of combatant-cast.js + spell-cast.js) ───
//
// NES FF3 magic formula (31/B1B4): atk = floor(stat/2) + power, +rand(0..atk/2).
// White magic (heal / cure_status / revive) uses caster MND; black magic (damage)
// uses INT. Pulled directly from spell-cast.js:_rollMagicAmount + pvp.js:606.

function simRollMagicAmount(caster, power, useMnd) {
  const stat = useMnd ? (caster.mnd || 5) : (caster.int || 5);
  const baseAtk = Math.floor(stat / 2) + power;
  return baseAtk + Math.floor(Math.random() * (Math.floor(baseAtk / 2) + 1));
}

function spellUsesMnd(spell) {
  // spell-cast.js:261 / 396 / 517 — all three roles use the same predicate.
  return spell.element === 'recovery'
      || spell.target === 'cure_status'
      || spell.target === 'revive';
}

// applyMagicDamage from combatant-cast.js:225 — port without SFX/render hooks.
function simApplyMagicDamage(target, baseDmg, spell) {
  if (!target || target.hp <= 0) return 0;
  const eMult = elemMultiplier(spell.element, target.weakness, target.resist);
  const mdef = target.mdef || 0;
  const dmg = Math.max(1, Math.floor(baseDmg * eMult) - mdef);
  target.hp = Math.max(0, target.hp - dmg);
  return { dmg, eMult, mdef };
}

// applyMagicHeal from combatant-cast.js:241.
function simApplyMagicHeal(target, amount) {
  if (!target) return 0;
  const maxHP = target.maxHP || target.hp || 0;
  const realHeal = Math.min(amount, maxHP - (target.hp || 0));
  target.hp = (target.hp || 0) + realHeal;
  return realHeal;
}

// applyMagicCureStatus from combatant-cast.js:253.
function simApplyMagicCureStatus(target, statusFlag) {
  if (!target || !target.status) return false;
  const wasSet = !!(target.status.mask & statusFlag);
  removeStatus(target.status, statusFlag);
  return wasSet;
}

// applyMagicStatus from combatant-cast.js:354.
function simApplyMagicStatus(target, statusName, hitChance) {
  if (!target || !target.status) return 0;
  const resist = target.statusResist || 0;
  return tryInflictStatus(target.status, statusName, hitChance, resist);
}

// applyMagicInstakill from combatant-cast.js:331.
function simApplyMagicInstakill(target, hitChance) {
  if (!target || target.hp <= 0) return false;
  if (Math.random() * 100 < hitChance) {
    if (target.status) addStatus(target.status, STATUS.DEATH);
    target.hp = 0;
    return true;
  }
  return false;
}

// Map cure-status spell IDs to the flag they cure.
const CURE_STATUS_FLAG = {
  0x35: STATUS.POISON,    // Poisona
  0x28: STATUS.BLIND,     // Bndna
  0x0b: 0xFFFF,           // Esuna — clears all major debuffs (mask)
};

// Mirror of combatant-cast.js:applySpell — the dispatcher.
// Returns a structured result for pretty-printing.
function simApplySpell(caster, target, spell, spellId) {
  const useMnd = spellUsesMnd(spell);
  const out = { spellId, spellName: spellName(spellId), spell, useMnd };

  // Status spell on enemy (Sleep, Poison, Blind, etc.)
  if (spell.target === 'enemy_status') {
    if (spell.type === 'death') {
      out.kind = 'instakill';
      out.killed = simApplyMagicInstakill(target, spell.hit);
      return out;
    }
    out.kind = 'status';
    out.applied = simApplyMagicStatus(target, spell.type, spell.hit);
    return out;
  }

  // Status spell on enemy (Poison spell type='poison' target='enemy', Blind type='blind' target='enemy_status')
  // Some status spells like Poison (0x2b) have target='enemy' but type='poison'. Handle those here.
  if (['poison', 'blind', 'sleep', 'paralysis', 'silence', 'mini', 'toad', 'confuse'].includes(spell.type)
      && spell.target === 'enemy') {
    out.kind = 'status';
    out.applied = simApplyMagicStatus(target, spell.type, spell.hit);
    return out;
  }

  // Cure-status (Poisona, Bndna, Esuna) — strips a status from a friendly.
  if (spell.target === 'cure_status') {
    const flag = CURE_STATUS_FLAG[spellId] || 0;
    out.kind = 'cure_status';
    out.flag = flag;
    out.amountRolled = simRollMagicAmount(caster, spell.power || 0, useMnd);
    out.cured = simApplyMagicCureStatus(target, flag);
    return out;
  }

  // Recovery — heal non-undead, damage undead.
  if (spell.element === 'recovery' && spell.target === 'ally') {
    out.kind = 'heal';
    out.amountRolled = simRollMagicAmount(caster, spell.power, true);
    out.healed = simApplyMagicHeal(target, out.amountRolled);
    return out;
  }

  // Buff cast (Haste, Protect) — power=5/hit=75 etc; we just apply unconditionally for now.
  if (spell.target === 'haste') {
    out.kind = 'buff';
    out.buff = 'haste';
    applyBuff(target || caster, BUFF_HASTE);
    return out;
  }
  if (spell.target === 'protect') {
    out.kind = 'buff';
    out.buff = 'protect';
    applyBuff(target || caster, BUFF_PROTECT);
    return out;
  }

  // Default: damage spell (Fire / Bzzard / Bolt / etc).
  out.kind = 'damage';
  out.amountRolled = simRollMagicAmount(caster, spell.power, useMnd);
  const r = simApplyMagicDamage(target, out.amountRolled, spell);
  if (typeof r === 'object') Object.assign(out, r);
  else out.dmg = r;
  return out;
}

function describeSpellResult(caster, target, r) {
  const lines = [];
  lines.push(`  ${caster._spec} casts ${r.spellName} on ${target ? target._spec : 'self'}  [${r.kind}]`);
  if (r.kind === 'damage') {
    lines.push(`    rolled baseDmg = floor(${r.useMnd ? 'mnd' : 'int'}/2) + power(${r.spell.power}) + rand → ${r.amountRolled}`);
    lines.push(`    elemMult=${r.eMult}  mdef=${r.mdef}  →  dmg=${r.dmg}`);
  } else if (r.kind === 'heal') {
    lines.push(`    rolled = floor(mnd/2) + power(${r.spell.power}) + rand → ${r.amountRolled}  →  healed ${r.healed}`);
  } else if (r.kind === 'status') {
    lines.push(`    type=${r.spell.type} hit=${r.spell.hit}%  →  ${r.applied ? `LANDED (${STATUS_NAMES[r.applied] || r.applied})` : 'resisted/missed'}`);
  } else if (r.kind === 'cure_status') {
    lines.push(`    flag=${r.flag.toString(16)}  →  ${r.cured ? 'cured' : 'no effect'}`);
  } else if (r.kind === 'instakill') {
    lines.push(`    hit=${r.spell.hit}%  →  ${r.killed ? 'KILLED' : 'resisted'}`);
  } else if (r.kind === 'buff') {
    lines.push(`    applied ${r.buff} to ${target ? target._spec : caster._spec}`);
  }
  return lines.join('\n');
}

// ─── Actions ────────────────────────────────────────────────────────────
// Action spec: 'attack' | 'defend' | 'cast:<spellName>' | 'cast:0xNN'

function parseAction(actStr) {
  if (!actStr || actStr === 'attack') return { kind: 'attack' };
  if (actStr === 'defend') return { kind: 'defend' };
  if (actStr.startsWith('cast:')) {
    const { id, spell } = resolveSpell(actStr.slice(5));
    if (!spell) throw new Error(`Spell ${actStr.slice(5)} not found in SPELLS map`);
    return { kind: 'cast', spellId: id, spell };
  }
  throw new Error(`Bad action "${actStr}". Use attack | defend | cast:<spell>`);
}

// ─── Status / buff CLI helpers ──────────────────────────────────────────
function applyStartingStatus(combatant, csv) {
  if (!csv) return;
  for (const name of String(csv).split(',').map(s => s.trim()).filter(Boolean)) {
    const flag = STATUS[name.toUpperCase()];
    if (flag == null) throw new Error(`Unknown status "${name}". Known: ${Object.keys(STATUS).join(', ')}`);
    addStatus(combatant.status, flag);
  }
}

function applyStartingBuffs(combatant, csv) {
  if (!csv) return;
  for (const name of String(csv).split(',').map(s => s.trim()).filter(Boolean)) {
    applyBuff(combatant, name);
  }
}

function describeStatusBuffs(p) {
  const parts = [];
  if (p.status && p.status.mask) {
    const flags = [];
    for (const [n, f] of Object.entries(STATUS)) if (p.status.mask & f) flags.push(n.toLowerCase());
    if (flags.length) parts.push(`status: ${flags.join(',')}`);
  }
  if (p.buffs) {
    const bs = Object.keys(p.buffs).filter(k => p.buffs[k]);
    if (bs.length) parts.push(`buffs: ${bs.join(',')}`);
  }
  return parts.length ? `   [${parts.join('  ')}]` : '';
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
//
// Per-turn flow per actor:
//   1. processTurnStart → poison tick + sleep/paralysis act-skip
//   2. If canAct: execute action (attack | defend | cast)
//   3. Apply damage to opponent / heal-self / status to target

function applyAction(actor, target, attackFn, action, opts = {}) {
  // Returns { lines: string[], dmgDealt, healed, hpBefore, hpAfter, killedTarget }
  const lines = [];

  if (action.kind === 'defend') {
    actor._defendsNextSwing = true;
    lines.push(`  ${actor._spec} defends.`);
    return { lines, dmgDealt: 0, healed: 0, killedTarget: false };
  }

  if (action.kind === 'spAttack') {
    return executeSpecialAttack(actor, target, action);
  }

  if (action.kind === 'cast') {
    if (!canCastMagic(actor.status)) {
      lines.push(`  ${actor._spec} tries to cast ${spellName(action.spellId)} — SILENCED, fizzles.`);
      return { lines, dmgDealt: 0, healed: 0, killedTarget: false };
    }
    // Cure family targets a friendly. In dummy/PvP-flavoured sim mode `target`
    // is always the opponent, so route heals to self instead.
    const isHealOrBuff = action.spell.element === 'recovery'
      || action.spell.target === 'cure_status'
      || action.spell.target === 'haste'
      || action.spell.target === 'protect';
    const spellTarget = isHealOrBuff ? actor : target;
    const tgtHpBefore = spellTarget ? spellTarget.hp : 0;
    const r = simApplySpell(actor, spellTarget, action.spell, action.spellId);
    lines.push(describeSpellResult(actor, spellTarget, r));
    const dmg = r.dmg || 0;
    const healed = r.healed || 0;
    if (spellTarget && (dmg > 0 || healed > 0)) {
      lines.push(`    ${spellTarget._spec} HP: ${tgtHpBefore} → ${spellTarget.hp}`);
    }
    return {
      lines,
      dmgDealt: dmg,
      healed,
      killedTarget: spellTarget && spellTarget.hp <= 0 && dmg > 0,
    };
  }

  // Default: attack. Consume target's "defend next swing" flag if set.
  const targetDefending = !!target._defendsNextSwing;
  if (targetDefending) target._defendsNextSwing = false;
  const ar = attackFn(actor, target, { ...opts, targetDefending });
  const o = printAttackResult(actor, target, ar);
  lines.push(o.lines);
  const hpBefore = target.hp;
  target.hp = Math.max(0, target.hp - o.total);
  const halvedTag = targetDefending ? '  (halved by defend)' : '';
  lines.push(`    ${target._spec} HP: ${hpBefore} → ${target.hp}${halvedTag}`);
  return { lines, dmgDealt: o.total, healed: 0, killedTarget: target.hp <= 0 };
}

function processStartOfTurn(actor) {
  if (!actor.status) return { canAct: true, lines: [] };
  const lines = [];
  const { canAct, poisonDmg } = processTurnStart(actor.status, actor.maxHP);
  if (poisonDmg > 0) {
    const before = actor.hp;
    actor.hp = Math.max(0, actor.hp - poisonDmg);
    lines.push(`  ${actor._spec} takes ${poisonDmg} poison damage  (HP ${before} → ${actor.hp})`);
  }
  if (!canAct) {
    if (hasStatus(actor.status, STATUS.SLEEP))      lines.push(`  ${actor._spec} is asleep — skips turn.`);
    else if (hasStatus(actor.status, STATUS.PARALYSIS)) lines.push(`  ${actor._spec} is paralyzed — skips turn.`);
    else                                                 lines.push(`  ${actor._spec} cannot act.`);
  }
  return { canAct, lines };
}

function runBattle(p1, p2, opts) {
  const { mode = 'duel', turns = 30, p1Path = 'auto', p2Path = 'auto', p1Action = { kind: 'attack' }, p2Action = { kind: 'attack' } } = opts;
  const a1 = selectAttack(p1, p1Path);
  const a2 = selectAttack(p2, p2Path);
  const lines = [];
  let dmgP1to2 = 0, dmgP2to1 = 0;
  lines.push(describeProfile(p1, 'P1'));
  lines.push(describeProfile(p2, 'P2'));
  lines.push('');

  let turn = 0;
  let winner = null;
  while (turn < turns) {
    turn++;
    lines.push(`─── Turn ${turn} ───`);

    // Per-turn initiative roll — matches live game's battle-turn.js:buildTurnOrder.
    // Priority = agi*2 + rand(0..255). Random component dominates AGI gap so
    // equal-AGI combatants split ~50/50 over many turns. In dummy/solo modes
    // P1 always acts (P2 doesn't act regardless of priority).
    const p1Pri = (p1.agi || 0) * 2 + Math.floor(Math.random() * 256);
    const p2Pri = (p2.agi || 0) * 2 + Math.floor(Math.random() * 256);
    const p1First = p1Pri >= p2Pri;

    function p1Act() {
      const sot = processStartOfTurn(p1);
      sot.lines.forEach(l => lines.push(l));
      if (p1.hp <= 0) { winner = 'P2'; return false; }
      if (sot.canAct) {
        const res = applyAction(p1, p2, a1, p1Action);
        res.lines.forEach(l => lines.push(l));
        dmgP1to2 += res.dmgDealt || 0;
        if (p2.hp <= 0) { winner = 'P1'; return false; }
      }
      return true;
    }
    function p2Act() {
      if (mode !== 'duel') return true; // dummy/solo: P2 doesn't act
      const sot = processStartOfTurn(p2);
      sot.lines.forEach(l => lines.push(l));
      if (p2.hp <= 0) { winner = 'P1'; return false; }
      if (sot.canAct) {
        const res = applyAction(p2, p1, a2, p2Action);
        res.lines.forEach(l => lines.push(l));
        dmgP2to1 += res.dmgDealt || 0;
        if (p1.hp <= 0) { winner = 'P2'; return false; }
      }
      return true;
    }

    if (p1First) {
      if (!p1Act()) break;
      if (!p2Act()) break;
    } else {
      if (!p2Act()) break;
      if (!p1Act()) break;
    }

    lines.push('');
  }

  lines.push('');
  if (winner) {
    lines.push(`═══ ${winner === 'P1' ? p1._spec : p2._spec} wins on turn ${turn} ═══`);
  } else {
    lines.push(`═══ Stalemate after ${turns} turns. P1 HP ${p1.hp}/${p1.maxHP}, P2 HP ${p2.hp}/${p2.maxHP} ═══`);
  }
  return {
    text: lines.join('\n'),
    winner,
    turns: turn,
    p1HP: p1.hp,  p1MaxHP: p1.maxHP,
    p2HP: p2.hp,  p2MaxHP: p2.maxHP,
    dmgP1to2, dmgP2to1,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Phase 3 — monsters, encounters, multi-target battles
// ════════════════════════════════════════════════════════════════════════

// ─── Monster name → ID (parsed from data/monsters.js comments) ──────────
//
// data/monsters.js has lines like `[0xCC, { ... }],   // Land Turtle`. The
// MONSTERS map exports stats but not names. Parse the trailing `// Name`
// comment once at startup so users can write `--enemies=goblin*3` instead
// of `--enemies=0x00*3`.
const MONSTER_BY_NAME = (() => {
  const map = new Map();
  try {
    const src = readFileSync(join(__dirname, '..', 'src', 'data', 'monsters.js'), 'utf8');
    const re = /^\s*\[(0x[0-9a-fA-F]+), \{.*\}\],\s*\/\/\s*(.+)$/gm;
    let m;
    while ((m = re.exec(src))) {
      const id = parseInt(m[1], 16);
      const name = m[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      map.set(name, id);
    }
  } catch (e) {
    console.warn(`[battle-sim] could not parse monsters.js for names: ${e.message}`);
  }
  return map;
})();

function resolveMonsterId(spec) {
  if (typeof spec === 'number') return spec;
  if (/^0x[0-9a-fA-F]+$/.test(spec)) return parseInt(spec, 16);
  const id = MONSTER_BY_NAME.get(spec.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  if (id == null) throw new Error(`Unknown monster "${spec}". Try a hex ID or lowercase snake_case (e.g. "land_turtle", "killer_bee").`);
  return id;
}

// ─── Monster combatant builder ──────────────────────────────────────────
//
// Mirrors the shape produced by `generateAllyStats` (so encounter rendering
// + applyAction don't need to special-case monster vs player) plus monster-
// specific fields used by `attackMonster` (attackRoll, atkElem, weakness,
// resist, statusAtk, spAtkRate, attacks).

function buildMonster(spec, idx = 0) {
  const id = resolveMonsterId(spec);
  const m = MONSTERS.get(id);
  if (!m) throw new Error(`Monster ID 0x${id.toString(16)} not in MONSTERS map`);
  // Default name: parse comment from monsters.js to recover. Fall back to hex.
  let name = `0x${id.toString(16)}`;
  for (const [n, mid] of MONSTER_BY_NAME) if (mid === id) { name = n; break; }
  return {
    kind: 'monster',
    team: 'enemy',
    _spec: idx > 0 ? `${name}#${idx}` : name,
    name,
    monsterId: id,
    level: m.level || 1,
    hp: m.hp,
    maxHP: m.hp,
    atk: m.atk || 5,
    def: m.def || 0,
    agi: m.agi || 5,
    int: m.spiritInt || 5,
    mnd: m.spiritInt || 5,
    hitRate: m.hitRate || 70,
    evade: m.evade || 0,
    shieldEvade: 0,
    mdef: m.mdef || 0,
    attackRoll: m.attackRoll || 1,
    atkElem: m.atkElem || null,
    weakness: m.weakness || null,
    resist: m.resist || null,
    statusAtk: m.statusAtk || null,
    statusResist: m.statusResist || 0,
    spAtkRate: m.spAtkRate || 0,
    attacks: m.attacks || null,
    boss: !!m.boss,
    weaponR: 0, weaponL: null, jobIdx: -1,
    status: createStatusState(),
    buffs: {},
  };
}

// ─── Monster special-attack table (port of battle-enemy.js:27 SPECIAL_ATTACKS) ──
const SPECIAL_ATTACKS = {
  'Fire':       { type: 'damage', power: 25,  hit: 100, element: 'fire' },
  'Fira':       { type: 'damage', power: 55,  hit: 100, element: 'fire' },
  'Firaga':     { type: 'damage', power: 150, hit: 100, element: 'fire' },
  'Bzzard':     { type: 'damage', power: 25,  hit: 100, element: 'ice' },
  'Bzzara':     { type: 'damage', power: 55,  hit: 100, element: 'ice' },
  'Bzzaga':     { type: 'damage', power: 85,  hit: 100, element: 'ice' },
  'Thunder':    { type: 'damage', power: 35,  hit: 100, element: 'bolt' },
  'Thundara':   { type: 'damage', power: 55,  hit: 100, element: 'bolt' },
  'Thundaga':   { type: 'damage', power: 110, hit: 100, element: 'bolt' },
  'Tornado':    { type: 'damage', power: 4,   hit: 40,  element: 'air' },
  'Aeroga':     { type: 'damage', power: 115, hit: 100, element: null },
  'Quake':      { type: 'damage', power: 133, hit: 100, element: 'earth' },
  'Holy':       { type: 'damage', power: 160, hit: 100, element: 'holy' },
  'Flare':      { type: 'damage', power: 200, hit: 100, element: null },
  'Meteor':     { type: 'damage', power: 180, hit: 100, element: null },
  'Bio':        { type: 'damage', power: 130, hit: 100, element: null },
  'Drain':      { type: 'damage', power: 160, hit: 100, element: null },
  'Blind':      { type: 'status', hit: 60,  status: 'blind' },
  'Poison':     { type: 'status', hit: 60,  status: 'poison' },
  'Glare':      { type: 'status', hit: 80,  status: 'paralysis' },
  'Sleep':      { type: 'status', hit: 15,  status: 'sleep' },
  'Confuse':    { type: 'status', hit: 25,  status: 'confuse' },
  'Toad':       { type: 'status', hit: 80,  status: 'toad' },
  'Mini':       { type: 'status', hit: 80,  status: 'mini' },
  'Silence':    { type: 'status', hit: 60,  status: 'silence' },
  'Bad Breath': { type: 'multi_status', hit: 60, statuses: ['poison', 'blind', 'silence', 'toad', 'mini'] },
  'Reflect':    { type: 'none' },
  'Sence':      { type: 'none' },
};

// Roll spAtkRate% for a monster's special attack. Returns either an
// `{ kind: 'attack' }` (use physical attack) or `{ kind: 'spAttack', ... }` action.
function pickMonsterAction(mon) {
  if (!mon.attacks || !mon.spAtkRate || mon.spAtkRate <= 0) return { kind: 'attack' };
  if (Math.random() * 100 >= mon.spAtkRate) return { kind: 'attack' };
  const atkName = mon.attacks[Math.floor(Math.random() * mon.attacks.length)];
  const spec = SPECIAL_ATTACKS[atkName];
  if (!spec || spec.type === 'none') return { kind: 'attack' };
  return { kind: 'spAttack', name: atkName, spec };
}

// Execute a monster's special attack (port of battle-enemy.js:_doSpecialAttack).
function executeSpecialAttack(mon, target, action) {
  const { spec, name } = action;
  const lines = [];
  if (spec.type === 'damage') {
    const eMult = elemMultiplier(spec.element, target.weakness, target.resist);
    const castStat = mon.int || mon.mnd || 5;
    const baseAtk = Math.floor(castStat / 2) + spec.power;
    const roll = baseAtk + Math.floor(Math.random() * (Math.floor(baseAtk / 2) + 1));
    let dmg = Math.max(1, Math.floor(roll * eMult) - (target.mdef || 0));
    const targetDefending = !!target._defendsNextSwing;
    if (targetDefending) { target._defendsNextSwing = false; dmg = Math.max(1, Math.floor(dmg / 2)); }
    const hpBefore = target.hp;
    target.hp = Math.max(0, target.hp - dmg);
    lines.push(`  ${mon._spec} uses ${name} on ${target._spec}  [special: damage]`);
    lines.push(`    rolled = floor(int/2) + ${spec.power} + rand → ${roll}  elemMult=${eMult}  mdef=${target.mdef||0}  →  dmg=${dmg}${targetDefending ? '  (halved by defend)' : ''}`);
    lines.push(`    ${target._spec} HP: ${hpBefore} → ${target.hp}`);
    return { lines, dmgDealt: dmg, healed: 0, killedTarget: target.hp <= 0 };
  }
  if (spec.type === 'status') {
    const applied = simApplyMagicStatus(target, spec.status, spec.hit);
    lines.push(`  ${mon._spec} uses ${name} on ${target._spec}  [special: status]`);
    lines.push(`    type=${spec.status} hit=${spec.hit}%  →  ${applied ? `LANDED (${STATUS_NAMES[applied]})` : 'resisted/missed'}`);
    return { lines, dmgDealt: 0, healed: 0, killedTarget: false };
  }
  if (spec.type === 'multi_status') {
    const landed = [];
    for (const s of spec.statuses) {
      const f = simApplyMagicStatus(target, s, spec.hit);
      if (f) landed.push(STATUS_NAMES[f] || s);
    }
    lines.push(`  ${mon._spec} uses ${name} on ${target._spec}  [special: multi-status]`);
    lines.push(`    hit=${spec.hit}% per flag  →  ${landed.length ? `LANDED ${landed.join(', ')}` : 'all missed'}`);
    return { lines, dmgDealt: 0, healed: 0, killedTarget: false };
  }
  lines.push(`  ${mon._spec} uses ${name}  [no effect]`);
  return { lines, dmgDealt: 0, healed: 0, killedTarget: false };
}

// ─── Monster attack call shape (battle-enemy.js:189 rollMultiHit) ───────
function attackMonster(att, def, opts = {}) {
  const blindMult = att.status ? blindHitPenalty(att.status) : 1;
  const protected_ = !!hasBuff(def, BUFF_PROTECT);
  const rolls = att.attackRoll || 1;
  const eMult = elemMultiplier(att.atkElem, def.weakness, def.resist);
  const effHit = (att.hitRate || 70) * blindMult;
  const results = rollHits(att.atk, def.def, effHit, rolls, {
    elemMult: eMult,
    evade: def.evade || 0,
    shieldEvade: def.shieldEvade || 0,
    defendHalve: !!opts.targetDefending,
    targetProtected: protected_,
    // No crit for monsters (NES canon — only player/ally weapons crit).
  });
  if (def.status && hasStatus(def.status, STATUS.SLEEP)) wakeOnHit(def.status);
  return { path: 'monster', atkUsed: att.atk, hitsRolled: rolls, results, protectedTarget: protected_ };
}

// Pick the right attack fn for any combatant.
function attackFnFor(c, override) {
  if (c.kind === 'monster') return attackMonster;
  return selectAttack(c, override);
}

// ─── Party / enemy CLI parsers ──────────────────────────────────────────
//
// --party=RM7,BM4,WM4              → 3 player-team combatants
// --enemies=goblin*3,killer_bee*2  → multi-instance monster array
// --enemies=land_turtle            → boss fight (1 monster)

function parseParty(spec, pOver = {}) {
  if (spec == null) return null;
  const specs = String(spec).split(',').map(s => s.trim()).filter(Boolean);
  return specs.map((s, i) => {
    const overrides = pOver[i + 1] || {};
    const c = resolveProfile(s, overrides);
    if (overrides.status) applyStartingStatus(c, overrides.status);
    if (overrides.buff)   applyStartingBuffs(c, overrides.buff);
    if (overrides.hp != null) c.hp = overrides.hp;
    if (overrides.action) c._action = parseAction(overrides.action);
    c.team = 'player';
    c.kind = i === 0 ? 'player' : 'ally';
    c.buffs = c.buffs || {};
    return c;
  });
}

function parseEnemies(spec) {
  if (spec == null) return null;
  // Numeric spec (parseVal coerced --enemies=0xCC to 204) — single monster ID.
  if (typeof spec === 'number') return [buildMonster(spec)];
  const out = [];
  for (const part of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(.+?)(?:\*(\d+))?$/);
    const id = m[1];
    const n = parseInt(m[2] || '1', 10);
    for (let i = 0; i < n; i++) out.push(buildMonster(id, n > 1 ? i + 1 : 0));
  }
  return out;
}

// ─── Encounter loop ─────────────────────────────────────────────────────
//
// Multi-target battle: party (player + allies) vs enemies (monsters).
// Per turn:
//   1. Sort all alive combatants by AGI desc (NES canon — fastest acts first)
//   2. Each combatant: processStartOfTurn → action → hit random alive enemy
//   3. End when one team is fully KO'd (or --turns reached)

function runEncounter(party, enemies, opts = {}) {
  const { turns = 30, partyAction = { kind: 'attack' } } = opts;
  const lines = [];
  let dmgPartyToEnemy = 0, dmgEnemyToParty = 0;
  party.forEach((p, i) => lines.push(describeProfile(p, `P${i + 1}`)));
  enemies.forEach((e, i) => lines.push(describeProfile(e, `E${i + 1}`)));
  lines.push('');

  const alive = (c) => c.hp > 0 && !(c.status && hasStatus(c.status, STATUS.DEATH));
  const partyAlive   = () => party.filter(alive);
  const enemiesAlive = () => enemies.filter(alive);

  let turn = 0;
  let winner = null;
  while (turn < turns) {
    turn++;
    lines.push(`─── Turn ${turn} ───`);

    // AGI-ordered turn order with random initiative — matches live game's
    // battle-turn.js:buildTurnOrder. Priority = agi*2 + rand(0..255). Random
    // component dominates AGI*2 (a 20-AGI gap shifts mean by 40 vs random
    // spread of ±127), so equal-AGI combatants split ~50/50 over many turns.
    const order = [...party, ...enemies]
      .filter(alive)
      .map(c => ({ c, pri: (c.agi || 0) * 2 + Math.floor(Math.random() * 256) }))
      .sort((a, b) => b.pri - a.pri)
      .map(x => x.c);

    for (const actor of order) {
      if (!alive(actor)) continue; // KO'd mid-turn by another actor
      // Bail if either side wiped
      if (partyAlive().length === 0) { winner = 'enemies'; break; }
      if (enemiesAlive().length === 0) { winner = 'party'; break; }

      const sot = processStartOfTurn(actor);
      sot.lines.forEach(l => lines.push(l));
      if (!alive(actor)) continue;
      if (!sot.canAct) continue;

      // Pick a target on the opposite team — random alive
      const targets = actor.team === 'player' ? enemiesAlive() : partyAlive();
      if (targets.length === 0) break;
      const target = targets[Math.floor(Math.random() * targets.length)];

      // Per-actor action: party uses _action override → partyAction; monsters
      // roll spAtkRate per turn for special attacks (Glare, Fire, Bad Breath, etc.).
      const action = actor.team === 'player'
        ? (actor._action || partyAction)
        : pickMonsterAction(actor);
      const fn = attackFnFor(actor, opts[`${actor._spec}_path`] || 'auto');
      const res = applyAction(actor, target, fn, action);
      res.lines.forEach(l => lines.push(l));
      if (res.dmgDealt > 0) {
        if (actor.team === 'player') dmgPartyToEnemy += res.dmgDealt;
        else dmgEnemyToParty += res.dmgDealt;
      }
    }

    if (winner) break;
    if (partyAlive().length === 0) { winner = 'enemies'; break; }
    if (enemiesAlive().length === 0) { winner = 'party'; break; }
    lines.push('');
  }

  lines.push('');
  if (winner === 'party') {
    lines.push(`═══ Party wins on turn ${turn}. Survivors: ${partyAlive().map(p => `${p._spec}(${p.hp})`).join(', ')} ═══`);
  } else if (winner === 'enemies') {
    lines.push(`═══ Enemies win on turn ${turn}. Survivors: ${enemiesAlive().map(e => `${e._spec}(${e.hp})`).join(', ')} ═══`);
  } else {
    lines.push(`═══ Stalemate after ${turns} turns ═══`);
    lines.push(`    Party:   ${party.map(p => `${p._spec}(${p.hp}/${p.maxHP})`).join(', ')}`);
    lines.push(`    Enemies: ${enemies.map(e => `${e._spec}(${e.hp}/${e.maxHP})`).join(', ')}`);
  }
  return {
    text: lines.join('\n'),
    winner,
    turns: turn,
    partyAlive: partyAlive().length,
    enemyAlive: enemiesAlive().length,
    partyHP: party.map(p => p.hp),
    enemyHP: enemies.map(e => e.hp),
    dmgPartyToEnemy,
    dmgEnemyToParty,
  };
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
  --p1.action=<spec>     attack (default), defend, or cast:<spell>
                         e.g. --p1.action=cast:Fire   --p1.action=cast:Cure
  --p1.status=<csv>      Starting status flags (poison,sleep,blind,...)
  --p1.buff=<csv>        Starting buffs (haste,protect,reflect)
  --p2.* same as p1.*
  --mode=<duel|dummy>    duel = both swing; dummy = only P1 acts (default duel)
  --turns=<N>            Max turns (default 30)
  --seed=<N>             Deterministic RNG via mulberry32 (default 1)
  --runs=<N>             Statistical mode — run N times, print aggregated
                         win-rate / turn / damage stats (instead of per-turn)
  --json                 With --runs: output structured JSON
  --csv                  With --runs: output CSV (one row per run)
  --help                 Print this help

JOB PREFIXES
  OK FI MO WM BM RM RA KN TH SC GE DR VI BB MK CO BA SU DE MG SA NI

SPELL NAMES (case-insensitive)
  Damage:  fire fira firaga bzzard bzzara bzzaga thunder tara taga
           spark heatra icen bio holy flare meteor
  Status:  poison blind sleep silence confuse break breakga death
           raze toad mini
  Heal:    cure cura curaga curaja
  Cure:    poisona bndna esuna
  Buffs:   haste protect reflect
  Other:   drain libra erase

ENCOUNTER MODE
  --party=<csv>          Comma-separated profile shorthand (RM7,BM4,WM4)
  --enemies=<csv>        Monster shorthand with optional *N multiplier
                         e.g. --enemies=goblin*3,killer_bee
                              --enemies=land_turtle  (boss)
  --boss=<name>          Alias for --enemies=<name>
  Monster names are lowercase snake_case (e.g. goblin, killer_bee,
  land_turtle, blue_wisp, zombie). Hex IDs (--enemies=0x00*4) also work.

EXAMPLES
  # 1v1 duel (default — RM7 dual-dagger vs BM4)
  node tools/battle-sim.js

  # BM4 casts Fire on RM7 each turn (dummy mode = no retaliation)
  node tools/battle-sim.js --p1=BM4 --p1.action=cast:Fire \\
                           --p2=RM7 --mode=dummy --turns=3

  # Sleep an enemy then attack while it can't act
  node tools/battle-sim.js --p1=BM4 --p1.action=cast:Sleep --p2=KN5 \\
                           --mode=dummy --turns=4

  # Hasted RM vs Protected KN — buff stack effects
  node tools/battle-sim.js --p1=RM7 --p1.buff=haste --p1.weaponR=0x1F --p1.weaponL=0x1F \\
                           --p2=KN10 --p2.buff=protect --turns=5

  # Encounter — solo player vs 3 goblins
  node tools/battle-sim.js --party=KN5 --enemies=goblin*3

  # Boss fight — Land Turtle (altar cave boss)
  node tools/battle-sim.js --party=KN10,WM4 --boss=land_turtle --turns=15

  # Mid-game encounter — 3-player party vs zombie horde
  node tools/battle-sim.js --party=KN10,WM4,BM4 --enemies=zombie*4 --turns=10
`);
}

// ════════════════════════════════════════════════════════════════════════
// Phase 4 — Statistical mode (--runs=N)
// ════════════════════════════════════════════════════════════════════════
//
// For balance analysis: run the same matchup N times under different
// seeds, aggregate results. Suppresses per-turn output. Output formats:
// human-readable (default), --json, --csv.

function buildDuel(args) {
  const p1Spec = args.p1 || 'RM7';
  const p2Spec = args.p2 || 'BM4';
  const p1 = resolveProfile(p1Spec, args.p1Over);
  const p2 = resolveProfile(p2Spec, args.p2Over);
  applyStartingStatus(p1, args.p1Over.status);
  applyStartingStatus(p2, args.p2Over.status);
  applyStartingBuffs(p1, args.p1Over.buff);
  applyStartingBuffs(p2, args.p2Over.buff);
  if (args.p1Over.hp != null) p1.hp = args.p1Over.hp;
  if (args.p2Over.hp != null) p2.hp = args.p2Over.hp;
  return {
    p1, p2,
    p1Action: parseAction(args.p1Over.action),
    p2Action: parseAction(args.p2Over.action),
  };
}

function buildEncounter(args) {
  const party = parseParty(args.party, args.pOver) || [resolveProfile(args.p1 || 'KN10', args.p1Over || {})];
  party.forEach(p => { p.team = 'player'; if (!p.kind || p.kind === 'monster') p.kind = 'player'; });
  const enemySpec = args.boss != null ? args.boss : args.enemies;
  const enemies = parseEnemies(enemySpec) || [];
  if (enemies.length === 0) throw new Error('Need --enemies or --boss for encounter mode');
  return {
    party, enemies,
    partyAction: parseAction(args.p1Over.action),
  };
}

function runStats({ runs, seed, build, runOnce, format, kind }) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    Math.random = seedRandom((seed || 1) + i);
    let r;
    try {
      const built = build();
      r = runOnce(built);
    } catch (e) {
      console.error(`Run ${i + 1} errored: ${e.message}`);
      process.exit(1);
    }
    results.push(r);
  }
  if (format === 'json') console.log(JSON.stringify(aggregateStats(results, kind), null, 2));
  else if (format === 'csv') console.log(formatCSV(results, kind));
  else console.log(formatStatsText(results, kind, runs));
}

function aggregateStats(results, kind) {
  const winners = {};
  const turnCounts = [];
  let totalDmgWin = 0, totalDmgLose = 0;
  for (const r of results) {
    const w = r.winner || 'stalemate';
    winners[w] = (winners[w] || 0) + 1;
    turnCounts.push(r.turns);
    if (kind === 'duel') {
      totalDmgWin += r.dmgP1to2;
      totalDmgLose += r.dmgP2to1;
    } else {
      totalDmgWin += r.dmgPartyToEnemy;
      totalDmgLose += r.dmgEnemyToParty;
    }
  }
  const n = results.length;
  const sorted = [...turnCounts].sort((a, b) => a - b);
  return {
    runs: n,
    kind,
    winners,
    winRate: kind === 'duel'
      ? { p1: (winners.P1 || 0) / n, p2: (winners.P2 || 0) / n, stalemate: (winners.stalemate || 0) / n }
      : { party: (winners.party || 0) / n, enemies: (winners.enemies || 0) / n, stalemate: (winners.stalemate || 0) / n },
    turns: {
      avg: turnCounts.reduce((s, x) => s + x, 0) / n,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: sorted[Math.floor(n / 2)],
    },
    avgDmgPerTurn: {
      offensive: totalDmgWin / Math.max(1, turnCounts.reduce((s, x) => s + x, 0)),
      defensive: totalDmgLose / Math.max(1, turnCounts.reduce((s, x) => s + x, 0)),
    },
  };
}

function formatStatsText(results, kind, runs) {
  const stats = aggregateStats(results, kind);
  const lines = [];
  lines.push(`═══ ff3mmo battle-sim — STATS over ${runs} runs ═══`);
  lines.push('');
  lines.push('Win rate:');
  for (const [k, v] of Object.entries(stats.winRate)) {
    const pct = (v * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.round(v * 30));
    lines.push(`  ${k.padEnd(10)} ${pct}%  ${bar}`);
  }
  lines.push('');
  lines.push(`Turns:  avg=${stats.turns.avg.toFixed(2)}  min=${stats.turns.min}  median=${stats.turns.median}  max=${stats.turns.max}`);
  lines.push(`Damage/turn: ${kind === 'duel' ? 'P1→P2' : 'party→enemy'} = ${stats.avgDmgPerTurn.offensive.toFixed(2)}  |  ${kind === 'duel' ? 'P2→P1' : 'enemy→party'} = ${stats.avgDmgPerTurn.defensive.toFixed(2)}`);
  lines.push('');
  // Damage distribution histogram (offensive side)
  const offensive = results.map(r => kind === 'duel' ? r.dmgP1to2 : r.dmgPartyToEnemy);
  const min = Math.min(...offensive), max = Math.max(...offensive);
  const buckets = 8;
  const bw = Math.max(1, Math.ceil((max - min + 1) / buckets));
  const hist = new Array(buckets).fill(0);
  for (const d of offensive) hist[Math.min(buckets - 1, Math.floor((d - min) / bw))]++;
  const peak = Math.max(...hist);
  lines.push(`Damage histogram (${kind === 'duel' ? 'P1→P2' : 'party→enemy'} per battle):`);
  for (let i = 0; i < buckets; i++) {
    const lo = min + i * bw, hi = min + (i + 1) * bw - 1;
    const bar = '█'.repeat(Math.round((hist[i] / peak) * 30));
    lines.push(`  [${String(lo).padStart(4)}–${String(hi).padStart(4)}]  ${String(hist[i]).padStart(4)}  ${bar}`);
  }
  return lines.join('\n');
}

function formatCSV(results, kind) {
  const lines = [];
  if (kind === 'duel') {
    lines.push('run,winner,turns,p1HP,p2HP,dmgP1to2,dmgP2to1');
    results.forEach((r, i) => {
      lines.push(`${i + 1},${r.winner || 'stalemate'},${r.turns},${r.p1HP},${r.p2HP},${r.dmgP1to2},${r.dmgP2to1}`);
    });
  } else {
    lines.push('run,winner,turns,partyAlive,enemyAlive,dmgPartyToEnemy,dmgEnemyToParty');
    results.forEach((r, i) => {
      lines.push(`${i + 1},${r.winner || 'stalemate'},${r.turns},${r.partyAlive},${r.enemyAlive},${r.dmgPartyToEnemy},${r.dmgEnemyToParty}`);
    });
  }
  return lines.join('\n');
}

// ─── Entry ──────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const seed = args.seed != null ? args.seed : 1;
  Math.random = seedRandom(seed);

  // ── Encounter mode (Phase 3) ──
  if (args.enemies != null || args.party != null || args.boss != null) {
    let party, enemies, partyAction, enemyAction;
    try {
      party = parseParty(args.party, args.pOver) || [resolveProfile(args.p1 || 'KN10', args.p1Over || {})];
      party.forEach(p => { p.team = 'player'; if (!p.kind || p.kind === 'monster') p.kind = 'player'; });
      const enemySpec = args.boss != null ? args.boss : args.enemies;
      enemies = parseEnemies(enemySpec) || [];
      if (enemies.length === 0) throw new Error('Need --enemies or --boss for encounter mode');
      partyAction = parseAction(args.p1Over.action);
      enemyAction = { kind: 'attack' }; // monster spAtk is Phase 3.5
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    if (args.runs && args.runs > 1) {
      runStats({
        runs: args.runs, seed,
        build: () => buildEncounter(args),
        runOnce: ({ party, enemies, partyAction }) => runEncounter(party, enemies, { turns: args.turns || 30, partyAction }),
        format: args.json ? 'json' : args.csv ? 'csv' : 'text',
        kind: 'encounter',
      });
      return;
    }
    console.log(`═══ ff3mmo battle-sim  seed=${seed}  mode=encounter ═══`);
    console.log('');
    const out = runEncounter(party, enemies, {
      turns: args.turns || 30,
      partyAction,
      enemyAction,
    });
    console.log(out.text);
    return;
  }

  // ── 1v1 duel mode (Phase 1 + 2) ──
  const p1Spec = args.p1 || 'RM7';
  const p2Spec = args.p2 || 'BM4';

  let p1, p2, p1Action, p2Action;
  try {
    p1 = resolveProfile(p1Spec, args.p1Over);
    p2 = resolveProfile(p2Spec, args.p2Over);
    applyStartingStatus(p1, args.p1Over.status);
    applyStartingStatus(p2, args.p2Over.status);
    applyStartingBuffs(p1, args.p1Over.buff);
    applyStartingBuffs(p2, args.p2Over.buff);
    if (args.p1Over.hp != null) p1.hp = args.p1Over.hp;
    if (args.p2Over.hp != null) p2.hp = args.p2Over.hp;
    p1Action = parseAction(args.p1Over.action);
    p2Action = parseAction(args.p2Over.action);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  if (args.runs && args.runs > 1) {
    runStats({
      runs: args.runs, seed,
      build: () => buildDuel(args),
      runOnce: ({ p1, p2, p1Action, p2Action }) => runBattle(p1, p2, {
        mode: args.mode || 'duel',
        turns: args.turns || 30,
        p1Path: (args.p1Over && args.p1Over.path) || 'auto',
        p2Path: (args.p2Over && args.p2Over.path) || 'auto',
        p1Action, p2Action,
      }),
      format: args.json ? 'json' : args.csv ? 'csv' : 'text',
      kind: 'duel',
    });
    return;
  }

  console.log(`═══ ff3mmo battle-sim  seed=${seed}  mode=${args.mode || 'duel'} ═══`);
  console.log('');
  const out = runBattle(p1, p2, {
    mode: args.mode || 'duel',
    turns: args.turns || 30,
    p1Path: args.p1Over.path || 'auto',
    p2Path: args.p2Over.path || 'auto',
    p1Action,
    p2Action,
  });
  console.log(out.text);
}

main();
