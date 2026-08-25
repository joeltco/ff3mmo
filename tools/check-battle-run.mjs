#!/usr/bin/env node
// check-battle-run.mjs — the Run command's beats are long enough to SEE, and a
// PvP flee actually ends the battle.
//
//   node tools/check-battle-run.mjs
//
// WHAT THIS PROTECTS
// v1.7.287 made the battle message strip non-blocking: "animations never wait
// on messages", and the `isBattleMsgBusy()` gates came out of every state
// handler. That was right everywhere except Run, which is the one action with
// NO animation timeline of its own — the gate had been the only thing holding
// its two states open. After it went, measured on the shipped machine:
//
//   run-success   1 frame (17 ms)   against a 300 ms turn-and-flee animation
//   run-fail      1 frame (17 ms)   with the enemy's name already overwriting
//                                   "Cant escape!" by the end of that frame
//
// So the flee animation never drew an intermediate frame and the failure
// message was never readable. Reported from play as "messages getting cut off,
// animations are gone". Fixed v1.10.83 by giving each state the duration of the
// thing it exists to show.
//
// ⛔ The fix is NOT to reintroduce `isBattleMsgBusy()`. That re-couples the
// state machine to whatever text happens to be on the strip. Section 4 fails if
// it comes back.
//
// ⛔ A DURATION IS NOT AN ANIMATION. Section 2 renders the flee through the
// SHIPPED portrait draw and requires the pixels to actually MOVE across the
// state's frames — a state that is 300 ms long but draws the same frame 18
// times would pass a timing check and still be the bug.
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
                        getElementById: () => null, body: { appendChild() {} } };

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));

const { ui } = await import('../src/ui-state.js');
const { battleSt, RUN_SLIDE_MS, RUN_SLIDE_PX } = await import('../src/battle-state.js');
const { inputSt } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
const { hudSt } = await import('../src/hud-state.js');
const { pvpSt } = await import('../src/pvp.js');
const { updateBattle, resetBattleVars } = await import('../src/battle-update.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { computeMsgTimings } = await import('../src/battle-msg.js');
const { BATTLE_CANT_ESCAPE } = await import('../src/data/strings.js');
const { initTextDecoder } = await import('../src/text-decoder.js');
const { initFont } = await import('../src/font-renderer.js');
const { initHUD } = await import('../src/hud-init.js');
const { bsc, initBattleSpriteCache, loadJobBattleSprites } = await import('../src/battle-sprite-cache.js');
const { drawBattlePortrait } = await import('../src/battle-draw-player.js');

initTextDecoder(rom); initFont(rom); initHUD(rom);
initBattleSpriteCache(); loadJobBattleSprites(rom, 0, 0);
setPlayerSprite({ setDirection() {} });

const DT = 1000 / 60;
const FRAME = 1000 / 60;

/** Drive the shipped machine from a confirmed Run and return every state's ms. */
function runTimeline({ pvp = false, monsterLevel = 3, maxFrames = 900 } = {}) {
  resetBattleVars();
  pvpSt.isPVPBattle = pvp; pvpSt.isWirePVP = false;
  battleSt.battleAllies = [];
  if (pvp) {
    pvpSt.pvpOpponentStats = { hp: 50, maxHP: 50, agi: 1, atk: 5, def: 2 };
    pvpSt.pvpEnemyAllies = []; pvpSt.pvpOpponent = { name: 'Foe' };
    battleSt.isRandomEncounter = false; battleSt.encounterMonsters = null;
  } else {
    battleSt.isRandomEncounter = true;
    battleSt.encounterMonsters = [{ hp: 20, maxHP: 20, atk: 5, def: 2, agi: 1,
                                    level: monsterLevel, exp: 5, monsterId: 0 }];
  }
  // agi 99 wins initiative so the PLAYER's turn is the one that runs; the
  // monster's LEVEL is what forces the escape roll. `successRate` is
  // `agi + 25 - level/4`, so level 600 clamps it to 1% and level 3 to 99%.
  ps.hp = 100; ps.stats = { maxHP: 100, agi: 99, str: 5 }; ps.status = { mask: 0 };
  hudSt.playerDeathTimer = null;
  battleSt.battleState = 'confirm-pause'; battleSt.battleTimer = 0;
  inputSt.playerActionPending = { command: 'run' };

  const spans = [];
  let cur = battleSt.battleState, f0 = 0;
  for (let f = 0; f < maxFrames; f++) {
    updateBattle(DT);
    if (battleSt.battleState !== cur) {
      spans.push({ state: cur, ms: (f - f0) * DT, frames: f - f0 });
      cur = battleSt.battleState; f0 = f;
    }
  }
  spans.push({ state: cur, ms: (maxFrames - f0) * DT, frames: maxFrames - f0, trailing: true });
  return spans;
}
const spanOf = (spans, state) => spans.find(s => s.state === state);

// ── 1. Durations ───────────────────────────────────────────────────────────
let measuredSuccessMs = 0, measuredCloseMs = 0;
console.log('\n[1] the two run states last long enough to see');
{
  // 99% escape — retry so a 1-in-100 roll can't flake the gate.
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    const t = runTimeline({ monsterLevel: 3 });
    if (spanOf(t, 'run-success')) win = t;
  }
  if (ok(!!win, 'a 99%-rate escape reaches run-success')) {
    const s = spanOf(win, 'run-success');
    measuredSuccessMs = s.ms;
    const c = spanOf(win, 'encounter-box-close');
    measuredCloseMs = c ? c.ms : 0;
    ok(Math.abs(s.ms - RUN_SLIDE_MS) <= DT + 1,
       `run-success holds the flee animation's own length: ${s.ms.toFixed(0)}ms vs RUN_SLIDE_MS ${RUN_SLIDE_MS}`);
    ok(s.frames >= 15, `run-success draws ${s.frames} frames (one frame was the bug)`);
    ok(!!spanOf(win, 'encounter-box-close'), 'a successful escape closes the encounter box');
  }

  let lose = null;
  for (let i = 0; i < 40 && !lose; i++) {
    const t = runTimeline({ monsterLevel: 600 });
    if (spanOf(t, 'run-fail')) lose = t;
  }
  if (ok(!!lose, 'a 1%-rate escape reaches run-fail')) {
    const s = spanOf(lose, 'run-fail');
    const want = computeMsgTimings({ bytes: BATTLE_CANT_ESCAPE }).total;
    ok(Math.abs(s.ms - want) <= DT + 1,
       `run-fail holds the message's own full lifetime: ${s.ms.toFixed(0)}ms vs ${want}ms`);
    ok(s.frames >= 15, `run-fail draws ${s.frames} frames (one frame was the bug)`);
    // The enemy must act AFTER the message, not during it.
    const iFail = lose.findIndex(x => x.state === 'run-fail');
    const after = lose.slice(iFail + 1).map(x => x.state);
    ok(after.length > 0 && !after.includes('run-fail'),
       `the turn continues after the message: ${after.slice(0, 3).join(' -> ')}`);
  }
}

// ── 2. The animation actually MOVES ────────────────────────────────────────
// ⛔ Holding the state open is not the same as drawing an animation. Render the
// portrait slot through the SHIPPED draw at each frame the state machine would
// be showing, and require the pixels to change — and to leave.
console.log('\n[2] the flee animation moves across the frames the state now has');
{
  const SLOT = 16, PX = 152, PY = 40;      // HUD_RIGHT_X+8, HUD_VIEW_Y+8
  const frame = createCanvas(256, 224);
  ui.ctx = frame.getContext('2d');
  ui.ctx.imageSmoothingEnabled = false;
  ps.hp = 100; ps.stats = { maxHP: 100, agi: 10, str: 5 }; ps.status = { mask: 0 };
  ps.jobIdx = 0; ps.palIdx = 0; hudSt.playerDeathTimer = null;

  const shot = (state, t, slideBack) => {
    battleSt.battleState = state; battleSt.battleTimer = t;
    battleSt.runSlideBack = slideBack; battleSt.battleShakeTimer = 0;
    ui.ctx.fillStyle = '#000'; ui.ctx.fillRect(0, 0, 256, 224);
    drawBattlePortrait();
    return ui.ctx.getImageData(PX, PY, SLOT, SLOT).data;
  };
  const lit = (d) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && (d[i-3] | d[i-2] | d[i-1])) n++; return n; };
  const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  // ⛔ Render across the duration the state machine MEASURED in section 1, not
  // across RUN_SLIDE_MS. Rendering the constant asks "would this animate if it
  // were given 300 ms" — which stays true while the player sees one frame. This
  // asks what the player actually gets.
  const frames = [];
  for (let f = 0; f * FRAME < measuredSuccessMs; f++) frames.push(shot('run-success', f * FRAME, false));
  ok(frames.length >= 15, `run-success spans ${frames.length} rendered frames (measured ${measuredSuccessMs.toFixed(0)}ms)`);
  const distinct = frames.filter((d, i) => i === 0 || !same(d, frames[i - 1])).length;
  ok(distinct >= 5, `the portrait moves: ${distinct} distinct frames across the flee`);
  ok(lit(frames[0]) > 20, 'the character is on screen when the flee starts');
  ok(lit(frames[frames.length - 1]) === 0, 'the character has left the slot by the last frame');

  // Slide-back: starts empty (below the clip) and ends with the character home.
  const back0 = shot('encounter-box-close', 0, true);
  const backN = shot('encounter-box-close', Math.min(measuredCloseMs, RUN_SLIDE_MS) - 1, true);
  ok(lit(back0) === 0, 'the slide-back starts with the slot empty');
  ok(lit(backN) > 20, 'the slide-back ends with the character back in place');
  // ⛔ BOTH close states. A PvP flee closes through `enemy-box-close`.
  const pvpBack = shot('enemy-box-close', RUN_SLIDE_MS - 1, true);
  ok(lit(pvpBack) > 20, 'the slide-back also runs during a PvP close (enemy-box-close)');
  ok(RUN_SLIDE_PX > 0 && RUN_SLIDE_PX >= SLOT, 'RUN_SLIDE_PX carries the character clear of its 16px slot');
}

// ── 3. A PvP flee ends the battle ──────────────────────────────────────────
// `updatePVPBattle` has its own handler chain. `updateBattleRun` was missing
// from it, so the fleeing client sat in `run-success` forever while the
// opponent's copy left the battle on the wire message.
console.log('\n[3] a PvP flee ends the battle on the fleeing client');
{
  const t = runTimeline({ pvp: true, maxFrames: 1800 });
  const s = spanOf(t, 'run-success');
  ok(!!s, 'a PvP Run reaches run-success');
  ok(!!s && !s.trailing, 'run-success is not terminal (it was: still there after 30 s)');
  ok(!!spanOf(t, 'enemy-box-close'), 'the PvP close state is reached');
  ok(t[t.length - 1].state === 'none', `the battle ends (final state: ${t[t.length - 1].state})`);
}

// ── 4. The wiring that made this invisible ─────────────────────────────────
console.log('\n[4] the wiring stays put');
{
  const upd = fs.readFileSync(path.join(HERE, '..', 'src', 'battle-update.js'), 'utf8');
  const pvp = fs.readFileSync(path.join(HERE, '..', 'src', 'pvp.js'), 'utf8');
  const draw = fs.readFileSync(path.join(HERE, '..', 'src', 'battle-draw-player.js'), 'utf8');

  const body = upd.slice(upd.indexOf('export function updateBattleRun'),
                         upd.indexOf('const _updateBattleRun = updateBattleRun'));
  ok(body.length > 0, 'updateBattleRun is exported');
  ok(!/isBattleMsgBusy/.test(body),
     'run does NOT gate on isBattleMsgBusy (v1.7.287 removed that coupling on purpose)');
  ok(/RUN_SLIDE_MS/.test(body), 'run-success is paced by RUN_SLIDE_MS, not a local literal');
  ok(/_runFailHoldMs\(\)/.test(body), 'run-fail is paced by the message\'s own computed lifetime');

  ok(/updateBattleRun\(\)/.test(pvp), 'updatePVPBattle calls updateBattleRun');
  ok(/updateBattleRun/.test(pvp.slice(0, pvp.indexOf('\n\n'))) ||
     /import[\s\S]{0,400}updateBattleRun/.test(pvp), 'pvp.js imports updateBattleRun');

  // ⛔ The 300 must have exactly ONE home. A second copy is how PLAYER_DMG_SHOW_MS
  // drifted 50 ms out of step with the number it existed to show.
  ok(!/battleTimer \/ 300\b/.test(draw),
     'battle-draw-player.js holds no bare 300ms run ramp (single source: RUN_SLIDE_MS)');
  ok(/RUN_SLIDE_MS/.test(draw) && /RUN_SLIDE_PX/.test(draw),
     'the draw path reads the shared run constants');

  // Per-battle flag: cleared centrally, not only on the encounter close path.
  battleSt.runSlideBack = true;
  resetBattleVars();
  ok(battleSt.runSlideBack === false, 'resetBattleVars clears runSlideBack (it leaked past a PvP flee)');
}

console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
