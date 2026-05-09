// combatant-pose.js — picks the canonical pose key + hand-weapon draw spec for a combatant's
// current attack frame. Centralizes the rules so player/ally/opponent renderers stop diverging.

import { getKnifeBladeCanvas, getKnifeBladeSwungCanvas,
         getDaggerBladeCanvas, getDaggerBladeSwungCanvas,
         getSwordBladeCanvas, getSwordBladeSwungCanvas,
         getNunchakuBladeCanvas, getNunchakuBladeSwungCanvas,
         getStaffBladeCanvas, getStaffBladeSwungCanvas,
         getFistCanvas } from './weapon-sprites.js';
import {
  fakePlayerAttackPortraits, fakePlayerAttackLPortraits,
  fakePlayerKnifeRPortraits, fakePlayerKnifeLPortraits,
  fakePlayerKnifeRFwdPortraits, fakePlayerKnifeLFwdPortraits,
  fakePlayerKnifeRFullBodyCanvases, fakePlayerKnifeLFullBodyCanvases,
  fakePlayerKnifeRFwdFullBodyCanvases, fakePlayerKnifeLFwdFullBodyCanvases,
} from './fake-player-sprites.js';
import { consoleLog, isDev } from './chat.js';
import { bsc } from './battle-sprite-cache.js';

const FIST_WOBBLE_PERIOD_MS = 100; // shared cadence — same constant across player/ally/opponent

// Inter-hit idle frame: when a combo transitions from R-hand to L-hand (or vice versa),
// hold the idle pose for this many ms so the swap reads as a separate strike instead of one blur.
// 33 ms = 2 NES frames — matches OAM f14608 dual-wield hand-change at frames 24-25.
// Was 67 ms (4 frames) which read as a hitch in heavier combos.
export const IDLE_FRAME_MS = 33;

// Returns the weapon canvas + body-relative offset to draw at, or null if nothing to draw this frame.
// Mirror flag: opponent uses a pre-flipped (face-right) canvas, so the swinging hand visually swaps
// — the offset returned is in the post-flip coordinate system.
export function pickAttackWeaponSpec({
  weaponId,            // hand's weapon item ID
  weaponSubtype,       // 'knife' | 'dagger' | 'sword' | 'nunchaku' | 'staff' | 'claw' | null
  isUnarmed,           // both hand slots empty
  hand,                // 'R' | 'L'
  attackPhase,         // 'back' | 'fwd'
  mirror,              // bool — opponent face-right pre-flipped canvas
  fistPalette,         // per-character palette (used for unarmed fist tinting)
  fistTimerMs,         // battleSt.battleTimer (drives wobble cadence; resets per attack state)
}) {
  const visualHand = mirror ? (hand === 'R' ? 'L' : 'R') : hand;

  // Unarmed: only fwd phase paints the fist (back phase has no separate visual; body strike pose handles it)
  if (isUnarmed) {
    if (attackPhase !== 'fwd') return null;
    const c = getFistCanvas(fistPalette);
    if (!c) return null;
    const dy = (Math.floor(fistTimerMs / FIST_WOBBLE_PERIOD_MS) & 1);
    return { canvas: c, dx: -4, dy: 10 + dy };
  }

  // Pick blade canvas pair by weapon
  let raised = null, swung = null;
  if (weaponSubtype === 'knife' && weaponId === 0x1F) {
    raised = getDaggerBladeCanvas(); swung = getDaggerBladeSwungCanvas();
  } else if (weaponSubtype === 'knife') {
    raised = getKnifeBladeCanvas(); swung = getKnifeBladeSwungCanvas();
  } else if (weaponSubtype === 'sword') {
    raised = getSwordBladeCanvas(); swung = getSwordBladeSwungCanvas();
  } else if (weaponSubtype === 'nunchaku') {
    raised = getNunchakuBladeCanvas(); swung = getNunchakuBladeSwungCanvas();
  } else if (weaponSubtype === 'staff') {
    raised = getStaffBladeCanvas(); swung = getStaffBladeSwungCanvas();
  } else {
    return null; // rod / claw / unknown / no weapon → no blade overlay (TODO: rod sprite)
  }

  if (attackPhase === 'fwd') {
    if (!swung) return null;
    return { canvas: swung, dx: -16, dy: 1 };
  }

  // back-swing: R hand sits closer to body (+8), L hand reaches further (+16) — NES OAM
  if (!raised) return null;
  return { canvas: raised, dx: visualHand === 'R' ? 8 : 16, dy: -7 };
}

// Decides whether the weapon spec should render BEFORE the body (behind) or AFTER (in front).
// Player/ally: NES OAM rule — R-hand back-swing behind body, L-hand back-swing in front, fwd in front.
// Opponent (mirror): simple "back=behind, fwd=front" rule (canvas already pre-flipped, the body covers
// or is covered by the blade based on draw order, no per-hand layering needed).
export function attackWeaponLayer({ attackPhase, hand, mirror }) {
  if (attackPhase === 'fwd') return 'front';
  if (mirror) return 'behind';
  return hand === 'R' ? 'behind' : 'front';
}
// One source of truth for the rules:
//   • unarmed = R-strike uses rBack tiles, L-strike uses lFwd tiles (per OAM capture)
//   • mirror (opponent face-right pre-flipped canvas) = use opposite hand pose
//   • knife/dagger = single back vs fwd canvas (player pool collapses these; opponent pool keeps them split)
// Caller maps the returned key through its own canvas pool (player: bsc.battlePoses[key],
// ally: ALLY_POSE_MAP, opponent: OPP_POSE_MAP).

export function pickAttackPoseKey({
  weaponSubtype,    // 'knife' | 'dagger' | 'sword' | 'nunchaku' | 'staff' | 'claw' | null
  isUnarmed,        // bool — both hand slots empty
  hand,             // 'R' | 'L' (the swinging hand)
  attackPhase,      // 'back' | 'fwd'
  mirror,           // bool — opponents render from a pre-flipped (face-right) canvas
}) {
  // Mirror rule: pre-flipped opponent canvas inverts L↔R, so to display the correct
  // hand visually after the flip, look up the OPPOSITE hand's pose tiles.
  const visualHand = mirror ? (hand === 'R' ? 'L' : 'R') : hand;

  // Unarmed: strike pose held the entire animation — no separate wind-up.
  // OAM: R-strike = rBack tiles, L-strike = lFwd tiles (NOT lBack — that's nunchuck-L-back).
  if (isUnarmed) {
    return visualHand === 'R' ? 'rBack' : 'lFwd';
  }

  if (weaponSubtype === 'knife' || weaponSubtype === 'dagger') {
    if (attackPhase === 'back') return visualHand === 'R' ? 'knifeR' : 'knifeL';
    return visualHand === 'R' ? 'knifeRFwd' : 'knifeLFwd';
  }

  // Other weapons: separate back-swing vs forward strike poses.
  if (attackPhase === 'back') return visualHand === 'R' ? 'rBack' : 'lBack';
  return visualHand === 'R' ? 'rFwd' : 'lFwd';
}

// ── Pose-key → canvas-pool maps ─────────────────────────────────────────────
// Lives here, NOT in pvp.js / battle-drawing.js, so adding a new pose key only
// requires editing this file. The two roles ('ally' = roster ally portrait,
// 'opp' = PVP opponent full-body) historically had separate maps in different
// files, which made it easy to add a key to one and miss the other. Player
// (`bsc.battlePoses[key]`) is its own pool keyed by job — different shape, not
// wrapped here yet.
//
// Aliasing notes:
//   - Non-knife back-swing keys (rBack/lBack) point at knifeR/L canvases for
//     opp because the knife back-swing is a more distinct silhouette than the
//     1-tile-swap rBack/lBack pose; sword/staff opponents end up sharing the
//     knife back-swing visually. Intentional — see 2026-05-09 audit notes.
//   - Ally rBack/lBack uses fakePlayerAttack/AttackLPortraits (the non-knife
//     pool — different from opp).
const _POSE_MAPS = {
  ally: {
    rBack:     fakePlayerAttackPortraits,
    lBack:     fakePlayerAttackLPortraits,
    rFwd:      fakePlayerKnifeRFwdPortraits,
    lFwd:      fakePlayerKnifeLFwdPortraits,
    knifeR:    fakePlayerKnifeRPortraits,
    knifeL:    fakePlayerKnifeLPortraits,
    knifeRFwd: fakePlayerKnifeRFwdPortraits,
    knifeLFwd: fakePlayerKnifeLFwdPortraits,
  },
  opp: {
    rBack:     fakePlayerKnifeRFullBodyCanvases,
    lBack:     fakePlayerKnifeLFullBodyCanvases,
    rFwd:      fakePlayerKnifeRFwdFullBodyCanvases,
    lFwd:      fakePlayerKnifeLFwdFullBodyCanvases,
    knifeR:    fakePlayerKnifeRFullBodyCanvases,
    knifeL:    fakePlayerKnifeLFullBodyCanvases,
    knifeRFwd: fakePlayerKnifeRFwdFullBodyCanvases,
    knifeLFwd: fakePlayerKnifeLFwdFullBodyCanvases,
  },
};

// Resolve the canvas for a (role, poseKey, jobIdx, palIdx). Returns undefined
// if missing — caller decides the fallback (typically idle full-body for opp,
// idle portrait for ally). When the resolution fails for an attack-state pose,
// emits a one-shot dev-console warning so future intermittent pose drops have
// a paper trail (was: silent fall-through to idle which read as "no back-swing").
//
// Player role: returns from `bsc.battlePoses[poseKey]` directly (rebuilt on job
// change in `loadJobBattleSprites`). The player has a single active palette, so
// `jobIdx` / `palIdx` args are ignored for this role — kept in the signature
// so the API surface is identical across all 3 roles.
const _missLogged = new Set();
export function pickCombatantBody(role, poseKey, jobIdx, palIdx) {
  if (role === 'player') {
    // Player pool is keyed by pose name in `bsc.battlePoses` (rebuilt on job
    // change). No per-palette dimension; jobIdx + palIdx args ignored.
    return bsc.battlePoses && bsc.battlePoses[poseKey];
  }
  const map = _POSE_MAPS[role];
  if (!map) return undefined;
  const dict = map[poseKey];
  if (!dict) {
    _logMiss(role, poseKey, jobIdx, palIdx, 'no-dict');
    return undefined;
  }
  const arr = dict[jobIdx] || dict[0];
  if (!arr) {
    _logMiss(role, poseKey, jobIdx, palIdx, 'no-job-entry');
    return undefined;
  }
  const canvas = arr[palIdx];
  if (!canvas) {
    _logMiss(role, poseKey, jobIdx, palIdx, 'no-palette-canvas');
    return undefined;
  }
  return canvas;
}

function _logMiss(role, key, jobIdx, palIdx, reason) {
  const tag = role + ':' + key + ':' + jobIdx + ':' + palIdx + ':' + reason;
  if (_missLogged.has(tag)) return;
  _missLogged.add(tag);
  if (isDev()) consoleLog('[pose-miss] ' + tag);
}

// Pose keys that represent active attack frames. Used by render sites to
// flag missing-pose telemetry vs benign idle/victory transitions.
export const ATTACK_POSE_KEYS = new Set([
  'rBack', 'lBack', 'rFwd', 'lFwd', 'knifeR', 'knifeL', 'knifeRFwd', 'knifeLFwd',
]);
