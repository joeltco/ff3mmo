#!/usr/bin/env node
// check-pve-claim.mjs — the end-of-battle claim must describe THIS battle.
//
// Field report (2026-08-13, prod v1.7.981, user 9, battles 3/4/5):
//
//   [pve-reward-desync] battle=3 exp claim=10 expected=15 gil claim=6 expected=10
//                       serverMons=[5,5,5] clientMons=[5,5,5]
//   [pve-reward-desync] battle=4 exp claim=10 expected=15 gil claim=6 expected=10
//   [pve-reward-desync] battle=5           gil claim=6 expected=7   serverMons=[5,5]
//
// Monster 5 is worth 20 exp / 14 gil, so three of them are 15 exp / 10 gil and
// two are 10 / 7 — the server's numbers are right both times. The client sent
// exp 10 / gil 6 in ALL THREE, including battles with different monster counts.
// A constant answer across different inputs is not an arithmetic difference; it
// is a value left over from an earlier battle.
//
// `resetBattleVars` clears `encounterDropItem` but not `encounterExpGained` /
// `GilGained` / `CpGained`, and `buildPveClaim` infers the victor from
// "expGained > 0". So after ONE win, every later flee claims `victor: 'party'`
// carrying the old win's rewards — and the server, which cannot see monster HP
// yet, pays out full price for a battle the player ran away from.
//
//   node tools/check-pve-claim.mjs

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = {
  createElement: () => ({ getContext: () => ({}), style: {}, width: 0, height: 0 }),
  addEventListener() {}, getElementById: () => null,
};

const { battleSt } = await import('../src/battle-state.js');
const { ps } = await import('../src/player-stats.js');
const { resetBattleVars } = await import('../src/battle-update.js');
const { buildPveClaim } = await import('../src/pve-client.js');
const { MONSTERS } = await import('../src/data/monsters.js');

const fail = [];
const err = (m) => fail.push(m);

const mob = (id) => {
  const d = MONSTERS.get(id);
  return { monsterId: id, hp: d.hp, maxHP: d.hp, exp: d.exp, gil: d.gil, cp: d.cp != null ? d.cp : 1 };
};
// The reward formula both sides run, so the fixture's numbers stay honest.
const reward = (mons, key) => Math.max(1, Math.floor(mons.reduce((s, m) => s + (m[key] | 0), 0) / 4));

/** Put battleSt where a WON battle leaves it. */
function winBattle(ids) {
  const mons = ids.map(mob);
  resetBattleVars();
  battleSt.isRandomEncounter = true;
  battleSt.encounterMonsters = mons;
  ps.hp = 30;
  for (const m of mons) m.hp = 0;                       // all dead
  battleSt.encounterExpGained = reward(mons, 'exp');    // what victory computes
  battleSt.encounterGilGained = reward(mons, 'gil');
  battleSt.encounterCpGained  = reward(mons, 'cp');
  return mons;
}

/** Put battleSt where a battle the player RAN FROM leaves it. */
function fleeBattle(ids) {
  const mons = ids.map(mob);
  resetBattleVars();          // the only reset a new encounter performs
  battleSt.isRandomEncounter = true;
  battleSt.encounterMonsters = mons;
  ps.hp = 30;                 // alive, monsters untouched — nothing was killed
  return mons;
}

// ── 1. a real win claims a win, with this battle's numbers ────────────────
{
  const mons = winBattle([5, 5, 5]);
  const c = buildPveClaim();
  if (c.victor !== 'party') err(`a won battle claimed victor "${c.victor}"`);
  if (c.expGained !== reward(mons, 'exp')) err(`win claimed ${c.expGained} exp, this battle is worth ${reward(mons, 'exp')}`);
  if (c.gilGained !== reward(mons, 'gil')) err(`win claimed ${c.gilGained} gil, this battle is worth ${reward(mons, 'gil')}`);
}

// ── 2. FLEEING AFTER A WIN must not claim the win again ───────────────────
// This is the reported bug. Pre-fix the claim comes back victor:'party' with
// the previous fight's exp/gil, and the server pays out for monsters that are
// still standing.
{
  winBattle([5, 5, 5]);                 // battle 1: a genuine victory
  const mons = fleeBattle([5, 5, 5]);   // battle 2: ran away
  const c = buildPveClaim();
  if (c.victor !== 'fled') {
    err(`ran from a battle but claimed victor "${c.victor}" — the server pays full rewards for it`);
  }
  if (c.expGained !== 0 || c.gilGained !== 0 || c.cpGained !== 0) {
    err(`a flee claimed exp ${c.expGained} / gil ${c.gilGained} / cp ${c.cpGained}; ` +
        `all three must be 0 (the previous win was worth ${reward(mons, 'exp')} / ${reward(mons, 'gil')})`);
  }
}

// ── 3. the stale numbers must not survive into a DIFFERENT-SIZED battle ───
// Battle 5 in the report: two monsters, and the client still sent the
// three-monster answer. A claim that ignores its own monster list is the
// signature to guard against.
{
  winBattle([5, 5, 5]);
  winBattle([5, 5]);                    // second, smaller victory
  const c = buildPveClaim();
  const two = [mob(5), mob(5)];
  if (c.expGained !== reward(two, 'exp') || c.gilGained !== reward(two, 'gil')) {
    err(`a 2-monster win claimed ${c.expGained}/${c.gilGained}, expected ` +
        `${reward(two, 'exp')}/${reward(two, 'gil')} — rewards carried over from the bigger fight`);
  }
}

// ── 4. a wipe stays a wipe even with rewards sitting in battleSt ──────────
{
  winBattle([5, 5, 5]);
  fleeBattle([5, 5, 5]);
  ps.hp = 0;
  const c = buildPveClaim();
  if (c.victor !== 'wipe') err(`a KO'd player claimed victor "${c.victor}"`);
  if (c.expGained || c.gilGained || c.cpGained) err('a wipe claimed rewards');
  ps.hp = 30;
}

// ── 5. a new battle starts with no rewards on the books ──────────────────
// The claim now derives the victor from monster HP, so this reset is no longer
// the only thing standing between a flee and a payout — but every victory HUD
// field (exp/gil/cp/job-level-up) is read straight out of battleSt, and a
// battle that ends on a path which does not set them would otherwise display,
// and bank, the previous fight's numbers. Asserted directly because the claim
// tests above cannot see it: with the victor fix in place they pass either way.
{
  battleSt.encounterExpGained = 99;
  battleSt.encounterGilGained = 88;
  battleSt.encounterCpGained  = 77;
  battleSt.encounterJobLevelUp = true;
  resetBattleVars();
  if (battleSt.encounterExpGained !== 0) err(`resetBattleVars left encounterExpGained at ${battleSt.encounterExpGained}`);
  if (battleSt.encounterGilGained !== 0) err(`resetBattleVars left encounterGilGained at ${battleSt.encounterGilGained}`);
  if (battleSt.encounterCpGained  !== 0) err(`resetBattleVars left encounterCpGained at ${battleSt.encounterCpGained}`);
  if (battleSt.encounterJobLevelUp) err('resetBattleVars left encounterJobLevelUp set');
}

if (fail.length) {
  for (const m of fail) console.error(`  ✗ ${m}`);
  console.error(`\ncheck-pve-claim: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log('check-pve-claim: OK — claims describe the battle they came from');
