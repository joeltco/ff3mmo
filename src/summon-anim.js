// Summon presentation — the roster fades out, the creature enters the player
// box, casts, and the roster fades back in.
//
// Summons are deliberately NOT part of the on-target spell registry. Every
// other spell's visual is a burst anchored on its target; a summon is a scene
// that takes over the party panel, so it gets its own module and its own
// timeline rather than being bent into `spell-anim.js`.
//
// The art is captured (tools/monscan/spell-summon.cjs) and the per-state holds
// are measured — a summon is a ONE-SHOT sequence, typically a short entrance
// followed by a long standing hold (Shiva is 1,1,1,1,1,1,149 frames), which is
// why `holds` is per state instead of one toggle.
//
// Coordinates are absolute NES screen positions against a 256x152 source rect,
// the same as the screen-anchored spells, and are mapped into the map-HUD band
// exactly the way `spell-anim.js` maps those: x is 1:1, y is squeezed by
// 144/152, and tiles stay 8x8 so nothing blurs.

import { CAPTURED_SUMMONS, SUMMON_SRC_W, SUMMON_SRC_H } from './data/summon-anim-captured.js';
import { CAPTURED_SPELL_ANIMS } from './data/spell-anim-captured.js';
import { _make8Canvas } from './canvas-utils.js';

const BAND_W = 256, BAND_H = 144;

// The fade length is a DESIGN CHOICE, not a measurement. The capture's
// `fadeFrames` counts every frame whose nametable or palette differed from the
// idle baseline, which covers the whole message-box period as well as the fade
// itself — it is not a fade duration and must not be used as one. Four steps
// over 300 ms matches the stepped look of the roster fades elsewhere.
export const SUMMON_FADE_MS = 300;
export const SUMMON_FADE_STEPS = 4;

// DESIGN DECISION, not a capture. Titan loads no effect art of his own — this
// was verified twice, against both an unkillable and a killable target, and the
// regions came back identical either way, so nothing was being hidden by the
// target surviving. He borrows Quake's ground crack, which is earth and already
// emitted as a screen-anchored effect at the same 256x152 source rect.
//
// There is ROM precedent for a summon borrowing a spell's effect: Ramuh
// genuinely loads $55cd0, the same block Bolt / Bolt2 / Bolt3 use.
//
// `ms` is the crack's measured hold from the Quake capture — 81 frames — not a
// number picked to feel right.
const BORROWED_EFFECT = {
  0x1b: { spellId: 0x07, ms: 1350 },
};

let _bySpellId = null;

export function initSummonAnim() {
  _bySpellId = new Map();
  for (const [id, e] of CAPTURED_SUMMONS) {
    const sx = BAND_W / SUMMON_SRC_W, sy = BAND_H / SUMMON_SRC_H;
    const buildFrames = (part) => {
      const cache = part.pals.map(() => new Array(part.tiles.length));
      const tileFor = (pi, ti) => {
        if (!cache[pi][ti]) cache[pi][ti] = _make8Canvas(part.tiles[ti], part.pals[pi]);
        return cache[pi][ti];
      };
      return part.layouts.map((layout) => {
      const c = document.createElement('canvas');
      c.width = BAND_W; c.height = BAND_H;
      const cx = c.getContext('2d');
      for (const [ti, x, y, hf, vf, pi = 0] of layout) {
        const ox = Math.round(x * sx), oy = Math.round(y * sy);
        const img = tileFor(pi, ti);
        cx.save();
        if (hf && vf) { cx.translate(ox + 8, oy + 8); cx.scale(-1, -1); cx.drawImage(img, 0, 0); }
        else if (hf)  { cx.translate(ox + 8, oy);     cx.scale(-1,  1); cx.drawImage(img, 0, 0); }
        else if (vf)  { cx.translate(ox,     oy + 8); cx.scale( 1, -1); cx.drawImage(img, 0, 0); }
        else          { cx.drawImage(img, ox, oy); }
        cx.restore();
      }
        return c;
      });
    };
    const frames = buildFrames(e);
    const creatureMs = e.holds.reduce((a, c) => a + c, 0);
    // The magic the creature performs. Six of eight have one; Odin and Titan
    // load nothing beyond the shared call burst, so they stand and that is it.
    const fx = e.effect ? { frames: buildFrames(e.effect), holds: e.effect.holds } : null;
    // The cast burst, played during the buildup like any other school's cast.
    const cast = e.cast ? { frames: buildFrames(e.cast), holds: e.cast.holds } : null;
    // Borrowed effect, if this summon has none of its own. Quake is emitted with
    // the same absolute-coordinate 256x152 source rect, so buildFrames maps it
    // into the band exactly as it maps a summon's own art.
    let borrowed = null;
    if (!e.effect && BORROWED_EFFECT[id]) {
      const src = CAPTURED_SPELL_ANIMS.get(BORROWED_EFFECT[id].spellId);
      if (src) borrowed = { frames: buildFrames(src), holds: src.layouts.map(() => BORROWED_EFFECT[id].ms) };
    }
    const effectMs = fx ? fx.holds.reduce((a, c) => a + c, 0) : 0;
    const fxFinal = fx || borrowed;
    _bySpellId.set(id, {
      frames, holds: e.holds, creatureMs,
      fx: fxFinal,
      effectMs: fxFinal ? fxFinal.holds.reduce((a, c) => a + c, 0) : 0,
      cast, box: e.box,
    });
  }
}

export function isSummonSpell(spellId) {
  return spellId != null && CAPTURED_SUMMONS.has(spellId);
}

export function getSummon(spellId) {
  if (spellId == null || !_bySpellId) return null;
  return _bySpellId.get(spellId) || null;
}

/**
 * Total presentation: fade the panel out, play the creature, fade it back.
 *
 * Reads the captured data directly rather than the built bundle, so the cast
 * TIMELINE is correct even where canvases were never built — Node harnesses
 * have no DOM, and a browser where initSummonAnim() threw would otherwise give
 * summons a zero-length window and apply their damage instantly with no visual.
 */
export function summonTotalMs(spellId) {
  const e = CAPTURED_SUMMONS.get(spellId);
  if (!e) return 0;
  const creature = e.holds.reduce((a, c) => a + c, 0);
  let effect = e.effect ? e.effect.holds.reduce((a, c) => a + c, 0) : 0;
  if (!e.effect && BORROWED_EFFECT[spellId]) {
    const src = CAPTURED_SPELL_ANIMS.get(BORROWED_EFFECT[spellId].spellId);
    if (src) effect = src.layouts.length * BORROWED_EFFECT[spellId].ms;
  }
  return SUMMON_FADE_MS + creature + effect + SUMMON_FADE_MS;
}

/** Length of the cast burst, so the buildup can be sized to fit it. */
export function summonCastMs(spellId) {
  const e = CAPTURED_SUMMONS.get(spellId);
  if (!e || !e.cast) return 0;
  return e.cast.holds.reduce((a, c) => a + c, 0);
}

/**
 * Cast burst frame at `t` ms into the BUILDUP, or null.
 *
 * This is the summon school's cast animation ($55810), played while the party
 * panel is still up — the same place a black or white cast plays. It is a
 * separate call from summonPhaseAt because it belongs to the magic-cast state,
 * not the scene.
 */
export function summonCastFrameAt(spellId, t) {
  const s = getSummon(spellId);
  if (!s || !s.cast) return null;
  let acc = 0;
  for (let i = 0; i < s.cast.holds.length; i++) {
    acc += s.cast.holds[i];
    if (t < acc) return s.cast.frames[i];
  }
  return null;                             // burst finished; buildup continues empty
}

/**
 * Phase at `t` ms into the presentation.
 *
 * `panelFade` is 0 (panel fully visible) .. SUMMON_FADE_STEPS (fully black) and
 * stays pinned at black for the whole creature phase — the party is not
 * supposed to reappear behind it.
 */
export function summonPhaseAt(spellId, t) {
  const s = getSummon(spellId);
  if (!s) return null;
  const stepMs = SUMMON_FADE_MS / SUMMON_FADE_STEPS;
  if (t < SUMMON_FADE_MS) {
    return { phase: 'fade-out', panelFade: Math.min(SUMMON_FADE_STEPS, Math.floor(t / stepMs)), frame: null };
  }
  const ct = t - SUMMON_FADE_MS;
  if (ct < s.creatureMs) {
    let acc = 0, idx = 0;
    for (let i = 0; i < s.holds.length; i++) {
      acc += s.holds[i];
      if (ct < acc) { idx = i; break; }
      idx = i;
    }
    return { phase: 'creature', panelFade: SUMMON_FADE_STEPS, frame: s.frames[idx] };
  }
  // The creature casts. Six of eight have an effect; Odin and Titan skip
  // straight to the fade because they load no art beyond the shared burst.
  const et = ct - s.creatureMs;
  if (s.fx && et < s.effectMs) {
    let acc = 0, idx = 0;
    for (let i = 0; i < s.fx.holds.length; i++) {
      acc += s.fx.holds[i];
      if (et < acc) { idx = i; break; }
      idx = i;
    }
    return { phase: 'effect', panelFade: SUMMON_FADE_STEPS, frame: s.fx.frames[idx] };
  }
  const ft = et - s.effectMs;
  if (ft < SUMMON_FADE_MS) {
    return { phase: 'fade-in', panelFade: Math.max(0, SUMMON_FADE_STEPS - Math.floor(ft / stepMs)), frame: null };
  }
  return { phase: 'done', panelFade: 0, frame: null };
}
