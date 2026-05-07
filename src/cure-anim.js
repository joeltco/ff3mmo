// Cure spell animation — captured from FF3 NES via EMU tab REC OAM (100 frames).
//
// White-magic spells share the same tile sequence ($4A-$57 build-up flame,
// $49 stars, $4A/$49 heal-phase) but DIFFERENT SP3 palettes per school —
// confirmed by REC OAM of Poisona vs. Cure (2026-05-05): tile bytes byte-
// identical, palette differs:
//   recovery (Cure family)      — [0x0F, 0x12, 0x22, 0x31] blue / cyan / white
//   cure_status (Poisona/Bndna) — [0x0F, 0x15, 0x27, 0x30] magenta / orange / white
//   revive (Raise)              — placeholder; same as cure_status until captured
// Tile canvases are pre-decoded once per palette at init; render path picks
// the right asset bundle by spell via `getCureAnimAssets(spell)`.
//
// Vocabulary (the user's; pin it here so future-me doesn't drift):
//   "flame"       — pulsing 4-size sprite drawn LEFT of the player; tiles $4A
//                   (size 1) → $4B-$4E (size 2) → $4F-$52 (size 3) → $53-$56
//                   (size 4) → $57 brackets (release flash).
//   "stars"       — 8 rotating $49 tiles forming a ring around the player.
//   "heal sparkle" — ONE 16×16 ($4A + $49 after CHR rebank) drawn on whoever
//                   the spell is healing. NOT the same thing as the stars.
//
// The captured animation has 5 phases (60 Hz NES → ms):
//   build-up (f0-47, 800ms)  — flame pulses 4 sizes + stars rotate around player
//   lunge    (f48-59, 200ms) — caster slides; in our 16×16 portrait we hold
//   cast     (f60-72, 217ms) — body swap (engine's existing item-use pose)
//   heal     (f73-89, 283ms) — heal sparkle on target ($4A + $49 after CHR rebank)
//   return   (f90-99, 167ms) — caster slides further, anim ends
//
// Tiles $4A and $49 mean different pixels in the build-up vs. heal phases due
// to MMC3 CHR bank switching. Both byte sets are captured here.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';
import { ITEMS } from './data/items.js';
import { SPELLS } from './data/spells.js';

// Per-school cast palette. The shared $4A-$57 flame buildup gets palette-
// swapped per school — same tile shapes, different colors. Originally white-
// magic only; now also covers BM cast (Fire 2026-05-07) and is conceptually
// SCHOOL_PAL despite the legacy name. Add a key when capturing a new school.
const WHITE_MAGIC_PAL = {
  recovery:    [0x0F, 0x12, 0x22, 0x31],  // Cure family — blue / cyan / white
  cure_status: [0x0F, 0x15, 0x27, 0x30],  // Poisona / Bndna / Esuna / Stone — magenta / orange / white (REC OAM 2026-05-05)
  revive:      [0x0F, 0x15, 0x27, 0x30],  // Arise / Raise — placeholder; same as cure_status until captured
  sight:       [0x0F, 0x29, 0x31, 0x30],  // Sight — green / light cyan / white (REC OAM 2026-05-07)
  fire:        [0x0F, 0x16, 0x27, 0x30],  // Fire (BM Lv1) — red / orange / white (REC OAM 2026-05-07 f9627)
};

// ── Build-up phase tiles ($4A-$57 flame + $49 small star) ──────────────────

const T_4A = new Uint8Array([0x00,0x00,0x00,0x00,0x03,0x04,0x0B,0x0B, 0x00,0x00,0x00,0x00,0x00,0x03,0x07,0x07]);

const T_4B = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x01,0x01,0x01,0x03]);
const T_4C = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,0x00,0x00,0x80,0x80]);
const T_4D = new Uint8Array([0x01,0x03,0x03,0x01,0x00,0x00,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_4E = new Uint8Array([0x00,0x80,0x80,0x00,0x00,0x00,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const T_4F = new Uint8Array([0x01,0x01,0x03,0x02,0x02,0x04,0x05,0x09, 0x00,0x00,0x00,0x01,0x01,0x03,0x03,0x07]);
const T_50 = new Uint8Array([0x00,0x00,0x80,0x80,0x40,0x40,0x40,0x60, 0x00,0x00,0x00,0x00,0x80,0x80,0x80,0x80]);
const T_51 = new Uint8Array([0x0B,0x0B,0x0B,0x09,0x04,0x03,0x00,0x00, 0x07,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_52 = new Uint8Array([0xA0,0xB0,0xB0,0xA0,0x60,0xC0,0x00,0x00, 0xC0,0xC0,0xC0,0xC0,0x80,0x00,0x00,0x00]);

const T_53 = new Uint8Array([0x00,0x00,0x04,0x00,0x01,0x09,0x02,0x06, 0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01]);
const T_54 = new Uint8Array([0x80,0x80,0x40,0xD0,0xD0,0x60,0x20,0xB0, 0x00,0x00,0x00,0x00,0x00,0x80,0xC0,0xC0]);
const T_55 = new Uint8Array([0x0D,0x09,0x0B,0x09,0x04,0x03,0x00,0x00, 0x03,0x07,0x07,0x07,0x03,0x00,0x00,0x00]);
const T_56 = new Uint8Array([0xD8,0xC8,0xE8,0xD8,0xB0,0xE0,0x00,0x00, 0xE0,0xF0,0xF0,0xE0,0xC0,0x00,0x00,0x00]);

const T_57 = new Uint8Array([0x00,0x00,0x30,0x20,0x08,0x04,0x00,0x00, 0x00,0x00,0x30,0x38,0x10,0x00,0x00,0x00]);

const T_49_STAR = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00, 0x10,0x38,0xFE,0x7C,0x7C,0x6C,0x44,0x00]);

// ── Heal phase tiles (CHR bank-switched at f73) ─────────────────────────────
const T_4A_HEAL = new Uint8Array([0x00,0x00,0x00,0x00,0x08,0x00,0x00,0x00, 0x00,0x00,0x00,0x08,0x1C,0x08,0x00,0x00]);
const T_49_HEAL = new Uint8Array([0x10,0x10,0x28,0xD6,0x28,0x10,0x10,0x00, 0x00,0x00,0x10,0x38,0x10,0x00,0x00,0x00]);

// ── Poisona target effect (cure_status only) ────────────────────────────────
// 8 unique tiles forming a 2-state animation that plays OVER THE TARGET during
// the heal phase. Captured via REC OAM 2026-05-06. v1.7.49 had these bytes
// correct but mis-wired them as the caster build-up; v1.7.54 routes them to
// the target where they belong. State A: $49/$4A/$4B/$4C; State B: $4D/$4E/$4F/$50.
// All tiles drawn HFLIP; toggle every 67 ms over the heal window (283 ms).
const POISONA_TGT_T49 = new Uint8Array([0x00,0x02,0x00,0x0C,0x00,0x40,0x00,0x20, 0x00,0x05,0x1C,0x30,0x30,0x20,0x68,0x60]);
const POISONA_TGT_T4A = new Uint8Array([0x00,0x80,0x38,0x04,0x04,0x02,0x02,0x00, 0x00,0x60,0x00,0x00,0x00,0x00,0x00,0x00]);
const POISONA_TGT_T4B = new Uint8Array([0x30,0x20,0x18,0x08,0x0E,0x4B,0x03,0x00, 0x60,0x70,0x30,0x3C,0x1F,0x47,0x00,0x00]);
const POISONA_TGT_T4C = new Uint8Array([0x00,0x30,0x38,0xB8,0x78,0xE0,0x00,0x10, 0x04,0x30,0x38,0x78,0xF2,0xD0,0x80,0x10]);
const POISONA_TGT_T4D = new Uint8Array([0x00,0x06,0x18,0x20,0x20,0x20,0x00,0x40, 0x00,0x00,0x00,0x00,0x00,0x40,0x40,0x00]);
const POISONA_TGT_T4E = new Uint8Array([0x00,0x00,0x00,0x38,0x70,0x7D,0x0C,0x14, 0x00,0x00,0x00,0x38,0x7C,0x79,0x1C,0x0E]);
const POISONA_TGT_T4F = new Uint8Array([0x00,0x40,0x10,0x10,0x00,0x01,0x04,0x00, 0x40,0x00,0x60,0x20,0x38,0x1F,0x03,0x00]);
const POISONA_TGT_T50 = new Uint8Array([0x06,0x0E,0x08,0x3C,0xA0,0xC0,0x00,0x00, 0x0C,0x0C,0x1C,0x18,0x78,0xF0,0xC4,0x00]);

// ── Decode helpers ──────────────────────────────────────────────────────────

function _decodeTilePixels(d) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const lo = d[row], hi = d[row + 8];
    for (let bit = 7; bit >= 0; bit--) {
      out[row * 8 + (7 - bit)] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
    }
  }
  return out;
}

function _make8(tile, pal) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const cx = c.getContext('2d');
  const px = _decodeTilePixels(tile);
  const img = cx.createImageData(8, 8);
  for (let p = 0; p < 64; p++) {
    const ci = px[p];
    if (ci === 0) { img.data[p * 4 + 3] = 0; continue; }
    const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
    img.data[p * 4] = rgb[0]; img.data[p * 4 + 1] = rgb[1];
    img.data[p * 4 + 2] = rgb[2]; img.data[p * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// 4-quadrant flipped layout: TL = src, TR = HFLIP, BL = VFLIP, BR = both.
// Used for size-1 ($4A) and brackets ($57) which build a 16×16 ring from one tile.
function _flippedQuad(tile8) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tile8, 0, 0);
  cx.save(); cx.translate(16, 0);  cx.scale(-1,  1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(0,  16); cx.scale( 1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  cx.save(); cx.translate(16, 16); cx.scale(-1, -1); cx.drawImage(tile8, 0, 0); cx.restore();
  return c;
}

// 4-distinct-tile 16×16: TL, TR, BL, BR.
function _quad4(tl, tr, bl, br) {
  const c = _makeCanvas16(); const cx = c.getContext('2d');
  cx.drawImage(tl, 0, 0); cx.drawImage(tr, 8, 0);
  cx.drawImage(bl, 0, 8); cx.drawImage(br, 8, 8);
  return c;
}

// 2-frame heal sparkle, alternates orientation every 67 ms. Same TL/TR/BL/BR
// rotation pattern as `sprite-init.js _initCureSparkleFrames` so the magic-
// cast and item-use Cure paths match visually for the recovery palette.
function _buildSparkleFrames(t4aHeal, t49Heal) {
  const tiles = [t4aHeal, t49Heal];
  const layouts = [
    [[1,0,0,true,false],[0,8,0,true,false],[0,0,8,false,true],[1,8,8,false,true]],
    [[0,0,0,false,false],[1,8,0,false,false],[1,0,8,true,true],[0,8,8,true,true]],
  ];
  return layouts.map(config => {
    const c = _makeCanvas16(); const cx = c.getContext('2d');
    for (const [ti, ox, oy, hf, vf] of config) {
      cx.save();
      if (hf && vf) { cx.translate(ox + 8, oy + 8); cx.scale(-1, -1); cx.drawImage(tiles[ti], 0, 0); }
      else if (hf)  { cx.translate(ox + 8, oy);     cx.scale(-1,  1); cx.drawImage(tiles[ti], 0, 0); }
      else if (vf)  { cx.translate(ox,     oy + 8); cx.scale( 1, -1); cx.drawImage(tiles[ti], 0, 0); }
      else          { cx.drawImage(tiles[ti], ox, oy); }
      cx.restore();
    }
    return c;
  });
}

// Build the 2-frame Poisona target effect. 16×16 canvas matching the heal-
// sparkle dimensions so consumers can drawImage at portrait origin and the
// effect fills the portrait exactly (TL/TR at y=0, BL/BR at y=8). All tiles
// drawn HFLIP per the captured layout.
function _buildPoisonaTargetFrames(pal) {
  const a49 = _make8(POISONA_TGT_T49, pal), a4a = _make8(POISONA_TGT_T4A, pal);
  const a4b = _make8(POISONA_TGT_T4B, pal), a4c = _make8(POISONA_TGT_T4C, pal);
  const b4d = _make8(POISONA_TGT_T4D, pal), b4e = _make8(POISONA_TGT_T4E, pal);
  const b4f = _make8(POISONA_TGT_T4F, pal), b50 = _make8(POISONA_TGT_T50, pal);
  const _frame = (tl, tr, bl, br) => {
    const c = _makeCanvas16();
    const cx = c.getContext('2d');
    const _hflip = (tile, ox, oy) => {
      cx.save(); cx.translate(ox + 8, oy); cx.scale(-1, 1);
      cx.drawImage(tile, 0, 0); cx.restore();
    };
    _hflip(tl, 0, 0); _hflip(tr, 8, 0);
    _hflip(bl, 0, 8); _hflip(br, 8, 8);
    return c;
  };
  return [
    _frame(a4a, a49, a4c, a4b),  // state A
    _frame(b4e, b4d, b50, b4f),  // state B
  ];
}

function _decodeForPalette(pal) {
  const t4a = _make8(T_4A, pal);
  const t4b = _make8(T_4B, pal), t4c = _make8(T_4C, pal), t4d = _make8(T_4D, pal), t4e = _make8(T_4E, pal);
  const t4f = _make8(T_4F, pal), t50 = _make8(T_50, pal), t51 = _make8(T_51, pal), t52 = _make8(T_52, pal);
  const t53 = _make8(T_53, pal), t54 = _make8(T_54, pal), t55 = _make8(T_55, pal), t56 = _make8(T_56, pal);
  const t57 = _make8(T_57, pal);

  const flameFrames = [
    _flippedQuad(t4a),               // size 1 — smallest ring
    _quad4(t4b, t4c, t4d, t4e),      // size 2
    _quad4(t4f, t50, t51, t52),      // size 3
    _quad4(t53, t54, t55, t56),      // size 4 — XL ring
    _flippedQuad(t57),               // brackets — release flash
  ];

  const starTile = _make8(T_49_STAR, pal);

  const t4aHeal = _make8(T_4A_HEAL, pal);
  const t49Heal = _make8(T_49_HEAL, pal);
  const sparkleFrames = _buildSparkleFrames(t4aHeal, t49Heal);

  return { flameFrames, starTile, sparkleFrames };
}

// ── Public init ─────────────────────────────────────────────────────────────

let _animsByKey = null;  // { recovery, cure_status, revive } → bundle (deduped by palette)

// Backward compat: returns the recovery school's bundle so existing callers
// (battle-sprite-cache, HUD pause-heal etc.) keep working unchanged. New code
// should call `getCureAnimAssets(spell)` to pick the per-school palette.
//
// `healSparkleFrame` alias is the first frame of `sparkleFrames`, kept so
// older imports don't break — production render uses the 2-frame `sparkleFrames`.
export function initCureAnimSprites() {
  _animsByKey = {};
  const cache = {};
  for (const [key, pal] of Object.entries(WHITE_MAGIC_PAL)) {
    const palKey = pal.join('-');
    if (!cache[palKey]) cache[palKey] = _decodeForPalette(pal);
    _animsByKey[key] = cache[palKey];
  }
  // cure_status gets the dedicated Poisona target effect on top of the shared
  // bundle. Spread to break reference equality with `revive` (same palette,
  // different anim — only Poisona/Bndna/Esuna/Stone use these target frames).
  _animsByKey.cure_status = {
    ..._animsByKey.cure_status,
    poisonaTargetFrames: _buildPoisonaTargetFrames(WHITE_MAGIC_PAL.cure_status),
  };
  const recov = _animsByKey.recovery;
  return {
    flameFrames: recov.flameFrames,
    starTile: recov.starTile,
    sparkleFrames: recov.sparkleFrames,
    healSparkleFrame: recov.sparkleFrames[0],
  };
}

// Pick the right pre-decoded asset bundle for a spell. Returns null for non-
// white-magic spells, or before init has run.
//
// Bundle shape: { flameFrames, starTile, sparkleFrames }
export function getCureAnimAssets(spell) {
  if (!spell || !_animsByKey) return null;
  const key = spell.target === 'cure_status' ? 'cure_status'
            : spell.target === 'revive'      ? 'revive'
            : spell.target === 'sight'       ? 'sight'
            : spell.element === 'fire'       ? 'fire'
            : spell.element === 'recovery'   ? 'recovery'
            : null;
  return key ? _animsByKey[key] : null;
}

// ── Phase mapping (ms-based, 60 Hz NES capture × 16.67ms/frame) ─────────────

export const CURE_PHASE_MS = {
  buildup: 800,    // f0-47   flame pulses + stars rotate
  lunge:   200,    // f48-59  caster slides (visual no-op in our portrait)
  cast:    217,    // f60-72  cast pose hold (engine's item-use pose)
  heal:    283,    // f73-89  heal sparkle on target + heal number
  ret:     167,    // f90-99  return — anim ends
};

export const CURE_TOTAL_MS =
  CURE_PHASE_MS.buildup + CURE_PHASE_MS.lunge + CURE_PHASE_MS.cast +
  CURE_PHASE_MS.heal + CURE_PHASE_MS.ret;

// Phase boundary ms-offsets from t=0 of magic-cast.
export const CURE_T_LUNGE  = CURE_PHASE_MS.buildup;
export const CURE_T_CAST   = CURE_T_LUNGE + CURE_PHASE_MS.lunge;
export const CURE_T_HEAL   = CURE_T_CAST + CURE_PHASE_MS.cast;
export const CURE_T_RETURN = CURE_T_HEAL + CURE_PHASE_MS.heal;

// Flame pulse cycle, transcribed from OAM frame-by-frame (cure_bg, f0-47):
//   f0-3   size 1 ($4A ×4 with corner flips)
//   f4-7   size 2 normal
//   f8-11  size 2 h-mirror (visually similar to size 2)
//   f12-15 size 3 normal
//   f16-19 size 4 normal
//   f20-23 size 4 h-mirror
//   f24-27 size 3 normal
//   f28-31 size 4 normal
//   f32-35 size 4 h-mirror
//   f36-47 brackets ($57)
// h-mirror variants collapse to their non-mirrored size (the eye doesn't
// distinguish a symmetric ring from its mirror); cycle reduces to 9 hops at
// 67 ms each, then brackets for ~200 ms.
const _FLAME_SEQ = [0, 1, 1, 2, 3, 3, 2, 3, 3];

// Returns 0..4 (size1, size2, size3, size4, brackets) or -1 if not in build-up.
export function getCureFlameFrameIdx(elapsedMs) {
  if (elapsedMs < 0 || elapsedMs >= CURE_T_LUNGE) return -1;
  if (elapsedMs >= 600) return 4; // brackets
  const step = Math.min(_FLAME_SEQ.length - 1, Math.floor(elapsedMs / 67));
  return _FLAME_SEQ[step];
}

// True while the rotating stars should be drawn — phases 1+2 (f0-59 in
// capture). Stars continue through the lunge phase even though the flame
// disappears at the end of build-up.
export function shouldDrawStars(elapsedMs) {
  return elapsedMs >= 0 && elapsedMs < CURE_T_CAST;
}

// True while the heal-phase target sparkle should be drawn (phase 4).
export function shouldDrawHealSparkle(elapsedMs) {
  return elapsedMs >= CURE_T_HEAL && elapsedMs < CURE_T_RETURN;
}

// Pick the right target-effect frame set for the heal phase. cure_status
// spells (Poisona family) use the captured 2-frame target effect; recovery
// (Cure) and revive fall back to the heal sparkle.
export function getCureTargetFrames(spell, animBundle) {
  if (!animBundle) return null;
  if (spell && spell.target === 'cure_status' && animBundle.poisonaTargetFrames) {
    return animBundle.poisonaTargetFrames;
  }
  return animBundle.sparkleFrames || null;
}

// ── Item → spell-animation lookup ───────────────────────────────────────────
// FF3 NES consumables dispatch to white-magic spells (Potion → Cure, Antidote
// → Poisona, etc.); each item record carries its `animSpellId` declaratively.
// Render paths call `getItemSparkleFrames(itemId)` and route uniformly through
// the per-spell animation pipeline — no per-item special-casing.
//
// Only spells with on-target frames captured from FF3 NES OAM should be in
// CAPTURED_TARGET_SPELLS. Items pointing to a non-captured spell (e.g. Mallet
// → Mini today) return null from this helper and the caller falls back to the
// recovery sparkle placeholder. To wire up a newly-captured animation: add
// the spell ID here, no item-record changes needed.
const CAPTURED_TARGET_SPELLS = new Set([
  0x34,  // Cure (recovery sparkle, blue)
  0x35,  // Poisona (poisonaTargetFrames, magenta)
]);

export function getItemSparkleFrames(itemId) {
  const itm = itemId != null ? ITEMS.get(itemId) : null;
  const sid = itm && itm.animSpellId;
  if (sid == null || !CAPTURED_TARGET_SPELLS.has(sid)) return null;
  const spell = SPELLS.get(sid);
  if (!spell) return null;
  const bundle = getCureAnimAssets(spell);
  return getCureTargetFrames(spell, bundle);
}
