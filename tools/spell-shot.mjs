#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  RENDER IT AND LOOK.  ⛔⛔⛔
//
// spell-shot.mjs — a spell cast against a FULL FORMATION, frame by frame,
// through the SHIPPED battle draw and the SHIPPED state machine.
//
// WHY THIS EXISTS
// Multi-target magic is the one thing in this battle system that cannot be
// checked by reading the code: the impact walk, the per-target damage numbers
// and the spell animation all run on different clocks, and whether the numbers
// are ever on screen together is a property of how those clocks line up. This
// drives the real `startSpellCast` / `updateBattle` and draws with the real
// `drawBattle` + `drawSWDamageNumbers`, in the order game-loop.js calls them.
//
//   node tools/spell-shot.mjs --spell=0x07 --mode=all     # Quake at everyone
//   node tools/spell-shot.mjs --spell=0x31 --mode=single
//   node tools/spell-shot.mjs --spell=0x07 --mode=all --enemies=4 --step=12
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.findIndex((a) => a.startsWith(`--${n}=`)); return i === -1 ? d : args[i].split('=')[1]; };
const SPELL   = Number(flag('spell', '0x07'));
const MODE    = flag('mode', 'all');
const ENEMIES = Number(flag('enemies', '4'));
const STEP    = Number(flag('step', '10'));      // frames between sampled columns
const FRAMES  = Number(flag('frames', '600'));
const OUT     = flag('out', null);

globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} },
                        // initRoster asks the browser to load the pixel font.
                        fonts: { load: () => Promise.resolve() } };
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

// ⛔ The game boots the AWJ-PATCHED rom (src/main.js applies patches/ff3-awj.ips
// before anything reads a string). Measuring the raw file measures neither the
// right bytes nor the right glyph widths.
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));

const { ui } = await import('../src/ui-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { inputSt } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
const { hudSt } = await import('../src/hud-state.js');
const { initTextDecoder } = await import('../src/text-decoder.js');
const { initFont } = await import('../src/font-renderer.js');
// ⛔ THE SHIPPED INIT, not a hand-picked subset of it. Building only the pieces
// this tool looked like it needed produced a battle with no spell effect drawn
// at all — which reads exactly like "the animation is gone" and is really just
// `initSpellAnim` never having run. A tool that disagrees with the game is
// worse than no tool.
const { initSpriteAssets } = await import('../src/boot.js');
const { loadJobBattleSprites } = await import('../src/battle-sprite-cache.js');
const { drawBattle, drawSWExplosion, drawSWDamageNumbers } = await import('../src/battle-drawing.js');
const { startSpellCast, initSpellCast } = await import('../src/spell-cast.js');
// ⛔ `_processNextTurn` inside spell-cast.js defaults to a NO-OP until this
// runs (src/main.js does it at boot). Without it `_finishMagicHit` fires and
// nothing advances, so every cast sits in `magic-hit` forever — which reads as
// "the spell never ends" and is purely the harness not being wired.
const { processNextTurn } = await import('../src/battle-turn.js');
initSpellCast({ processNextTurn });
const { updateBattle } = await import('../src/battle-update.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { getSwDmgNums, getEnemyDmgNum } = await import('../src/damage-numbers.js');
const { SPELLS } = await import('../src/data/spells.js');
const { getSpellNameShrinesClean } = await import('../src/text-decoder.js');

initTextDecoder(rom); initFont(rom);
initSpriteAssets(rom);
loadJobBattleSprites(rom, 0, 0);
setPlayerSprite({ setDirection() {} });

ps.hp = 500; ps.mp = 99;
ps.stats = { maxHP: 500, maxMP: 99, agi: 10, str: 20, int: 40, mnd: 40, vit: 10 };
ps.status = { mask: 0 }; ps.jobIdx = 0; ps.palIdx = 0; ps.level = 20;
ps.knownSpells = [SPELL];
hudSt.playerDeathTimer = null;

battleSt.isRandomEncounter = true;
battleSt.battleAllies = [];
battleSt.encounterMonsters = Array.from({ length: ENEMIES }, () => ({
  hp: 400, maxHP: 400, atk: 5, def: 2, agi: 4, level: 3, exp: 5, gil: 2, monsterId: 0x00,
}));
battleSt.turnQueue = [];
battleSt.battleState = 'menu-open';
battleSt.battleTimer = 0;
inputSt.targetIndex = 0;

const W = 256, H = 224;
const frame = createCanvas(W, H);
ui.ctx = frame.getContext('2d');
ui.ctx.imageSmoothingEnabled = false;

startSpellCast(SPELL, { enemyIndex: 0, targetMode: MODE });

const DT = 1000 / 60;
const shots = [];
let firstNumAt = null, lastNumAt = null, maxOnScreen = 0;
const seenTargets = new Set();
for (let f = 0; f < FRAMES; f++) {
  updateBattle(DT);
  const nums = Object.keys(getSwDmgNums());
  if (nums.length) {
    if (firstNumAt === null) firstNumAt = f;
    lastNumAt = f;
    nums.forEach((k) => seenTargets.add(k));
    if (nums.length > maxOnScreen) maxOnScreen = nums.length;
  }
  if (f % STEP === 0) {
    ui.ctx.fillStyle = '#000';
    ui.ctx.fillRect(0, 0, W, H);
    drawBattle();
    drawSWExplosion();
    drawSWDamageNumbers();          // ⛔ same order game-loop.js draws them
    const c = createCanvas(W, H);
    c.getContext('2d').drawImage(frame, 0, 0);
    shots.push({ f, c, nums: nums.length, state: battleSt.battleState });
  }
  if (battleSt.battleState === 'none' || battleSt.battleState === 'menu-open') break;
}

const name = (() => { try { return String.fromCharCode(...[]); } catch { return ''; } })();
console.log(`spell 0x${SPELL.toString(16)}  mode=${MODE}  enemies=${ENEMIES}`);
console.log(`  damage numbers: first at frame ${firstNumAt}, last at ${lastNumAt}, ` +
            `MOST ON SCREEN AT ONCE = ${maxOnScreen} of ${ENEMIES}`);
console.log(`  targets that ever showed a number: ${seenTargets.size} of ${ENEMIES}`);
console.log(`  window: ${lastNumAt === null ? 0 : ((lastNumAt - firstNumAt) / 60).toFixed(2)}s`);

const COLS = 6, SCALE = 1, PAD = 3, LABEL = 12;
const rows = Math.ceil(shots.length / COLS);
const sheet = createCanvas(PAD + COLS * (W * SCALE + PAD), PAD + rows * (H * SCALE + LABEL + PAD));
const sc = sheet.getContext('2d');
sc.imageSmoothingEnabled = false;
sc.fillStyle = '#101018'; sc.fillRect(0, 0, sheet.width, sheet.height);
shots.forEach((s, i) => {
  const x = PAD + (i % COLS) * (W * SCALE + PAD);
  const y = PAD + Math.floor(i / COLS) * (H * SCALE + LABEL + PAD);
  sc.drawImage(s.c, x, y, W * SCALE, H * SCALE);
  sc.fillStyle = s.nums ? '#ffd080' : '#8890a0';
  sc.font = '10px monospace';
  sc.fillText(`f${s.f} ${s.state} n=${s.nums}`, x, y + H * SCALE + 10);
});
const out = OUT || path.join(HERE, 'out', `spell-${SPELL.toString(16)}-${MODE}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sheet.toBuffer('image/png'));
console.log(out);
