// Per-spell on-target animation, dispatched by SPELL ID.
//
// Architectural rule (the user has stated this across multiple sessions):
//   • Cast animations are per-job (see cast-anim.js).
//   • Projectile animations are shared across thrown spells (see
//     projectile-anim.js).
//   • The on-target effect — and only the on-target effect — varies per spell.
//     ALL of those visuals live here, in one registry keyed by spell ID.
//
// Each spell entry returns a render bundle that callers consume:
//   - `kind` — discriminator: 'portrait-2frame' | 'burst-strip-2frame' | null
//   - `frames` — array of canvases to draw (kind-dependent count)
//   - `width` / `height` — canvas dimensions (frames must match)
//   - `anchor` — 'portrait-center' (16×16, for ally/self heal sparkles) or
//                'enemy-center' (variable, for thrown impacts)
//   - `toggleMs` — frame-toggle cadence (67 ms = NES 4-frame hold @ 60 Hz)
//
// `null` is a valid return — Sight (0x36) has no on-target visual; the
// "Ineffective" battle message handles user feedback.

import { NES_SYSTEM_PALETTE } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';
import { ITEMS } from './data/items.js';

// ── Palettes per spell family ─────────────────────────────────────────────
//
// Same dispatch axis the FF3 NES capture uses: target effect color depends on
// the spell's school/effect, NOT on the caster's job. Cure-family is blue;
// status-cure is magenta; fire impact is red/orange.

const PAL_CURE       = [0x0F, 0x12, 0x22, 0x31];  // Cure / HiPotion / etc.
const PAL_CURE_STATUS = [0x0F, 0x15, 0x27, 0x30]; // Poisona / Antidote / Bndna
const PAL_FIRE_IMPACT = [0x0F, 0x16, 0x27, 0x30]; // Fire (REC OAM 2026-05-07 f9627)

// ── Cure-family heal sparkle ($4A_HEAL + $49_HEAL after CHR rebank) ───────
// Captured 2026-05-04. The tile slots are the same numeric IDs used by the WM
// cast flame, but the bytes are different — MMC3 bank-switches CHR between
// the cast and heal phases.

const CURE_T_4A_HEAL = new Uint8Array([0x00,0x00,0x00,0x00,0x08,0x00,0x00,0x00, 0x00,0x00,0x00,0x08,0x1C,0x08,0x00,0x00]);
const CURE_T_49_HEAL = new Uint8Array([0x10,0x10,0x28,0xD6,0x28,0x10,0x10,0x00, 0x00,0x00,0x10,0x38,0x10,0x00,0x00,0x00]);

// ── Poisona target effect (8 tiles, 2 alternating states) ─────────────────
// Captured 2026-05-06 (REC OAM band $49–$50 over the heal window). All tiles
// drawn HFLIP per the captured layout.

const POISONA_T_49 = new Uint8Array([0x00,0x02,0x00,0x0C,0x00,0x40,0x00,0x20, 0x00,0x05,0x1C,0x30,0x30,0x20,0x68,0x60]);
const POISONA_T_4A = new Uint8Array([0x00,0x80,0x38,0x04,0x04,0x02,0x02,0x00, 0x00,0x60,0x00,0x00,0x00,0x00,0x00,0x00]);
const POISONA_T_4B = new Uint8Array([0x30,0x20,0x18,0x08,0x0E,0x4B,0x03,0x00, 0x60,0x70,0x30,0x3C,0x1F,0x47,0x00,0x00]);
const POISONA_T_4C = new Uint8Array([0x00,0x30,0x38,0xB8,0x78,0xE0,0x00,0x10, 0x04,0x30,0x38,0x78,0xF2,0xD0,0x80,0x10]);
const POISONA_T_4D = new Uint8Array([0x00,0x06,0x18,0x20,0x20,0x20,0x00,0x40, 0x00,0x00,0x00,0x00,0x00,0x40,0x40,0x00]);
const POISONA_T_4E = new Uint8Array([0x00,0x00,0x00,0x38,0x70,0x7D,0x0C,0x14, 0x00,0x00,0x00,0x38,0x7C,0x79,0x1C,0x0E]);
const POISONA_T_4F = new Uint8Array([0x00,0x40,0x10,0x10,0x00,0x01,0x04,0x00, 0x40,0x00,0x60,0x20,0x38,0x1F,0x03,0x00]);
const POISONA_T_50 = new Uint8Array([0x06,0x0E,0x08,0x3C,0xA0,0xC0,0x00,0x00, 0x0C,0x0C,0x1C,0x18,0x78,0xF0,0xC4,0x00]);

// ── Fire impact (10 tiles, 16×40 vertical flame burst) ────────────────────
// Captured 2026-05-07 (REC OAM f9627, group at origin (40,104) frames 75-106,
// ~533 ms). Tile slots $49-$52 are the SAME numeric IDs as the BM cast flame,
// but the bytes are different (CHR-bank reload between cast and impact). The
// burst HFLIP-toggles every NES 4-frame hold (~67 ms).
//
// PRIOR BUG: v1.7.87/88 fire-anim.js used tiles $59 and $5C from the (32,122)
// group with palette [0x0F, 0x0F, 0x25, 0x2B] — those are damage-number digit
// tiles ($59 = digit 3, $5C = digit 6) and the standard DMG_NUM_PAL. The
// "scorch impact" mentioned in past changelogs was a misread of the damage
// popup. Real fire impact is the (40,104) group, this byte set.

const FIRE_T_49 = new Uint8Array([0x01,0x01,0x02,0x02,0x02,0x07,0x03,0x03, 0x00,0x00,0x00,0x00,0x00,0x80,0x00,0x00]);
const FIRE_T_4A = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x04,0x88, 0x00,0x00,0x10,0x00,0x00,0x00,0x00,0x00]);
const FIRE_T_4B = new Uint8Array([0x03,0x07,0x07,0x0F,0x0F,0x0F,0x4E,0x4E, 0x00,0x00,0x00,0x20,0x00,0x00,0x01,0x01]);
const FIRE_T_4C = new Uint8Array([0x88,0xD8,0xD8,0x99,0xB1,0xF1,0xFA,0xFE, 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
const FIRE_T_4D = new Uint8Array([0x1E,0x1E,0x8F,0x8A,0xD8,0x78,0x78,0x39, 0x01,0x01,0x00,0x05,0x07,0x07,0x07,0x07]);
const FIRE_T_4E = new Uint8Array([0x6D,0x7D,0x6F,0x2E,0x0E,0x8E,0x9E,0x9C, 0x90,0x80,0x90,0xD0,0xF0,0xF0,0xE0,0xE0]);
const FIRE_T_4F = new Uint8Array([0x31,0x79,0xDB,0xD3,0xC3,0xC7,0x67,0x37, 0x0F,0x07,0x27,0x2F,0x3F,0x3F,0x1F,0x0F]);
const FIRE_T_50 = new Uint8Array([0x9C,0x9C,0xBD,0x2D,0x29,0x4B,0x5F,0x96, 0xE0,0xE0,0xC0,0xD0,0xD0,0xB0,0xA0,0xE8]);
const FIRE_T_51 = new Uint8Array([0xB3,0xB3,0x73,0x79,0x19,0x18,0x1E,0x0F, 0x0F,0x0F,0x0F,0x07,0x07,0x07,0x01,0x00]);
const FIRE_T_52 = new Uint8Array([0xA6,0xEE,0x4C,0x4C,0x0C,0x3C,0x78,0xE0, 0xF8,0xF0,0xF0,0xF0,0xF0,0xC0,0x80,0x00]);

// ── Decode helpers ────────────────────────────────────────────────────────

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

// ── Cure sparkle: 2-frame 16×16 portrait overlay ──────────────────────────
// Same TL/TR/BL/BR rotation pattern as `sprite-init.js _initCureSparkleFrames`
// so this stays visually identical to the legacy item-use Cure path.

function _buildCureSparkle(pal) {
  const t4aHeal = _make8(CURE_T_4A_HEAL, pal);
  const t49Heal = _make8(CURE_T_49_HEAL, pal);
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

// ── Poisona target: 2-state 16×16 portrait overlay ────────────────────────

function _buildPoisonaTarget(pal) {
  const a49 = _make8(POISONA_T_49, pal), a4a = _make8(POISONA_T_4A, pal);
  const a4b = _make8(POISONA_T_4B, pal), a4c = _make8(POISONA_T_4C, pal);
  const b4d = _make8(POISONA_T_4D, pal), b4e = _make8(POISONA_T_4E, pal);
  const b4f = _make8(POISONA_T_4F, pal), b50 = _make8(POISONA_T_50, pal);
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

// ── Fire impact: 16×40 flame burst (vertical strip, HFLIP-toggle) ─────────
// Tile layout (each cell 8×8):
//   row 0  $49  $4A
//   row 1  $4B  $4C
//   row 2  $4D  $4E
//   row 3  $4F  $50
//   row 4  $51  $52
// Frame B is the entire 16×40 canvas HFLIP'd (matches REC OAM frame 80 layout
// where the same 10 tiles appear at swapped columns with HFLIP attribute).

function _build16x40(tiles8, pal) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 40;
  const cx = c.getContext('2d');
  for (let row = 0; row < 5; row++) {
    cx.drawImage(tiles8[row * 2 + 0], 0, row * 8);
    cx.drawImage(tiles8[row * 2 + 1], 8, row * 8);
  }
  return c;
}

function _hflipCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const cx = c.getContext('2d');
  cx.translate(src.width, 0); cx.scale(-1, 1);
  cx.drawImage(src, 0, 0);
  return c;
}

function _buildFireImpactFrames(pal) {
  const ts = [
    _make8(FIRE_T_49, pal), _make8(FIRE_T_4A, pal),
    _make8(FIRE_T_4B, pal), _make8(FIRE_T_4C, pal),
    _make8(FIRE_T_4D, pal), _make8(FIRE_T_4E, pal),
    _make8(FIRE_T_4F, pal), _make8(FIRE_T_50, pal),
    _make8(FIRE_T_51, pal), _make8(FIRE_T_52, pal),
  ];
  const frameA = _build16x40(ts, pal);
  const frameB = _hflipCanvas(frameA);
  return [frameA, frameB];
}

// ── Public API ────────────────────────────────────────────────────────────

let _bySpellId = null;

export function initSpellAnim() {
  const cureSparkle  = _buildCureSparkle(PAL_CURE);
  const poisonaTgt   = _buildPoisonaTarget(PAL_CURE_STATUS);
  const fireImpact   = _buildFireImpactFrames(PAL_FIRE_IMPACT);

  _bySpellId = {
    // White magic — recovery family (Cure)
    0x34: { kind: 'portrait-2frame', frames: cureSparkle, width: 16, height: 16,
            anchor: 'portrait-center', toggleMs: 67 },
    // White magic — status-cure family (Poisona; Bndna/Esuna/Stone fall back to
    // sparkle for now; capture per-spell when we ship them).
    0x35: { kind: 'portrait-2frame', frames: poisonaTgt, width: 16, height: 16,
            anchor: 'portrait-center', toggleMs: 67 },
    // Black magic — Fire (Lv1)
    0x31: { kind: 'burst-strip-2frame', frames: fireImpact, width: 16, height: 40,
            anchor: 'enemy-center', toggleMs: 67 },
    // Sight (0x36) intentionally absent — battle msg handles "Ineffective".
  };
}

// Returns the on-target render bundle for a spell ID, or null. Callers
// should branch on `bundle.kind` to pick the right draw path.
export function getSpellAnim(spellId) {
  if (spellId == null || !_bySpellId) return null;
  return _bySpellId[spellId] || null;
}

// Item → spell-anim lookup. FF3 NES consumables dispatch to white-magic
// spells (Potion → Cure, Antidote → Poisona, etc.) via `item.animSpellId`.
// Returns the same bundle shape as `getSpellAnim`.
export function getSpellAnimForItem(itemId) {
  const itm = itemId != null ? ITEMS.get(itemId) : null;
  const sid = itm && itm.animSpellId;
  return sid != null ? getSpellAnim(sid) : null;
}

// Convenience: pick the current animation frame for a 2-state effect using
// the bundle's `toggleMs` cadence. Returns null if bundle is null/wrong-kind.
export function getSpellAnimFrame(bundle, elapsedMs) {
  if (!bundle || !bundle.frames || bundle.frames.length === 0) return null;
  const idx = Math.floor(elapsedMs / (bundle.toggleMs || 67)) % bundle.frames.length;
  return bundle.frames[idx];
}
