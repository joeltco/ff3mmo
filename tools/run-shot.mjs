#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  RENDER IT AND LOOK.  ⛔⛔⛔
//
// run-shot.mjs — the flee animation, frame by frame, through the SHIPPED
// portrait draw (`drawBattlePortrait`) driven by the SHIPPED state machine
// timer.
//
// WHY THIS EXISTS
// `run-success` held for ONE FRAME from v1.7.287 to v1.10.83, so the 300 ms
// turn-and-flee never drew a single intermediate frame. Nothing caught it
// because seeing it meant losing a real fight on a phone and watching a HUD
// strip 16 px wide. This renders every frame of both halves side by side, so
// "the animation is gone" is a thing you can look at instead of a thing you
// have to reproduce.
//
//   node tools/run-shot.mjs                 # flee + slide-back, every 2nd frame
//   node tools/run-shot.mjs --job 5         # a different job's portrait
//   node tools/run-shot.mjs --step 1        # every frame
//
// ⛔ The timer is the state machine's own: each column is drawn at the
// `battleSt.battleTimer` the shipped `updateBattleRun` would be showing, so a
// column that is blank here is a column the player never sees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : Number(args[i + 1]); };
const JOB  = flag('--job', 0);
const STEP = flag('--step', 2);

globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} } };

// ⛔ The game boots the AWJ-PATCHED rom (src/main.js). Sprite tiles come from
// the patched image, same as check-battle-hud-fit.mjs.
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));

const { ui } = await import('../src/ui-state.js');
const { battleSt, RUN_SLIDE_MS } = await import('../src/battle-state.js');
const { ps } = await import('../src/player-stats.js');
const { hudSt } = await import('../src/hud-state.js');
const { bsc, initBattleSpriteCache, loadJobBattleSprites } = await import('../src/battle-sprite-cache.js');
const { drawBattlePortrait } = await import('../src/battle-draw-player.js');
const { initHUD } = await import('../src/hud-init.js');
const { initFont } = await import('../src/font-renderer.js');
const { initTextDecoder } = await import('../src/text-decoder.js');
const { drawBattle } = await import('../src/battle-drawing.js');
const { queueBattleMsg, updateBattleMsg, clearBattleMsgQueue } = await import('../src/battle-msg.js');
const { BATTLE_RAN_AWAY, BATTLE_CANT_ESCAPE } = await import('../src/data/strings.js');

initTextDecoder(rom);
initFont(rom);
initHUD(rom);          // ⛔ box art. Without it drawBorderedBox no-ops and every
                       // panel renders as bare text on black — which looks
                       // like a layout bug that isn't there.
initBattleSpriteCache();
loadJobBattleSprites(rom, JOB, 0);
if (!bsc.battlePoses || !bsc.battlePoses.idle) {
  console.error('no portrait for job', JOB, '— nothing to render');
  process.exit(1);
}

// Live enough for the portrait path: not near-fatal, no status, not dead.
ps.hp = 100; ps.stats = { maxHP: 100, agi: 10, str: 5 };
ps.status = { mask: 0 }; ps.jobIdx = JOB; ps.palIdx = 0;
hudSt.playerDeathTimer = null;

// Crop a little wider than the 16x16 portrait slot so the clip edge the
// character runs out through is visible, not just the character.
const SLOT = 16, MARGIN = 8, PAD = 4, LABEL_H = 13, HEAD_H = 14, SCALE = 4;
const PX = 152, PY = 40;                        // HUD_RIGHT_X+8, HUD_VIEW_Y+8
const CROP = SLOT + MARGIN * 2;

/** One row of frames for a state, sampled on the state machine's own clock. */
function row(state, durMs, runSlideBack) {
  const times = [];
  for (let f = 0; f * (1000 / 60) < durMs; f += STEP) times.push(f * (1000 / 60));
  times.push(durMs - 1);                        // the last frame the player sees
  return { state, runSlideBack, times };
}

const ROWS = [
  row('run-success', RUN_SLIDE_MS, false),
  row('encounter-box-close', RUN_SLIDE_MS, true),
];

const cols = Math.max(...ROWS.map(r => r.times.length));
const cellW = CROP * SCALE + PAD;
const rowH = HEAD_H + CROP * SCALE + LABEL_H + PAD;
const sheet = createCanvas(PAD + cols * cellW, PAD + ROWS.length * rowH);
const sc = sheet.getContext('2d');
sc.fillStyle = '#101018';
sc.fillRect(0, 0, sheet.width, sheet.height);

// The portrait draws into the full battle canvas; crop the 16x16 slot out of it.
const frame = createCanvas(256, 224);
ui.ctx = frame.getContext('2d');
ui.ctx.imageSmoothingEnabled = false;
sc.imageSmoothingEnabled = false;

ROWS.forEach((r, ri) => {
  const top = PAD + ri * rowH;
  sc.fillStyle = '#ffd080';
  sc.font = 'bold 11px monospace';
  sc.fillText(r.state + (r.runSlideBack ? '  — slide back into place' : '  — turn and flee'), PAD, top + 10);
  const y = top + HEAD_H;
  r.times.forEach((t, ci) => {
    battleSt.battleState = r.state;
    battleSt.battleTimer = t;
    battleSt.runSlideBack = r.runSlideBack;
    battleSt.battleShakeTimer = 0;
    ui.ctx.fillStyle = '#000';
    ui.ctx.fillRect(0, 0, 256, 224);
    drawBattlePortrait();
    const x = PAD + ci * cellW;
    sc.drawImage(frame, PX - MARGIN, PY - MARGIN, CROP, CROP, x, y, CROP * SCALE, CROP * SCALE);
    // The portrait slot's own edge — what the run pose clips against.
    sc.strokeStyle = '#586078';
    sc.strokeRect(x + MARGIN * SCALE + 0.5, y + MARGIN * SCALE + 0.5, SLOT * SCALE - 1, SLOT * SCALE - 1);
    sc.fillStyle = '#c8c8d8';
    sc.font = '10px monospace';
    sc.fillText(`${Math.round(t)}ms`, x, y + CROP * SCALE + 10);
  });
});

const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'run-anim.png');
fs.writeFileSync(out, sheet.toBuffer('image/png'));
console.log(`run-anim.png  job=${JOB}  ${ROWS.map(r => `${r.state}:${r.times.length}f`).join('  ')}`);
console.log(out);

// ── Whole screen ──────────────────────────────────────────────────────────
// The portrait is only half of it: `run-success` and `run-fail` also swap the
// bottom-left name panel for the wide run box (battle-draw-menu#drawVictoryBox)
// and put a message on the strip. Those were one frame long too, so this pass
// goes through the SHIPPED `drawBattle` composite and shows the screen the
// player now actually gets to read.
battleSt.isRandomEncounter = true;
battleSt.encounterMonsters = [{ hp: 20, maxHP: 20, atk: 5, def: 2, agi: 4, level: 3, monsterId: 0, alive: true }];
battleSt.runSlideBack = false;

const SHOTS = [
  { state: 'run-success', msg: BATTLE_RAN_AWAY,    at: [0, RUN_SLIDE_MS / 2, RUN_SLIDE_MS - 1] },
  { state: 'run-fail',    msg: BATTLE_CANT_ESCAPE, at: [0, 300, 900] },
];
const SW = 256, SH = 224, SS = 2;
const big = createCanvas(PAD + SHOTS[0].at.length * (SW * SS + PAD),
                         PAD + SHOTS.length * (HEAD_H + SH * SS + LABEL_H + PAD));
const bc = big.getContext('2d');
bc.imageSmoothingEnabled = false;
bc.fillStyle = '#101018';
bc.fillRect(0, 0, big.width, big.height);
SHOTS.forEach((shot, ri) => {
  const top = PAD + ri * (HEAD_H + SH * SS + LABEL_H + PAD);
  bc.fillStyle = '#ffd080';
  bc.font = 'bold 11px monospace';
  bc.fillText(shot.state, PAD, top + 10);
  shot.at.forEach((t, ci) => {
    clearBattleMsgQueue();
    queueBattleMsg(shot.msg);
    updateBattleMsg(t);                       // the strip on its own clock
    battleSt.battleState = shot.state;
    battleSt.battleTimer = t;
    ui.ctx.fillStyle = '#000';
    ui.ctx.fillRect(0, 0, SW, SH);
    drawBattle();
    const x = PAD + ci * (SW * SS + PAD);
    bc.drawImage(frame, 0, 0, SW, SH, x, top + HEAD_H, SW * SS, SH * SS);
    bc.fillStyle = '#c8c8d8';
    bc.font = '10px monospace';
    bc.fillText(`${Math.round(t)}ms`, x, top + HEAD_H + SH * SS + 10);
  });
});
const out2 = path.join(outDir, 'run-screen.png');
fs.writeFileSync(out2, big.toBuffer('image/png'));
console.log(out2);
