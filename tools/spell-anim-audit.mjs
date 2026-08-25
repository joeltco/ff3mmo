#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// spell-anim-audit.mjs — does every castable spell actually DRAW something?
//
//   node tools/spell-anim-audit.mjs                 # all 56
//   node tools/spell-anim-audit.mjs --sheet=0x07    # contact sheet for one
//
// WHAT IT MEASURES
// Each spell is cast through the SHIPPED `startSpellCast` + `updateBattle` at a
// four-body formation and every frame is drawn with the SHIPPED `drawBattle` +
// `drawSWDamageNumbers`, in game-loop.js's order. Each frame is diffed against
// a BASELINE frame of the same battle with no spell running, so the monsters,
// the boxes and the menu — which are on screen the whole time — cancel out and
// what is left is the spell.
//
// ⛔ THE BASELINE IS THE WHOLE POINT. Counting lit pixels without it reports a
// healthy pixel count for every spell in the game, because a battle screen is
// never blank. An earlier pass of this arc "found" that no spell drew anything
// at all — that was `initSpriteAssets` never having been called in the harness,
// and a bare pixel count would have hidden it just as effectively.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.findIndex((a) => a.startsWith(`--${n}=`)); return i === -1 ? d : args[i].split('=')[1]; };
const ONLY = flag('sheet', null);

globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} },
                        fonts: { load: () => Promise.resolve() } };
globalThis.requestAnimationFrame = () => 0;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };

const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));

const { ui } = await import('../src/ui-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { ps } = await import('../src/player-stats.js');
const { hudSt } = await import('../src/hud-state.js');
const { initTextDecoder, getSpellNameShrinesClean } = await import('../src/text-decoder.js');
const { initFont } = await import('../src/font-renderer.js');
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
const { getSwDmgNums } = await import('../src/damage-numbers.js');
const { SPELLS, spellHitsAllEnemies, getSpellSchool } = await import('../src/data/spells.js');

initTextDecoder(rom); initFont(rom); initSpriteAssets(rom); loadJobBattleSprites(rom, 0, 0);
setPlayerSprite({ setDirection() {} });

const W = 256, H = 224;
const frame = createCanvas(W, H);
ui.ctx = frame.getContext('2d');
ui.ctx.imageSmoothingEnabled = false;

function seed() {
  ps.hp = 500; ps.mp = 99; ps.status = { mask: 0 }; ps.jobIdx = 0; ps.palIdx = 0; ps.level = 20;
  ps.stats = { maxHP: 500, maxMP: 99, agi: 10, str: 20, int: 40, mnd: 40, vit: 10 };
  hudSt.playerDeathTimer = null;
  battleSt.isRandomEncounter = true;
  battleSt.battleAllies = [];
  battleSt.encounterMonsters = [0, 1, 2, 3].map(() => ({
    hp: 400, maxHP: 400, atk: 5, def: 2, agi: 4, level: 3, exp: 5, gil: 2, monsterId: 0x00 }));
  battleSt.turnQueue = [];
  battleSt.battleState = 'menu-open'; battleSt.battleTimer = 0;
}
function render() {
  ui.ctx.fillStyle = '#000';
  ui.ctx.fillRect(0, 0, W, H);
  drawBattle(); drawSWExplosion(); drawSWDamageNumbers();
  return ui.ctx.getImageData(0, 0, W, H).data;
}
function diffPixels(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

seed();
const baseline = Uint8ClampedArray.from(render());

function audit(spellId, keepShots) {
  seed();
  startSpellCast(spellId, { enemyIndex: 0, targetMode: spellHitsAllEnemies(spellId) ? 'all' : 'single' });
  let castMax = 0, hitMax = 0, frames = 0, numFrames = 0, mostNums = 0;
  const seenNums = new Set();
  const shots = [];
  for (let f = 0; f < 1200; f++) {
    updateBattle(1000 / 60);
    const st = battleSt.battleState;
    if (st === 'none' || st === 'menu-open') break;
    frames++;
    const px = render();
    const d = diffPixels(px, baseline);
    if (st === 'magic-cast') castMax = Math.max(castMax, d);
    else if (st === 'magic-hit') hitMax = Math.max(hitMax, d);
    const nums = Object.keys(getSwDmgNums());
    nums.forEach((k) => seenNums.add(k));
    if (nums.length) { numFrames++; mostNums = Math.max(mostNums, nums.length); }
    if (keepShots && f % keepShots === 0) {
      const c = createCanvas(W, H); c.getContext('2d').drawImage(frame, 0, 0);
      shots.push({ f, c, st, n: nums.length });
    }
  }
  return { castMax, hitMax, frames, numFrames, mostNums, seen: seenNums.size, shots, endState: battleSt.battleState };
}

if (ONLY !== null) {
  const id = Number(ONLY);
  const r = audit(id, 14);
  console.log(`0x${id.toString(16)}  cast=${r.castMax}px  hit=${r.hitMax}px  frames=${r.frames}  nums=${r.seen}`);
  const COLS = 6, PAD = 3, LABEL = 12;
  const rows = Math.ceil(r.shots.length / COLS);
  const sheet = createCanvas(PAD + COLS * (W + PAD), PAD + rows * (H + LABEL + PAD));
  const sc = sheet.getContext('2d');
  sc.imageSmoothingEnabled = false;
  sc.fillStyle = '#101018'; sc.fillRect(0, 0, sheet.width, sheet.height);
  r.shots.forEach((s, i) => {
    const x = PAD + (i % COLS) * (W + PAD), y = PAD + Math.floor(i / COLS) * (H + LABEL + PAD);
    sc.drawImage(s.c, x, y);
    sc.fillStyle = s.n ? '#ffd080' : '#8890a0'; sc.font = '10px monospace';
    sc.fillText(`f${s.f} ${s.st} n=${s.n}`, x, y + H + 10);
  });
  const out = path.join(HERE, 'out', `spell-anim-${id.toString(16)}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, sheet.toBuffer('image/png'));
  console.log(out);
} else {
  const dec = (b) => Array.from(b).map((c) => (c >= 0xCA && c <= 0xE3) ? String.fromCharCode(c - 0xCA + 97)
    : (c >= 0x8A && c <= 0xA3) ? String.fromCharCode(c - 0x8A + 65) : (c === 0xFF ? ' ' : '')).join('').trim();
  const rows = [];
  console.log('id    name        school  castPx  hitPx  frames  bodiesNumbered  mostAtOnce');
  for (let id = 0; id <= 0x37; id++) {
    const r = audit(id, 0);
    const nm = (() => { try { return dec(getSpellNameShrinesClean(id)); } catch { return '?'; } })();
    rows.push({ id, nm, school: getSpellSchool(id), ...r, shots: undefined });
    console.log(`0x${id.toString(16).padStart(2, '0')}  ${nm.padEnd(11)} ${String(getSpellSchool(id)).padEnd(6)}  ` +
      `${String(r.castMax).padStart(6)}  ${String(r.hitMax).padStart(5)}  ${String(r.frames).padStart(6)}  ` +
      `${String(r.seen).padStart(14)}  ${String(r.mostNums).padStart(10)}  ${r.endState}`);
  }
  fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'out', 'spell-anim-audit.json'), JSON.stringify(rows, null, 2));
  // ── Gate ────────────────────────────────────────────────────────────────
  // Runs in deploy.sh. Three ways a spell can be broken and look fine in code:
  const noCast = rows.filter((r) => r.castMax === 0);
  const noHit  = rows.filter((r) => r.hitMax === 0);
  // ⛔ A cast that never returns to the menu is a soft-locked battle. It is
  // also exactly what an unwired harness looks like — `_processNextTurn` in
  // spell-cast.js is a NO-OP until `initSpellCast` runs — so this assertion
  // guards the tool as much as the game.
  // ⛔ NOT "ends at menu-open". Raze kills a four-goblin formation outright and
  // ends in `exp-hold` — the victory sequence — which is the battle being WON,
  // not a stall. The real assertion is that the cast handed control onward:
  // whatever it ends in, it is no longer a magic-* state.
  const stuck = rows.filter((r) => String(r.endState).startsWith('magic-'));
  console.log(`\n${rows.length} castable spells audited`);
  console.log(`  draw NOTHING during magic-cast: ${noCast.length}${noCast.length ? ' -> ' + noCast.map((r) => '0x' + r.id.toString(16)).join(' ') : ''}`);
  console.log(`  draw NOTHING during magic-hit:  ${noHit.length}${noHit.length ? ' -> ' + noHit.map((r) => '0x' + r.id.toString(16)).join(' ') : ''}`);
  console.log(`  never hand the turn back:       ${stuck.length}${stuck.length ? ' -> ' + stuck.map((r) => '0x' + r.id.toString(16) + '(' + r.endState + ')').join(' ') : ''}`);
  // The three auto-all spells must still put a number on every body at once.
  const autoAll = rows.filter((r) => spellHitsAllEnemies(r.id));
  const badAll = autoAll.filter((r) => r.seen !== 4 || r.mostNums !== 4);
  console.log(`  auto-all spells numbering all 4 bodies at once: ${autoAll.length - badAll.length}/${autoAll.length}`);
  const fails = noCast.length + noHit.length + stuck.length + badAll.length + (autoAll.length === 3 ? 0 : 1);
  console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — spell animation audit`);
  process.exit(fails === 0 ? 0 : 1);
}
