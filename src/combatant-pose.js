// combatant-pose.js — picks the canonical pose key + hand-weapon draw spec for a combatant's
// current attack frame. Centralizes the rules so player/ally/opponent renderers stop diverging.

import { getKnifeBladeCanvas, getKnifeBladeSwungCanvas,
         getDaggerBladeCanvas, getDaggerBladeSwungCanvas,
         getSwordBladeCanvas, getSwordBladeSwungCanvas,
         getNunchakuBladeCanvas, getNunchakuBladeSwungCanvas,
         getFistCanvas } from './weapon-sprites.js';

const FIST_WOBBLE_PERIOD_MS = 100; // shared cadence — same constant across player/ally/opponent

// Returns the weapon canvas + body-relative offset to draw at, or null if nothing to draw this frame.
// Mirror flag: opponent uses a pre-flipped (face-right) canvas, so the swinging hand visually swaps
// — the offset returned is in the post-flip coordinate system.
export function pickAttackWeaponSpec({
  weaponId,            // hand's weapon item ID
  weaponSubtype,       // 'knife' | 'dagger' | 'sword' | 'nunchaku' | 'claw' | null
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
  } else {
    return null; // claw / unknown / no weapon → no blade overlay
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
  weaponSubtype,    // 'knife' | 'dagger' | 'sword' | 'nunchaku' | 'claw' | null
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
