#!/usr/bin/env node
// tools/wire-stats-diag.js — wire-profile loss diagnostic.
//
// Hypothesis (post v1.7.497): the monster-attack branch unification fixed
// the per-event divergence but lockstep is still broken because the wire
// profile shipped by `src/main.js#connectNet` drops fields that
// `recalcCombatStats` reads. So when Phone B reconstructs Phone A's player
// via `generateAllyStats(profile)`, the resulting ally has different
// combat stats than Phone A's local `ps` — same unified code path on both
// phones, different inputs, different damage outputs.
//
// This harness builds a realistic ps, runs `recalcCombatStats` to populate
// it (authoritative local stats), then mirrors the EXACT wire profile
// shape from `main.js:73-119`, feeds it to `generateAllyStats`, and prints
// every field that differs. Output is a concrete list of what's missing
// from the wire.

// ── Browser shims (cloned from coop-viewer-sim.js) ─────────────────────
const _stubEl = () => ({
  style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  appendChild: () => {}, removeChild: () => {},
  setAttribute: () => {}, getAttribute: () => null, parentNode: null,
  getContext: () => ({
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
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, location: { href: '' }, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 };
globalThis.document = { createElement: _stubEl, getElementById: _stubEl, querySelector: _stubEl, querySelectorAll: () => [], addEventListener: () => {}, body: { appendChild: () => {}, querySelector: () => null }, head: { appendChild: () => {} } };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame  = () => {};
globalThis.Image = class { constructor() { this.onload = null; } };
globalThis.Audio = class { constructor() {} play() {} pause() {} };
globalThis.AudioContext = class { constructor() {} createGain() { return { gain: { value: 0 }, connect: () => {} }; } createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; } decodeAudioData() { return Promise.resolve({}); } get destination() { return {}; } };
globalThis.Worker = class { constructor() {} postMessage() {} addEventListener() {} terminate() {} };
globalThis.localStorage = { _kv: new Map(), getItem(k) { return this._kv.has(k) ? this._kv.get(k) : null; }, setItem(k, v) { this._kv.set(k, String(v)); }, removeItem(k) { this._kv.delete(k); }, clear() { this._kv.clear(); } };
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} addEventListener() {} removeEventListener() {} };

// ── Imports ────────────────────────────────────────────────────────────
const playerStatsMod = await import('../src/player-stats.js');
const dataPlayersMod = await import('../src/data/players.js');

const { ps, recalcCombatStats, getEffectiveStats, getShieldEvade, getJobLevel } = playerStatsMod;
const { generateAllyStats, computeJobStats } = dataPlayersMod;

// ── Set up a realistic local player ─────────────────────────────────────
//
// Job: White Wizard (jobIdx 3), character level 30, jobLevel 9.
// Equipment chosen for visible divergence: every slot has an item that
// contributes a strBonus / vitBonus / etc.; the `arms` slot in particular
// will be silently dropped on the wire.

const JOB_IDX = 3;          // White Wizard
const CHAR_LV = 30;
const JOB_LV  = 9;

const jobStats = computeJobStats(JOB_IDX, CHAR_LV);
Object.assign(ps, {
  name:        'TestA',
  jobIdx:      JOB_IDX,
  palIdx:      0,
  hp:          jobStats.maxHP,
  mp:          jobStats.maxMP || 0,
  cp:          0,
  buffs:       {},
  // Job-level map — local has jobLv 9 for this job.
  jobLevels: { [JOB_IDX]: { level: JOB_LV, jp: 0 } },
  // Authoritative stats block.
  stats: {
    str:    jobStats.str,
    agi:    jobStats.agi,
    vit:    jobStats.vit,
    int:    jobStats.int,
    mnd:    jobStats.mnd,
    level:  CHAR_LV,
    maxHP:  jobStats.maxHP,
    maxMP:  jobStats.maxMP || 0,
  },
  // Equipment — every slot, all with visible bonuses (strBonus etc).
  weaponR: 0x36,   // sword: atk 160, hit 80, strBonus 5
  weaponL: 0xFF,   // empty
  head:    0x69,   // helmet: def 5, evade 8, mdef 5, strBonus 5
  body:    0x86,   // body: def 20, evade 12, mdef 14, mndBonus 5
  arms:    0x8f,   // arms: def 3, evade 9, mdef 4, strBonus 5
  knownSpells: [0x01, 0x02, 0x03],
});

recalcCombatStats();   // populates ps.atk, ps.def, ps.evade, ps.mdef, ps.hitRate, ps.elemResist, ps.statusResist

// Snapshot the authoritative local view. Effective stats are what the
// local recalcCombatStats / battle math actually use (base + jpBonus +
// equipment bonuses).
const _localEff = getEffectiveStats();
const local = {
  jobIdx:        ps.jobIdx | 0,
  level:         ps.stats.level | 0,
  jobLevel:      JOB_LV,
  atk:           ps.atk | 0,
  def:           ps.def | 0,
  evade:         ps.evade | 0,
  mdef:          ps.mdef | 0,
  hitRate:       ps.hitRate | 0,
  agi:           _localEff.agi,
  int:           _localEff.int,
  mnd:           _localEff.mnd,
  hp:            ps.hp | 0,
  maxHP:         ps.stats.maxHP | 0,
  mp:            ps.mp | 0,
  maxMP:         ps.stats.maxMP | 0,
  statusResist:  ps.statusResist | 0,
  elemResist:    Array.isArray(ps.elemResist) ? [...ps.elemResist] : [],
  knownSpellsLen: Array.isArray(ps.knownSpells) ? ps.knownSpells.length : 0,
};

// ── Mirror the EXACT wire profile from main.js#connectNet ──────────────
//
// Pulled verbatim from src/main.js:81-118 (the `connectNet` profile
// getter). Anything not listed below is dropped on the wire.

const eff = getEffectiveStats();
const wireProfile = {
  name:          ps.name || 'Player',
  jobIdx:        ps.jobIdx | 0,
  level:         ps.stats.level | 0 || 1,
  palIdx:        0,
  hp:            ps.hp | 0,
  maxHP:         ps.stats.maxHP | 0,
  mp:            ps.mp | 0,
  maxMP:         ps.stats.maxMP | 0,
  inBattle:      0,
  agi:           eff.agi,
  weaponR:       ps.weaponR | 0,
  weaponL:       ps.weaponL | 0,
  armorId:       ps.body | 0,
  helmId:        ps.head | 0,
  atk:           ps.atk | 0,
  def:           ps.def | 0,
  evade:         ps.evade | 0,
  mdef:          ps.mdef | 0,
  hitRate:       ps.hitRate | 0,
  shieldEvade:   getShieldEvade() | 0,
  statusResist:  ps.statusResist | 0,
  elemResist:    Array.isArray(ps.elemResist) ? [...ps.elemResist] : [],
  intStat:       eff.int,
  mndStat:       eff.mnd,
  jobLevel:      getJobLevel() | 0,
  knownSpells:   Array.isArray(ps.knownSpells) ? [...ps.knownSpells] : [],
};

// ── Receiver side: reconstruct via generateAllyStats ───────────────────

const ally = generateAllyStats(wireProfile);

const reconstructed = {
  jobIdx:       ally.jobIdx | 0,
  level:        ally.level | 0,
  jobLevel:     ally.jobLevel | 0,
  atk:          ally.atk | 0,
  def:          ally.def | 0,
  evade:        ally.evade | 0,
  mdef:         ally.mdef | 0,
  hitRate:      ally.hitRate | 0,
  agi:          ally.agi | 0,
  int:          ally.int | 0,
  mnd:          ally.mnd | 0,
  hp:           ally.hp | 0,
  maxHP:        ally.maxHP | 0,
  mp:           ally.mp | 0,
  maxMP:        ally.maxMP | 0,
  statusResist: ally.statusResist | 0,
  elemResist:   Array.isArray(ally.elemResist) ? [...ally.elemResist] : [],
  knownSpellsLen: Array.isArray(ally.knownSpells) ? ally.knownSpells.length : 0,
};

// ── Diff & print ───────────────────────────────────────────────────────

const fields = Object.keys(local);
let diverged = 0;
process.stdout.write('\nWire-profile loss diagnostic — Player A as seen locally vs. via wire\n');
process.stdout.write('Setup: jobIdx=' + JOB_IDX + ' (WM), charLv=' + CHAR_LV + ', jobLv=' + JOB_LV + '\n');
process.stdout.write('Equipment: weaponR=0x36 (sword+strBonus), head=0x69 (helm+strBonus),\n');
process.stdout.write('           body=0x86 (mdef+mndBonus), arms=0x8f (def+strBonus)\n\n');
process.stdout.write('  ' + 'field'.padEnd(18) + 'local (ps)'.padEnd(28) + 'wire→ally\n');
process.stdout.write('  ' + '─'.repeat(60) + '\n');
for (const k of fields) {
  const a = JSON.stringify(local[k]);
  const b = JSON.stringify(reconstructed[k]);
  const same = a === b;
  if (!same) diverged++;
  const marker = same ? '   ok' : ' DIFF';
  process.stdout.write(`${marker} ${k.padEnd(18)}${a.padEnd(28)}${b}\n`);
}
process.stdout.write('\n');
if (diverged === 0) {
  process.stdout.write('No divergence detected — wire profile is lossless.\n');
  process.exit(0);
} else {
  process.stdout.write(`${diverged} field(s) diverge between local ps and wire-reconstructed ally.\n`);
  process.stdout.write('These are the lockstep killers: every monster attack against this\n');
  process.stdout.write('player runs the same unified code path but with different stat inputs\n');
  process.stdout.write('depending on which phone is computing. HP/status diverges turn one.\n');
  process.exit(1);
}
