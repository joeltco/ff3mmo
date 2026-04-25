// combatant-pose.js — picks the canonical pose key for a combatant's current attack frame.
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
