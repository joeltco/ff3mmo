#!/usr/bin/env node
// check-battle-sfx.mjs — FF3's battle sounds match the events they were
// attributed to, and every SFX constant has a provenance record.
//
// Five constants (CONFIRM, ATTACK_HIT, KNIFE_HIT, MONSTER_DEATH, MAGIC_CAST)
// were measured back in v1.7.873 but lived only in prose comments — no tier, so
// nothing could hold them. v1.8.5 attributed each to its event with
// `tools/monscan/battle-sfx-capture.cjs` and put them in CAPTURED_BATTLE_SFX.
//
// The catch worth gating: capturing the two HIT sounds needs two DIFFERENT
// encounters. The party's hit lands in any fight, but the monster's hit needs a
// goblin that survives AND still attacks — the sweep's standard goblin is
// unkillable but HARMLESS, and $b0 never fired once across two full runs with it.
//
//   node tools/check-battle-sfx.mjs

await import('./lib/browser-shim.mjs');
const { SFX } = await import('../src/music.js');
const { CAPTURED_WORLD_SFX, CAPTURED_WORLD_SONGS, CAPTURED_BATTLE_SFX } =
  await import('../src/data/world-sfx-captured.js');
const { CAPTURED_SPELL_SFX } = await import('../src/data/spell-sfx-captured.js');

let fails = 0;
const fail = (m) => { console.error('  FAIL  ' + m); fails++; };
const ok = (m) => console.log('  ok    ' + m);

// Measured on a real battle, screenshot-attributed. Pinned literally.
const MEASURED = new Map([
  ['CONFIRM',        70],   // every command pick, 59 of them
  ['ATTACK_HIT',    113],   // a MONSTER hitting a PARTY MEMBER ("Goblin" -> "FFFKKK")
  ['KNIFE_HIT',     119],   // a PARTY MEMBER hitting a MONSTER ("PUUUUU" -> "Goblin", 1xHit)
  ['MONSTER_DEATH', 114],   // a monster dying, 64f after the killing hit
  ['MAGIC_CAST',     98],   // the pre-animation cast cue, before every impact
]);

console.log('\nbattle sounds (attributed v1.8.5)');
for (const [name, want] of MEASURED) {
  if (SFX[name] !== want) fail(`SFX.${name} is ${SFX[name]}, measured ${want}`);
  else if (CAPTURED_BATTLE_SFX.get(name) !== want) fail(`CAPTURED_BATTLE_SFX has no/other record for ${name}`);
  else ok(`${name.padEnd(14)} -> ${want}`);
}

// The two hit sounds are DIFFERENT events in FF3 (who hits whom). If they ever
// collapse to one value, the bladed/blunt split silently stops existing.
if (SFX.ATTACK_HIT === SFX.KNIFE_HIT) {
  fail('ATTACK_HIT and KNIFE_HIT are the same track — the bladed/blunt split plays one sound');
} else ok('the two hit sounds stay distinct');

// ── every SFX constant has SOME provenance record ────────────────────────
// This is the check that would have caught the original gap: five constants
// with no tier at all, carried only in comments.
console.log('\nprovenance coverage');
const spellTracks = new Set(CAPTURED_SPELL_SFX.values());
const orphans = [];
for (const [name, track] of Object.entries(SFX)) {
  const covered =
    CAPTURED_WORLD_SFX.get(name) === track ||
    CAPTURED_WORLD_SONGS.get(name) === track ||
    CAPTURED_BATTLE_SFX.get(name) === track ||
    spellTracks.has(track);
  if (!covered) orphans.push(`${name} (${track})`);
}
if (orphans.length) fail(`SFX constants with no provenance record: ${orphans.join(', ')}`);
else ok(`all ${Object.keys(SFX).length} SFX constants have a provenance record`);

console.log(fails ? `\ncheck-battle-sfx: ${fails} FAILED` : '\ncheck-battle-sfx: all checks passed');
process.exit(fails ? 1 : 0);
