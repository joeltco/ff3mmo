// combatant-sprites.js — single source of truth for combatant pose tiles + canvas rendering.
//
// Until now the player, ally, and opponent each had their own builders that decided which
// tiles to use for "rBack", "lFwd", etc. That meant adding/fixing a pose required patching
// 5 different builders or it would silently diverge (e.g. ally Monk lFwd showing L-back tiles).
//
// This module replaces all of those: one `getJobPoseTileBundle(rom, jobIdx)` returns the
// canonical tile assignments for any job (PPU-captured for OK/Warrior/Monk, ROM-read with
// documented tile-index convention for jobs 3-21). Three thin renderers consume it:
//   • buildPlayerPoseCanvases  — player path (one palette → one canvas per pose)
//   • buildAllyPosePortraits   — ally portrait path (palette array → per-palette canvas array)
//   • buildOpponentBodyCanvases — opponent full-body path (palette array → 16×24 with legs)

import { decodeTile } from './tile-decoder.js';
import { PLAYER_PALETTES, MONK_PALETTES, BLACK_MAGE_PALETTES, ROSTER_FADE_STEPS } from './data/players.js';
import { BATTLE_SPRITE_ROM, BATTLE_JOB_SIZE } from './data/jobs.js';
import { nesColorFade } from './palette.js';
import {
  OK_IDLE, OK_VICTORY, OK_L_BACK_SWING, OK_L_FWD_T2, OK_L_FWD_T3,
  OK_R_BACK_SWING, OK_R_FWD_T2, OK_KNEEL,
  OK_LEG_L_IDLE, OK_LEG_R_IDLE,
  OK_LEG_L_BACK_L, OK_LEG_R_BACK_L,
  OK_LEG_L_FWD_L, OK_LEG_R_FWD_L,
  OK_LEG_L_BACK_R, OK_LEG_L_FWD_R,
  OK_LEG_R_SWING,
  OK_LEG_L_KNEEL, OK_LEG_R_KNEEL,
  OK_LEG_L_VICTORY, OK_LEG_R_VICTORY,
} from './data/job-sprites.js';
import {
  WR_IDLE, WR_LEG_L, WR_LEG_R, WR_L_BACK, WR_LEG_L_BACK_L, WR_LEG_R_BACK_L,
  WR_LEG_L_FWD_L, WR_LEG_R_FWD_L, WR_LEG_L_BACK_R, WR_LEG_R_SWING,
  WR_LEG_L_FWD_R, WR_LEG_L_HIT, WR_LEG_R_HIT, WR_LEG_L_KNEEL, WR_LEG_R_KNEEL,
  WR_LEG_L_VICTORY, WR_LEG_R_VICTORY, WR_R_BACK_T2, WR_HIT, WR_VICTORY,
  WR_L_FWD_T2, WR_L_FWD_T3, WR_KNEEL,
} from './data/warrior-sprites.js';
import {
  MO_IDLE, MO_LEG_L, MO_LEG_R, MO_R_BACK_T2, MO_LEG_L_BACK_R, MO_LEG_R_BACK_R,
  MO_LEG_L_FWD_R, MO_L_BACK_T1, MO_L_BACK_T3, MO_L_FWD_T2, MO_L_FWD_T3,
  MO_HIT, MO_LEG_R_HIT, MO_VICTORY, MO_LEG_L_VICTORY, MO_LEG_R_VICTORY,
  MO_KNEEL, MO_LEG_L_KNEEL, MO_LEG_R_KNEEL,
} from './data/monk-sprites.js';

// ── Bundle definitions ────────────────────────────────────────────────────────

const d = (raw) => decodeTile(raw, 0);

// Death tiles for any job: 6 tiles (3 cols × 2 rows, 24×16 prone) at
// jobBase + 0x240 within the per-job battle CHR slot. Verified byte-for-byte
// against PPU-captured OK/WR/MO_DEATH (those constants were removed once the
// stride was confirmed for all 22 jobs — see CHANGELOG 1.7.47).
function _deathTilesForJob(romData, jobIdx) {
  const jobBase = BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE;
  const t = (idx) => decodeTile(romData, jobBase + idx * 16);
  return { tiles: [t(36), t(37), t(38), t(39), t(40), t(41)], cols: 3 };
}

// Canonical pose keys. Adding a new pose? Add it here, populate it in every job bundle below,
// and add it to the renderers — and that's it. No more "we forgot to add it to ally/opponent."
export const POSE_KEYS = [
  'idle', 'rBack', 'lBack', 'rFwd', 'lFwd',
  'knifeR', 'knifeL', 'knifeRFwd', 'knifeLFwd',
  'victory', 'hit', 'kneel',
];

function _okBundle(romData) {
  const jobBase = BATTLE_SPRITE_ROM + 0 * BATTLE_JOB_SIZE; // OK = job 0
  const idle    = OK_IDLE.map(d);
  const victory = OK_VICTORY.map(d);
  const kneel   = OK_KNEEL.map(d);
  const hitTiles = [0,1,2,3].map(i => decodeTile(romData, jobBase + (30 + i) * 16));
  const hitLegL  = decodeTile(romData, jobBase + 34 * 16);
  const hitLegR  = decodeTile(romData, jobBase + 35 * 16);
  // R-back: idle body with R-arm tile overlaid in body-TL slot (OAM-canonical: only one tile changes).
  const rBack = [idle[0], idle[1], d(OK_R_BACK_SWING[2]), idle[3]];
  // L-back: idle body with L-back head-TR + body-TR variants.
  const lBack = [idle[0], d(OK_L_BACK_SWING[1]), idle[2], d(OK_L_BACK_SWING[3])];
  // R-fwd: idle body (NES had nothing distinct here; legs animate but body stays neutral).
  const rFwd  = [idle[0], idle[1], d(OK_R_FWD_T2), idle[3]];
  // L-fwd: idle body with L-fwd body-TL + body-TR.
  const lFwd  = [idle[0], idle[1], d(OK_L_FWD_T2), d(OK_L_FWD_T3)];
  // Knife back/fwd reuse the back-swing tiles; opponent gets back-leg legs vs fwd-leg legs.
  const knifeR = OK_R_BACK_SWING.map(d);
  const knifeL = OK_L_BACK_SWING.map(d);
  return {
    bodies: {
      idle, rBack, lBack, rFwd, lFwd,
      knifeR, knifeL,
      knifeRFwd: rFwd,                                      // knife forward strike → idle body
      knifeLFwd: lFwd,                                      // (canonical L-fwd body)
      victory, hit: hitTiles, kneel,
    },
    legs: {
      idle:    { L: d(OK_LEG_L_IDLE),    R: d(OK_LEG_R_IDLE)    },
      rBack:   { L: d(OK_LEG_L_BACK_R),  R: d(OK_LEG_R_SWING)   },
      lBack:   { L: d(OK_LEG_L_BACK_L),  R: d(OK_LEG_R_BACK_L)  },
      rFwd:    { L: d(OK_LEG_L_FWD_R),   R: d(OK_LEG_R_SWING)   },
      lFwd:    { L: d(OK_LEG_L_FWD_L),   R: d(OK_LEG_R_FWD_L)   },
      knifeR:  { L: d(OK_LEG_L_BACK_R),  R: d(OK_LEG_R_SWING)   },
      knifeL:  { L: d(OK_LEG_L_BACK_L),  R: d(OK_LEG_R_BACK_L)  },
      knifeRFwd:{ L: d(OK_LEG_L_FWD_R),  R: d(OK_LEG_R_SWING)   },
      knifeLFwd:{ L: d(OK_LEG_L_FWD_L),  R: d(OK_LEG_R_FWD_L)   },
      victory: { L: d(OK_LEG_L_VICTORY), R: d(OK_LEG_R_VICTORY) },
      hit:     { L: hitLegL,             R: hitLegR             },
      kneel:   { L: d(OK_LEG_L_KNEEL),   R: d(OK_LEG_R_KNEEL)   },
    },
    palettes: PLAYER_PALETTES,
    death: _deathTilesForJob(romData, 0),
  };
}

function _warriorBundle(romData) {
  const idle    = WR_IDLE.map(d);
  const victory = WR_VICTORY.map(d);
  const hit     = WR_HIT.map(d);
  const kneel   = WR_KNEEL.map(d);
  const rBack   = [idle[0], idle[1], d(WR_R_BACK_T2), idle[3]];
  const lBack   = [idle[0], d(WR_L_BACK[1]), idle[2], d(WR_L_BACK[3])];
  const rFwd    = idle; // Warrior R-fwd reuses idle body
  const lFwd    = [idle[0], idle[1], d(WR_L_FWD_T2), d(WR_L_FWD_T3)];
  return {
    bodies: {
      idle, rBack, lBack, rFwd, lFwd,
      knifeR: rBack, knifeL: lBack,
      knifeRFwd: rFwd, knifeLFwd: lFwd,
      victory, hit, kneel,
    },
    legs: {
      idle:    { L: d(WR_LEG_L),         R: d(WR_LEG_R)         },
      rBack:   { L: d(WR_LEG_L_BACK_R),  R: d(WR_LEG_R_SWING)   },
      lBack:   { L: d(WR_LEG_L_BACK_L),  R: d(WR_LEG_R_BACK_L)  },
      rFwd:    { L: d(WR_LEG_L_FWD_R),   R: d(WR_LEG_R_SWING)   },
      lFwd:    { L: d(WR_LEG_L_FWD_L),   R: d(WR_LEG_R_FWD_L)   },
      knifeR:  { L: d(WR_LEG_L_BACK_R),  R: d(WR_LEG_R_SWING)   },
      knifeL:  { L: d(WR_LEG_L_BACK_L),  R: d(WR_LEG_R_BACK_L)  },
      knifeRFwd:{ L: d(WR_LEG_L_FWD_R),  R: d(WR_LEG_R_SWING)   },
      knifeLFwd:{ L: d(WR_LEG_L_FWD_L),  R: d(WR_LEG_R_FWD_L)   },
      victory: { L: d(WR_LEG_L_VICTORY), R: d(WR_LEG_R_VICTORY) },
      hit:     { L: d(WR_LEG_L_HIT),     R: d(WR_LEG_R_HIT)     },
      kneel:   { L: d(WR_LEG_L_KNEEL),   R: d(WR_LEG_R_KNEEL)   },
    },
    palettes: PLAYER_PALETTES,
    death: _deathTilesForJob(romData, 1),
  };
}

function _monkBundle(romData) {
  const idle    = MO_IDLE.map(d);
  const victory = MO_VICTORY.map(d);
  const hit     = MO_HIT.map(d);
  const kneel   = MO_KNEEL.map(d);
  // Monk OAM: R-strike body = MO_R_BACK_T2; L-strike body = MO_L_FWD_T2/T3 (not L-back, that's nunchuck).
  const rBack   = [idle[0], idle[1], d(MO_R_BACK_T2), idle[3]];
  const lBack   = [idle[0], d(MO_L_BACK_T1), idle[2], d(MO_L_BACK_T3)];
  const rFwd    = idle;
  const lFwd    = [idle[0], idle[1], d(MO_L_FWD_T2), d(MO_L_FWD_T3)];
  // Monk leg sharing (per existing _buildMonkFullBodies):
  const legL_back_R = d(MO_LEG_L_BACK_R);
  const legR_back_R = d(MO_LEG_R_BACK_R);
  const legL_fwd_R  = d(MO_LEG_L_FWD_R);
  return {
    bodies: {
      idle, rBack, lBack, rFwd, lFwd,
      knifeR: rBack, knifeL: lBack,
      knifeRFwd: rFwd, knifeLFwd: lFwd,
      victory, hit, kneel,
    },
    legs: {
      idle:    { L: d(MO_LEG_L), R: d(MO_LEG_R) },
      rBack:   { L: legL_back_R, R: legR_back_R },
      lBack:   { L: legL_fwd_R,  R: legR_back_R },   // L-back legs == R-fwd L-leg / R-leg swing
      rFwd:    { L: legL_fwd_R,  R: legR_back_R },
      lFwd:    { L: legL_fwd_R,  R: legR_back_R },   // L-fwd legs same bytes
      knifeR:  { L: legL_back_R, R: legR_back_R },
      knifeL:  { L: legL_fwd_R,  R: legR_back_R },
      knifeRFwd:{ L: legL_fwd_R, R: legR_back_R },
      knifeLFwd:{ L: legL_fwd_R, R: legR_back_R },
      victory: { L: d(MO_LEG_L_VICTORY), R: d(MO_LEG_R_VICTORY) },
      hit:     { L: legL_fwd_R,          R: d(MO_LEG_R_HIT)     }, // hit leg L bytes identical to MO_LEG_L_FWD_R
      kneel:   { L: d(MO_LEG_L_KNEEL),   R: d(MO_LEG_R_KNEEL)   },
    },
    palettes: MONK_PALETTES,
    death: _deathTilesForJob(romData, 2),
  };
}

// Generic ROM-read bundle for jobs 3-21. Canonical FF3 per-job battle sprite tile layout
// (verified by reverse-mapping PPU-captured OK + Monk bytes back to ROM tile-indices —
// the layout is uniform across jobs; Warrior is the one known outlier on kneel TL/TR):
//   0-3   idle body (TL, TR, BL, BR)
//   4-5   idle legs L/R
//   6-7   R-fwd legs L/R
//   8-9   kneel body TL, TR (head bowed)
//   10-11 kneel body BL, BR
//   12-13 kneel legs L/R
//   14    R-back body-TL (R-arm overlay)
//   15    R-back legL (legR shares tile 7)
//   16-17 L-fwd body-TL, body-TR
//   18-19 L-fwd legs L/R
//   20-21 L-back head-TR, body-TR
//   22-23 L-back legs L/R
//   24-27 victory/defend body
//   28-29 victory legs L/R
//   30-33 hit body
//   34-35 hit legs L/R
//   36-41 death (24×16 prone, 3 cols × 2 rows) — same stride as OK/WR/MO_DEATH
function _genericBundle(romData, jobIdx) {
  const jobBase = BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE;
  const t = (idx) => decodeTile(romData, jobBase + idx * 16);
  const idle    = [t(0), t(1), t(2), t(3)];
  const victory = [t(24), t(25), t(26), t(27)];
  const hit     = [t(30), t(31), t(32), t(33)];
  const kneel   = [t(8), t(9), t(10), t(11)];
  const rBack   = [t(0), t(1),  t(14), t(3)];
  const lBack   = [t(0), t(20), t(2),  t(21)];
  const rFwd    = [t(0), t(1),  t(2),  t(3)];   // body unchanged on R-fwd; only legs animate
  const lFwd    = [t(0), t(1),  t(16), t(17)];
  return {
    bodies: {
      idle, rBack, lBack, rFwd, lFwd,
      knifeR: rBack, knifeL: lBack,
      knifeRFwd: rFwd, knifeLFwd: lFwd,
      victory, hit, kneel,
    },
    legs: {
      idle:     { L: t(4),  R: t(5)  },
      rBack:    { L: t(15), R: t(7)  },
      lBack:    { L: t(22), R: t(23) },
      rFwd:     { L: t(6),  R: t(7)  },
      lFwd:     { L: t(18), R: t(19) },
      knifeR:   { L: t(15), R: t(7)  },
      knifeL:   { L: t(22), R: t(23) },
      knifeRFwd:{ L: t(6),  R: t(7)  },
      knifeLFwd:{ L: t(18), R: t(19) },
      victory:  { L: t(28), R: t(29) },
      hit:      { L: t(34), R: t(35) },
      kneel:    { L: t(12), R: t(13) },
    },
    palettes: jobIdx === 4 ? BLACK_MAGE_PALETTES : PLAYER_PALETTES,
    death: _deathTilesForJob(romData, jobIdx),
  };
}

export function getJobPoseTileBundle(romData, jobIdx) {
  if (jobIdx === 0) return _okBundle(romData);
  if (jobIdx === 1) return _warriorBundle(romData);
  if (jobIdx === 2) return _monkBundle(romData);
  return _genericBundle(romData, jobIdx);
}

// ── Renderers ─────────────────────────────────────────────────────────────────

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';

function _blitTileAt(ctx, pixels, palette, x, y) {
  const img = ctx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = pixels[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
    const rgb = NES_SYSTEM_PALETTE[palette[ci]] || [0, 0, 0];
    img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1]; img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

function _renderPortrait(bodyTiles, palette) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const cx = c.getContext('2d');
  _blitTileAt(cx, bodyTiles[0], palette, 0, 0);
  _blitTileAt(cx, bodyTiles[1], palette, 8, 0);
  _blitTileAt(cx, bodyTiles[2], palette, 0, 8);
  _blitTileAt(cx, bodyTiles[3], palette, 8, 8);
  return c;
}

function _renderFullBody(bodyTiles, legL, legR, palette) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 24;
  const cx = c.getContext('2d');
  _blitTileAt(cx, bodyTiles[0], palette, 0, 0);
  _blitTileAt(cx, bodyTiles[1], palette, 8, 0);
  _blitTileAt(cx, bodyTiles[2], palette, 0, 8);
  _blitTileAt(cx, bodyTiles[3], palette, 8, 8);
  _blitTileAt(cx, legL, palette, 0, 16);
  _blitTileAt(cx, legR, palette, 8, 16);
  // Opponent canvas faces opposite direction from player — pre-h-flipped here so the
  // PVP renderer can drawImage() it directly without a transform. Legacy parity with
  // _buildFullBody16x24Canvas in sprite-init.js (which Monk still uses).
  const fl = document.createElement('canvas'); fl.width = 16; fl.height = 24;
  const flctx = fl.getContext('2d');
  flctx.translate(16, 0); flctx.scale(-1, 1); flctx.drawImage(c, 0, 0);
  return fl;
}

// Player path: one palette → one canvas per pose key.
// Returns { idle, rBack, lBack, rFwd, lFwd, knifeR, knifeL, knifeRFwd, knifeLFwd, victory, hit, kneel, palette }.
export function buildPlayerPoseCanvases(bundle, palette) {
  const out = { palette };
  for (const key of POSE_KEYS) out[key] = _renderPortrait(bundle.bodies[key], palette);
  return out;
}

// Ally portrait path: palette array → per-palette ARRAY OF FADE-STEP canvases per pose key.
// Returns { idle: [palIdx → [fadeStep → canvas]], … }. Fade-step variants are required by roster
// rendering and the title-screen save-slot list (legacy _genPosePortraits behavior).
export function buildAllyPosePortraits(bundle) {
  const out = {};
  for (const key of POSE_KEYS) {
    out[key] = bundle.palettes.map(basePal => {
      const frames = [];
      for (let step = 0; step <= ROSTER_FADE_STEPS; step++) {
        let pal = [...basePal];
        for (let s = 0; s < step; s++) pal = pal.map(c => nesColorFade(c));
        frames.push(_renderPortrait(bundle.bodies[key], pal));
      }
      return frames;
    });
  }
  return out;
}

// Opponent full-body path: palette array → 16×24 canvas with legs per pose key.
// Returns { idle:[c,c,…], rBack:[c,c,…], … } indexed by pose key, each value is an array indexed by palIdx.
export function buildOpponentBodyCanvases(bundle) {
  const out = {};
  for (const key of POSE_KEYS) {
    const legs = bundle.legs[key] || bundle.legs.idle;
    out[key] = bundle.palettes.map(pal => _renderFullBody(bundle.bodies[key], legs.L, legs.R, pal));
  }
  return out;
}

// Death pose (24×16 prone sprite, 6 tiles in a 3×2 grid). Optional — generic jobs have no
// PPU-captured death and fall back to a flipped idle body in the caller.
export function buildDeathPoseCanvases(bundle) {
  if (!bundle.death) return null;
  const { tiles, cols } = bundle.death;
  return bundle.palettes.map(pal => {
    const c = document.createElement('canvas'); c.width = 8 * cols; c.height = 16;
    const cx = c.getContext('2d');
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < cols; col++)
        _blitTileAt(cx, tiles[row * cols + col], pal, col * 8, row * 8);
    return c;
  });
}
