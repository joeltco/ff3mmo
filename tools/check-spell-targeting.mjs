#!/usr/bin/env node
// check-spell-targeting.mjs — the spells FF3 aims at EVERY enemy still do, and
// they still skip target select.
//
//   node tools/check-spell-targeting.mjs
//
// WHAT THIS PROTECTS
// The spell record at $618D0 is EIGHT bytes. `tools/gen-spells-js.js` consumed
// six of them and read a seventh into a local named `targeting` that nothing
// used. On the strength of the six, `src/data/spells.js` carried the claim:
//
//     "The ROM does NOT encode single-vs-all for player spells — checked, not
//      assumed: no castable id uses the `all_enemies` target byte (0x17/0x33)"
//
// That check looked at byte +4. Byte +5 bit 6 is where it actually lives, and
// three castable spells carry it — Meteor, Quake, Raze. All three were being
// aimed at a single body through a target cursor FF3 never shows.
//
// ⛔ PROVEN CAUSALLY, NOT PATTERN-MATCHED. tools/monscan/spell-target-probe.cjs
// runs it on the cartridge in both directions: Fire asks which goblin and
// damages one of four; patch its byte +5 from 0x08 to 0x48 — ONE BIT, nothing
// else — and the same spell stops asking and damages all four. Clearing bit 6
// on Quake makes it ask again. The captures are checked in as
// tools/monscan/spell-target-{bm,wm,call}.json and section 2 replays them.
//
// ⛔ WHAT THIS DELIBERATELY DOES NOT PIN: summons. On the cartridge all eight
// also skip target select, but here a summon's reach belongs to the TIER
// system. That divergence is intentional and section 5 pins it so it stays a
// decision rather than drifting into a bug.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0, checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) { console.log(`  ✓ ${msg}`); return true; }
  fails++; console.log(`  ✗ ${msg}`); return false;
};

globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} },
                        fonts: { load: () => Promise.resolve() } };
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const SPELL_DATA = 0x0618D0, STRIDE = 8;

const { SPELLS, spellHitsAllEnemies, isMultiTargetSpell, getSpellSchool,
        TARGETING_ALL_ENEMIES } = await import('../src/data/spells.js');
const { SUMMON_TIERS } = await import('../src/data/summon-tiers.js');
const { ITEMS } = await import('../src/data/items.js');
const { offensiveSpellPool } = await import('../src/combatant-ai.js');

// ── 1. The record is fully decoded ─────────────────────────────────────────
console.log('\n[1] every byte of the spell record reaches the game');
{
  let missing = 0, wrong = 0;
  for (let id = 0; id < 88; id++) {
    const s = SPELLS.get(id);
    if (!s) { missing++; continue; }
    if (s.targeting !== rom[SPELL_DATA + id * STRIDE + 5]) wrong++;
    if (s.castAnim !== rom[SPELL_DATA + id * STRIDE + 7]) wrong++;
  }
  ok(missing === 0, `all 88 spell records are present (${88 - missing})`);
  ok(wrong === 0, 'every `targeting` (+5) and `castAnim` (+7) matches the ROM byte');
  // ⛔ The failure this file exists for: a field read and not wired.
  const gen = fs.readFileSync(path.join(HERE, 'gen-spells-js.js'), 'utf8');
  ok(/props\.push\(`targeting:/.test(gen), 'gen-spells-js EMITS byte +5 (it used to read and discard it)');
  ok(/props\.push\(`castAnim:/.test(gen), 'gen-spells-js EMITS byte +7');
}

// ── 2. Replay the cartridge sweep ──────────────────────────────────────────
console.log('\n[2] the predicate agrees with what the cartridge did, spell by spell');
{
  const band = (k) => (k > 0.80 ? 'single-enemy' : k > 0.52 ? 'ALL-ENEMIES' : 'single-ally');
  let rows = [];
  for (const s of ['bm', 'wm', 'call']) {
    const f = path.join(HERE, 'monscan', `spell-target-${s}.json`);
    if (fs.existsSync(f)) rows = rows.concat(JSON.parse(fs.readFileSync(f, 'utf8')).map((r) => ({ ...r, school: s })));
  }
  // ⛔ SAME CONVENTION AS check-battle-bg.mjs: the capture is a gate INPUT, it
  // is regenerable, and `tools/monscan/*.json` is gitignored — so a missing one
  // must fail LOUDLY with the command to rebuild it, never quietly skip. A
  // section that skips when its evidence is absent is a section that passes on
  // a fresh clone while checking nothing.
  if (rows.length !== 56) {
    console.log(`  ✗ no cartridge capture (${rows.length}/56 spells).`);
    console.log('      regenerate:  cd tools/monscan && node spell-target-probe.cjs --sweep=bm');
    console.log('                   (repeat for --sweep=wm and --sweep=call; ~40 min total)');
  }
  ok(rows.length === 56, `the cartridge capture covers all 56 castable spells (${rows.length})`);
  let bad = [];
  for (const r of rows) {
    const measured = band(r.kept) === 'ALL-ENEMIES';
    // Summons measured as all-enemies too, and are excluded from the predicate
    // on purpose (section 5). Everything else must agree exactly.
    const expected = r.school === 'call' ? true : spellHitsAllEnemies(r.id);
    if (measured !== expected) bad.push(`0x${r.id.toString(16)}`);
  }
  ok(bad.length === 0, `all 56 agree with the cartridge${bad.length ? ' — disagree: ' + bad.join(' ') : ''}`);

  const auto = [...SPELLS.keys()].filter((id) => id <= 0x37 && spellHitsAllEnemies(id));
  ok(auto.length === 3 && auto.join(',') === '2,7,22',
     `exactly three castable spells auto-target all: ${auto.map((i) => '0x' + i.toString(16)).join(' ')} (Meteor/Quake/Raze)`);
  for (const id of [0x02, 0x07, 0x16]) {
    ok((SPELLS.get(id).targeting & TARGETING_ALL_ENEMIES) !== 0, `0x${id.toString(16)} carries bit 6`);
  }
  ok(!spellHitsAllEnemies(0x31) && !spellHitsAllEnemies(0x0e),
     'Fire and Firaga do NOT auto-target all (the cartridge asks for a target)');
}

// ── 3. The input path actually skips target select ─────────────────────────
// ⛔ Through the SHIPPED handler. Asserting on the predicate alone would pass
// while the menu still opened a cursor — which is the whole bug.
console.log('\n[3] picking one in the magic menu commits without a target cursor');
{
  const { battleSt } = await import('../src/battle-state.js');
  const { inputSt, keys, handleBattleInput } = await import('../src/input-handler.js');
  const { ps } = await import('../src/player-stats.js');

  const pick = (spellId) => {
    battleSt.isRandomEncounter = true;
    battleSt.encounterMonsters = [0, 1, 2, 3].map(() => ({ hp: 40, maxHP: 40, atk: 1, def: 1, agi: 1, level: 1, monsterId: 0 }));
    battleSt.battleAllies = [];
    ps.hp = 300; ps.mp = 99; ps.stats = { maxHP: 300, maxMP: 99, agi: 5, str: 5, int: 30, mnd: 30, vit: 5 };
    inputSt.menuMode = 'magic';
    inputSt.spellSelectList = [spellId];
    inputSt.itemPageCursor = 0;
    inputSt.playerActionPending = null;
    battleSt.battleState = 'item-select';
    battleSt.battleTimer = 0;
    keys['z'] = true;
    handleBattleInput();
    keys['z'] = false;
    return { state: battleSt.battleState, pending: inputSt.playerActionPending, mode: inputSt.itemTargetMode };
  };

  for (const [id, name] of [[0x02, 'Meteor'], [0x07, 'Quake'], [0x16, 'Raze']]) {
    const r = pick(id);
    ok(r.state !== 'item-target-select', `${name} does NOT open the target cursor (state ${r.state})`);
    ok(r.pending && r.pending.targetMode === 'all', `${name} commits with targetMode 'all'`);
    ok(r.pending && r.pending.command === 'magic' && r.pending.spellId === id, `${name} commits as itself`);
  }
  const fire = pick(0x31);
  ok(fire.state === 'item-target-select', 'Fire STILL opens the target cursor (single-target is unchanged)');
  ok(fire.mode === 'single', "Fire still starts the picker in 'single'");
}

// ── 4. Damage numbers ──────────────────────────────────────────────────────
// FF3 drops every body's HP within ONE FRAME on an all-target cast (measured:
// frames 662/662/663/663 across four goblins). The parallel apply path is what
// reproduces that; the serial impact walk shows one number at a time for five
// seconds and is ff3mmo's own presentation for its own picker.
console.log('\n[4] an auto-all cast pops every damage number together');
{
  const { applyIPS } = await import('../src/ips-patcher.js');
  const prom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
  applyIPS(prom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));
  const { ui } = await import('../src/ui-state.js');
  const { battleSt } = await import('../src/battle-state.js');
  const { ps } = await import('../src/player-stats.js');
  const { initTextDecoder } = await import('../src/text-decoder.js');
  const { initFont } = await import('../src/font-renderer.js');
  const { initSpriteAssets } = await import('../src/boot.js');
  const { startSpellCast, initSpellCast } = await import('../src/spell-cast.js');
// ⛔ `_processNextTurn` inside spell-cast.js defaults to a NO-OP until this
// runs (src/main.js does it at boot). Without it `_finishMagicHit` fires and
// nothing advances, so every cast sits in `magic-hit` forever — which reads as
// "the spell never ends" and is purely the harness not being wired.
const { processNextTurn } = await import('../src/battle-turn.js');
initSpellCast({ processNextTurn });
  const { updateBattle } = await import('../src/battle-update.js');
  const { getSwDmgNums } = await import('../src/damage-numbers.js');
  const { setPlayerSprite } = await import('../src/player-sprite.js');
  initTextDecoder(prom); initFont(prom); initSpriteAssets(prom);
  setPlayerSprite({ setDirection() {} });
  ui.ctx = createCanvas(256, 224).getContext('2d');

  const cast = (spellId) => {
    ps.hp = 500; ps.mp = 99; ps.status = { mask: 0 }; ps.jobIdx = 0; ps.palIdx = 0; ps.level = 20;
    ps.stats = { maxHP: 500, maxMP: 99, agi: 10, str: 20, int: 40, mnd: 40, vit: 10 };
    battleSt.isRandomEncounter = true;
    battleSt.battleAllies = [];
    battleSt.encounterMonsters = [0, 1, 2, 3].map(() => ({ hp: 400, maxHP: 400, atk: 5, def: 2, agi: 4, level: 3, exp: 5, gil: 2, monsterId: 0 }));
    battleSt.turnQueue = [];
    battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0;
    startSpellCast(spellId, { enemyIndex: 0, targetMode: 'all' });
    let most = 0, seen = new Set();
    for (let f = 0; f < 900; f++) {
      updateBattle(1000 / 60);
      const n = Object.keys(getSwDmgNums());
      n.forEach((k) => seen.add(k));
      if (n.length > most) most = n.length;
      if (battleSt.battleState === 'none' || battleSt.battleState === 'menu-open') break;
    }
    return { most, seen: seen.size };
  };

  for (const [id, name] of [[0x02, 'Meteor'], [0x07, 'Quake'], [0x16, 'Raze']]) {
    const r = cast(id);
    ok(r.seen === 4, `${name} puts a number on all four bodies (${r.seen})`);
    ok(r.most === 4, `${name} has all four on screen AT ONCE (${r.most}) — the cartridge drops all four HP within 1 frame`);
  }
}

// ── 5. The deliberate divergences stay deliberate ──────────────────────────
console.log('\n[5] what we chose NOT to take from the cartridge');
{
  const summons = [...SUMMON_TIERS.keys()];
  ok(summons.length === 8, `all eight summons are tiered (${summons.length})`);
  ok(summons.every((id) => !spellHitsAllEnemies(id)),
     'summons are excluded from the auto-all rule — their reach is the TIER system\'s call');
  ok(summons.every((id) => !isMultiTargetSpell(id)),
     'summons are still kept out of the all/column picker too');
  // The all/column picker is ff3mmo's own; the cartridge has no such thing.
  ok(isMultiTargetSpell(0x31) && isMultiTargetSpell(0x0e),
     "the picker still offers all/column on ordinary spells (this game's own feature)");
  // ⛔ NO SILENT GAP: nothing routes an auto-all spell through the item path,
  // which stays single-target on purpose. If a weapon ever gains `casts: Quake`
  // this fires and forces the decision instead of shipping the wrong reach.
  const viaItem = [...ITEMS].filter(([, it]) => it && it.casts != null && spellHitsAllEnemies(it.casts));
  ok(viaItem.length === 0,
     `no item/weapon casts an auto-all spell (${viaItem.length}) — the item path is single-target by design`);

  // ⛔ THE SAME GAP ON THE ALLY SIDE, PINNED BEFORE IT EXISTS. An ally's
  // offensive cast is architecturally single-target: `_tryAllyOffensiveCast`
  // stores ONE `allyMagicTargetIdx`, the wire payload carries ONE target, and
  // the render path draws ONE target effect. Today nothing can reach an
  // auto-all spell through it — the pool is Fire / Blizzard / Sleep plus the
  // summons — so there is no bug to fix. But adding Quake to OFFENSIVE_SPELLS
  // would silently cast it at a single body, which is the exact defect this
  // whole arc was about, arriving through the one door nobody was watching.
  const aiPool = offensiveSpellPool();
  const aiAutoAll = aiPool.filter(spellHitsAllEnemies);
  ok(aiAutoAll.length === 0,
     `the ally AI's offensive pool reaches no auto-all spell (${aiAutoAll.length}) — ` +
     'the ally cast path is single-target only; widening the pool needs a multi-target ally path first');
}

// ── 5b. Summon tiers reach what their own table says ───────────────────────
// ⛔ `all` USED TO BE READ ONLY TO NARROW. The magic menu commits summons with
// targetMode 'single' (they are excluded from the all/column picker on
// purpose), so `_targets` arrived holding ONE enemy and an `all: true` effect
// had nothing to widen — every Summoner-tier summon hit a single body,
// Zantetsuken included. Measured through the real menu before the fix:
// TARGETS=1 for Diamond Dust, Tidal Wave, Mega Flair and Zantetsuken alike.
//
// The cartridge: a summon never opens a target cursor, and the game labels the
// target itself — "Everyone" vs the enemy's own name. A Sage's Shiva drops all
// four bodies' HP within ONE FRAME.
console.log('\n[5b] a summon reaches what its tier effect says it reaches');
{
  const { battleSt } = await import('../src/battle-state.js');
  const { ps } = await import('../src/player-stats.js');
  const { startSpellCast, getSpellTargets, getActiveSummonEffect } = await import('../src/spell-cast.js');
  const { JOB_CONJURER, JOB_SUMMONER, JOB_SAGE } = await import('../src/data/summon-tiers.js');

  const cast = (job, spellId) => {
    ps.hp = 500; ps.mp = 99; ps.status = { mask: 0 }; ps.jobIdx = job; ps.palIdx = 0; ps.level = 30;
    ps.stats = { maxHP: 500, maxMP: 99, agi: 10, str: 20, int: 40, mnd: 40, vit: 10 };
    battleSt.isRandomEncounter = true; battleSt.battleAllies = [];
    battleSt.encounterMonsters = [0, 1, 2, 3].map(() => ({ hp: 900, maxHP: 900, atk: 5, def: 2, agi: 4, level: 3, exp: 5, gil: 2, monsterId: 0 }));
    battleSt.turnQueue = []; battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0;
    // ⛔ targetMode 'single' ON PURPOSE — that is what the magic menu sends for
    // a summon. Passing 'all' here would test the picker, not the tier.
    startSpellCast(spellId, { enemyIndex: 0, targetMode: 'single' });
    // ⛔ Read the effect the CAST rolled. Re-rolling one here with a forced rng
    // reports a different subject than the run used — it printed "Icy Stare
    // all=false" for a cast that had actually rolled the all-target Mesmerize.
    return { eff: getActiveSummonEffect(), targets: getSpellTargets() };
  };

  const SUMMONS = [0x30, 0x0d, 0x06, 0x14, 0x22, 0x29, 0x1b, 0x37];
  let bad = [];
  for (const job of [JOB_SUMMONER, JOB_SAGE, JOB_CONJURER]) {
    for (const id of SUMMONS) {
      // The Evoker rolls, so sample until both branches are seen or we give up.
      for (let attempt = 0; attempt < 12; attempt++) {
        const { eff, targets } = cast(job, id);
        if (!eff) { bad.push(`0x${id.toString(16)} job${job}: no effect`); break; }
        const enemies = targets.filter((t) => t.type === 'enemy').length;
        if (eff.kind === 'heal' || eff.kind === 'buff') {
          // Known deliberate gap: party-side effects stay on the player.
          if (targets.length !== 1 || targets[0].type !== 'player') bad.push(`0x${id.toString(16)} ${eff.name}: buff/heal not on player`);
        } else if (eff.all) {
          if (enemies !== 4) bad.push(`0x${id.toString(16)} ${eff.name} (all): ${enemies} enemies, want 4`);
        } else if (enemies !== 1) {
          bad.push(`0x${id.toString(16)} ${eff.name} (single): ${enemies} enemies, want 1`);
        }
      }
    }
  }
  ok(bad.length === 0, `every tier effect reaches its declared scope${bad.length ? ' — ' + [...new Set(bad)].slice(0, 4).join('; ') : ''}`);

  // The four that were the reported bug, pinned by name.
  let pinned = 0;
  for (const [id, name] of [[0x30, 'Diamond Dust'], [0x0d, 'Tidal Wave'], [0x06, 'Mega Flair'], [0x14, 'Zantetsuken']]) {
    const { eff, targets } = cast(JOB_SUMMONER, id);
    if (eff && eff.name === name && targets.filter((t) => t.type === 'enemy').length === 4) pinned++;
    else ok(false, `${name} reaches all four (got ${targets.filter((t) => t.type === 'enemy').length})`);
  }
  ok(pinned === 4, 'Diamond Dust / Tidal Wave / Mega Flair / Zantetsuken all reach the whole formation');

  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'spell-cast.js'), 'utf8');
  ok(/_enemySideTargets\('all'\)/.test(src), 'the widen goes through the SHARED enemy enumeration, not a second copy');
}

// ── 6. Byte +7 agrees with the school rule ─────────────────────────────────
console.log('\n[6] the cast-halo byte still agrees with getSpellSchool');
{
  const BLACK = new Set([0x2e, 0x2f, 0x3d]), WHITE = new Set([0x30, 0x31, 0x32, 0x3e]), CALL = new Set([0x3f]);
  let bad = [];
  for (let id = 0; id <= 0x37; id++) {
    const b7 = SPELLS.get(id).castAnim;
    const romSchool = BLACK.has(b7) ? 'black' : WHITE.has(b7) ? 'white' : CALL.has(b7) ? 'call' : '?';
    if (romSchool !== getSpellSchool(id)) bad.push(`0x${id.toString(16)}`);
  }
  ok(bad.length === 0,
     `all 56 castable spells: the ROM's cast-halo byte and the position rule agree${bad.length ? ' — ' + bad.join(' ') : ''}`);
}

console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
