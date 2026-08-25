#!/usr/bin/env node
// check-summon-cast.mjs — the summon cast burst is drawn ON THE CASTER.
//
//   node tools/check-summon-cast.mjs
//
// WHAT THIS PROTECTS
// Every other spell's cast visual is anchored to the caster's portrait via
// `drawCastWindup(..., px + 8, py + 8)`. Summons were the one exception: the
// captured 256x144 band was blitted at the VIEWPORT ORIGIN, which faithfully
// reproduces the NES screen — where the party stands at roughly x 176-190 — and
// this game does not put its caster there. Measured before the fix: the burst
// sat at screen (184, 85) while the player portrait is at (160, 48), so it
// floated ~24px right and ~37px below the person casting it, over the roster
// rows. Identical for all eight, because they share the summon school's cast
// animation ($55810).
//
// ⛔ THE WHOLE BAND MOVES, IT IS NOT CROPPED. Only the opening orb is small
// (14x14). From frame 9 the burst throws four shards that keep expanding —
// union across all 30 frames is 94x89. An earlier plan in this arc was to crop
// the orb and blit that on the portrait; it would have deleted every shard.
// Section 2 pins the expansion so that idea cannot come back silently.
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
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));

const { ui } = await import('../src/ui-state.js');
const { battleSt } = await import('../src/battle-state.js');
const { ps } = await import('../src/player-stats.js');
const { hudSt } = await import('../src/hud-state.js');
const { initTextDecoder } = await import('../src/text-decoder.js');
const { initFont } = await import('../src/font-renderer.js');
const { initSpriteAssets } = await import('../src/boot.js');
const { loadJobBattleSprites } = await import('../src/battle-sprite-cache.js');
const { drawBattle, drawBattleAllies } = await import('../src/battle-drawing.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { casterPortraitCentre } = await import('../src/battle-grid.js');
const { getSummon, summonCastCentre } = await import('../src/summon-anim.js');
const { CAPTURED_SUMMONS, SUMMON_SRC_H } = await import('../src/data/summon-anim-captured.js');
const { SUMMON_TIERS } = await import('../src/data/summon-tiers.js');

initTextDecoder(rom); initFont(rom); initSpriteAssets(rom);
loadJobBattleSprites(rom, 0, 0); setPlayerSprite({ setDirection() {} });

const W = 256, H = 224;
const frame = createCanvas(W, H);
ui.ctx = frame.getContext('2d');
ui.ctx.imageSmoothingEnabled = false;

function seed() {
  ps.hp = 500; ps.mp = 99; ps.status = { mask: 0 }; ps.jobIdx = 0; ps.palIdx = 0; ps.level = 20;
  ps.stats = { maxHP: 500, maxMP: 99, agi: 10, str: 20, int: 40, mnd: 40, vit: 10 };
  hudSt.playerDeathTimer = null;
  battleSt.isRandomEncounter = true;
  battleSt.encounterMonsters = [0, 1].map(() => ({ hp: 900, maxHP: 900, atk: 5, def: 2, agi: 4, level: 3, exp: 5, gil: 2, monsterId: 0 }));
  battleSt.battleAllies = [0, 1].map((i) => ({ name: 'A' + i, hp: 100, maxHP: 100, jobIdx: 0, palIdx: i + 1,
    agi: 5, int: 20, mnd: 20, knownSpells: [], fadeStep: 0, status: { mask: 0 } }));
}
/** ⛔ game-loop.js draws allies BEFORE drawBattle. Reversing it paints the
 *  roster over the burst and reads as "nothing is drawn". */
function render() {
  ui.ctx.fillStyle = '#000'; ui.ctx.fillRect(0, 0, W, H);
  if (battleSt.battleAllies.length) drawBattleAllies();
  drawBattle();
  return ui.ctx.getImageData(0, 0, W, H).data;
}
/** Bounding box of what the cast ADDS to the scene — diffed against the same
 *  scene with no cast running, so the portraits and boxes cancel out. */
function burstBox(setState, spellId, t) {
  // ⛔ THE BASELINE IS THE SAME STATE WITH THE BURST FINISHED, not the menu.
  // `summonCastFrameAt` returns null past the animation's 1026 ms, so a timer
  // of 9999 gives a byte-identical scene minus the burst. Diffing against
  // `menu-open` instead also catches the action menu, the name box and the
  // message strip, and the bounding box lands on all of that — measured
  // (139, 121) for a burst that is visibly on the portrait at (160, 48).
  seed();
  setState(spellId, 9999);
  const base = Uint8ClampedArray.from(render());
  seed();
  setState(spellId, t);
  const cur = render();
  let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (base[i] !== cur[i] || base[i + 1] !== cur[i + 1] || base[i + 2] !== cur[i + 2]) {
      n++; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  return n ? { minx, miny, maxx, maxy, n, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 } : null;
}

// ── 1. The burst tracks the caster, per role ───────────────────────────────
console.log('\n[1] the cast burst is centred on whoever is casting');
{
  const ORB_T = 30;   // inside frame 0 — the tight opening orb
  const cases = [
    ['player', 0, (id, t) => { battleSt.battleState = 'magic-cast'; battleSt.battleTimer = t;
                               battleSt._testSpell = id; }],
  ];
  // Player path reads getCurrentSpellId(); drive it through the real cast.
  const { startSpellCast, initSpellCast } = await import('../src/spell-cast.js');
  const { processNextTurn } = await import('../src/battle-turn.js');
  initSpellCast({ processNextTurn });

  const playerBox = burstBox((id, t) => {
    startSpellCast(id, { enemyIndex: 0, targetMode: 'single' });
    battleSt.battleState = 'magic-cast'; battleSt.battleTimer = t;
  }, 0x30, ORB_T);
  const pc = casterPortraitCentre('player');
  if (ok(!!playerBox, 'the player cast draws something')) {
    ok(Math.abs(playerBox.cx - pc.x) <= 3 && Math.abs(playerBox.cy - pc.y) <= 3,
       `player burst centre (${playerBox.cx}, ${playerBox.cy}) sits on the portrait (${pc.x}, ${pc.y})`);
  }

  for (const idx of [0, 1]) {
    const b = burstBox((id, t) => {
      battleSt.allyMagicSpellId = id; battleSt.allyMagicCasterIdx = idx;
      battleSt.battleState = 'ally-magic-cast'; battleSt.battleTimer = t;
    }, 0x30, ORB_T);
    const c = casterPortraitCentre('ally', idx);
    if (ok(!!b, `ally ${idx} cast draws something`)) {
      ok(Math.abs(b.cx - c.x) <= 3 && Math.abs(b.cy - c.y) <= 3,
         `ally ${idx} burst centre (${b.cx}, ${b.cy}) sits on its own row (${c.x}, ${c.y})`);
    }
  }
  // ⛔ The whole point of routing by role: two casters must NOT share a centre.
  const a0 = casterPortraitCentre('ally', 0), a1 = casterPortraitCentre('ally', 1);
  ok(a0.y !== a1.y && pc.y !== a0.y, 'player and each ally resolve to DIFFERENT centres');
}

// ── 2. The band is translated, never cropped ───────────────────────────────
console.log('\n[2] the expansion survives — the band moves whole');
{
  const s = getSummon(0x30);
  const band = createCanvas(256, 144);
  const bg = band.getContext('2d');
  const extent = (fr) => {
    bg.clearRect(0, 0, 256, 144); bg.drawImage(fr, 0, 0);
    const d = bg.getImageData(0, 0, 256, 144).data;
    let a = 1e9, b = 1e9, x2 = -1, y2 = -1;
    for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      if (d[i + 3] > 0 && (d[i] | d[i + 1] | d[i + 2])) { if (x < a) a = x; if (x > x2) x2 = x; if (y < b) b = y; if (y > y2) y2 = y; }
    }
    return x2 < 0 ? null : { w: x2 - a + 1, h: y2 - b + 1 };
  };
  const first = extent(s.cast.frames[0]);
  const last = extent(s.cast.frames[s.cast.frames.length - 1]);
  ok(first && first.w <= 20 && first.h <= 20, `the opening orb is small (${first.w}x${first.h})`);
  ok(last && last.w > 60 && last.h > 60,
     `the final frame has expanded far past it (${last.w}x${last.h}) — a crop to the orb would delete the shards`);

  // Rendered on screen, the LAST frame must still be much wider than the orb.
  const lastT = s.cast.holds.reduce((a, c) => a + c, 0) - 10;
  const { startSpellCast } = await import('../src/spell-cast.js');
  const wide = burstBox((id, t) => {
    startSpellCast(id, { enemyIndex: 0, targetMode: 'single' });
    battleSt.battleState = 'magic-cast'; battleSt.battleTimer = t;
  }, 0x30, lastT);
  ok(wide && (wide.maxx - wide.minx) > 40,
     `on screen the late burst still spans ${wide ? wide.maxx - wide.minx : 0}px wide`);
}

// ── 3. The centre is DERIVED, not a literal ────────────────────────────────
console.log('\n[3] the burst centre comes from the capture');
{
  for (const id of SUMMON_TIERS.keys()) {
    const c = summonCastCentre(id);
    if (!c) { ok(false, `0x${id.toString(16)} has a cast centre`); continue; }
  }
  const c = summonCastCentre(0x30);
  const box = CAPTURED_SUMMONS.get(0x30).cast.box;
  const wantX = (box.x0 + box.x1) / 2;
  const wantY = ((box.y0 + box.y1) / 2) * (144 / SUMMON_SRC_H);
  ok(Math.abs(c.x - wantX) < 0.01 && Math.abs(c.y - wantY) < 0.01,
     `summonCastCentre matches the capture box through the band squeeze (${c.x}, ${c.y.toFixed(1)})`);
  // ⛔ y MUST go through the squeeze. Skipping it lands ~3px off.
  ok(Math.abs(c.y - (box.y0 + box.y1) / 2) > 1,
     'the y is squeezed by BAND_H/SUMMON_SRC_H, not used raw');
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'battle-drawing.js'), 'utf8');
  ok(/casterPortraitCentre\(role, casterIdx\)/.test(src), 'the draw resolves the caster by ROLE, not a fixed offset');
  ok(!/drawImage\(cf, HUD_VIEW_X, HUD_VIEW_Y\)/.test(src),
     'the cast band is no longer blitted at the viewport origin');
  const grid = fs.readFileSync(path.join(HERE, '..', 'src', 'battle-grid.js'), 'utf8');
  ok(/export function casterPortraitCentre/.test(grid), 'casterPortraitCentre is shared from battle-grid.js');
}

console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
