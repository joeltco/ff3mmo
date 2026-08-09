// Monster short-name overrides — hand-maintained, NOT generated.
//
// This lives in its own module because src/data/monsters.js is produced by
// `node tools/gen-monsters-js.js > src/data/monsters.js`, and that generator's
// output ends at the MONSTERS map's closing bracket. While this map sat below
// it in the same file, following the documented regeneration workflow silently
// destroyed all 121 names.
//
// Shrines short-name overrides for monsters. Used by the in-battle enemy
// name box (battle-draw-menu.js _battleEnemyName / _battleEnemyNames).
// Battle-log message queue (battle-turn.js) and any future mid-sentence
// callers stay on the raw getMonsterName ROM bytes — same boundary as
// items/spells.
//
// Source: shrines.rpgclassics.com/nes/ff3/enemies1.shtml + enemies2.shtml.
// Only entries with an unambiguous ROM → Shrines pairing are listed.
// Entries where the rename is unclear (Larva, Helldiver, Parademon,
// Hellgaroo, Dracrocotta, ShadwMaster, Aeon, Drake, Azer, etc.) are
// omitted and fall through to the ROM name via getMonsterName.
//
// Punctuation in Shrines names (`.` in "Bone D.", "K. Lizard", "Q.Lamia",
// "Liger S.") is dropped on render — `_asciiToTileByte` only encodes
// A-Z/a-z/0-9. The remaining letters still read correctly.
export const MONSTER_NAMES_SHRINES = new Map([
  [0x02, 'EyeFang'],
  [0x03, 'BlueWisp'],     [0x04, 'KillerBee'],    [0x07, 'RedWisp'],      [0x08, 'DarkEye'],
  [0x0C, 'CurseCoin'],    [0x10, 'Firefry'],      [0x12, 'RustBird'],     [0x17, 'UnneCln'],      [0x19, 'DarkFace'],
  [0x1A, 'Puti'],         [0x1B, 'PoisonBat'],    [0x1C, 'Liliput'],
  [0x1D, 'WereRat'],      [0x1E, 'BloodWorm'],    [0x1F, 'KillerFish'],
  [0x21, 'SeaElmntl'],    [0x22, 'Tangi'],
  [0x23, 'Sahuagin'],     [0x2A, 'LizardMan'],    [0x2B, 'Gorgone'],      [0x2C, 'RedCap'],
  [0x30, 'Cafjel'],       [0x31, 'Pygman'],       [0x33, 'BloodBat'],
  [0x34, 'PutiMage'],     [0x36, 'Ohishuki'],     [0x39, 'Boulder'],      [0x3A, 'SeaDevil'],
  [0x3C, 'RuinWave'],     [0x3E, 'Milmecoreo'],   [0x40, 'Adamantai'],
  [0x41, 'RedMallow'],    [0x43, 'Lemwraith'],
  [0x45, 'Daemon'],       [0x47, 'Anetto'],       [0x4A, 'SeaSerpnt'],    [0x4B, 'Cocktrice'],    [0x4C, 'VenomToad'],
  [0x4D, 'TwinHead'],     [0x4F, 'Agaria'],
  [0x50, 'DarkFoot'],     [0x51, 'GiganToad'],    [0x52, 'TwinLiger'],
  [0x53, 'Storoper'],     [0x54, 'Pudding'],      [0x5A, 'GoldEagle'],    [0x5B, 'GoldWarr'],
  [0x5C, 'GoldBear'],     [0x5D, 'GoldKngt'],     [0x60, 'Needler'],      [0x64, 'SandWorm'],     [0x65, 'Icefry'],       [0x6B, 'DevilHorse'],   [0x6C, 'RockGargoyl'], [0x6D, 'BullMan'],
  [0x6E, 'DarkKngt'],     [0x6F, 'MageFlyer'],    [0x71, 'Abuto'],
  [0x72, 'Nepto'],        [0x75, 'Dirai'],
  [0x76, 'MChimera'],     [0x77, 'KLizard'],      [0x78, 'Pterosaur'],
  [0x7B, 'Seaking'],
  [0x7E, 'BossTroll'],
  [0x7F, 'Fahan'],        [0x80, 'Kenkos'],       [0x81, 'Balfrey'],
  [0x82, 'Dosmea'],       [0x83, 'SeaWitch'],     [0x85, 'OlogHai'],
  [0x87, 'Aegil'],        [0x89, 'Sirenos'],      [0x8E, 'DZombie'],      [0x8F, 'DeathClaw'],    [0x90, 'HellHorse'],
  [0x91, 'Cronos'],       [0x92, 'Valar'],        [0x9A, 'DthNeedle'],    [0x9C, 'ZandeCln'],
  [0xA0, 'Planktae'],
  [0xA1, 'SeaLion'],      [0xA5, 'GtBoros'],      [0xA6, 'LigerS'],       [0xA7, 'QLamia'],
  [0xA8, 'IronClaw'],     [0xA9, 'GtDaemon'],     [0xAB, 'BoneD'],        [0xAC, 'KBehemoth'],    [0xAD, 'DorgaCln'],
  [0xAE, 'GreenD'],       [0xAF, 'Abai'],         [0xB2, 'Acheron'],      [0xB3, 'Oceanos'],
  [0xB5, 'Gomoree'],      [0xB6, 'Bluk'],
  [0xB9, 'Qumqum'],       [0xBD, 'DGeneral'],     [0xC1, 'Jormungnd'],
  [0xC3, 'Hekaton'],      [0xC5, 'QScylla'],      [0xC7, 'DoubleD'],
  [0xC8, 'YellowD'],      [0xCC, 'LandTurtl'],    [0xCD, 'Jinn'],
  [0xCE, 'BigRat'],       [0xD0, 'Guzco'],
  [0xD1, 'Salamandr'],    [0xD2, 'Hyne'],         [0xD7, 'Dorga'],
  [0xD8, 'Unne'],         [0xDF, 'RedD'],         [0xE2, '2HeadD'],
  // The six dummied-out enemies, named from The Cutting Room Floor's FF3 (NES)
  // page rather than Shrines — they have no Shrines entry because they appear in
  // no encounter monster list in EITHER the English or Japanese ROM, so the game
  // never shows their names anywhere. Identified by matching TCRF's stat blocks
  // against MONSTERS, corroborated by which artwork each one shares:
  //   0x35 Fury      — lvl/HP/EXP/gil all exact; shares Harpy art; our
  //                    location 'tower_owen' matches TCRF's DS-remake note
  //   0x63 Captain   — lvl 34 / 315 HP; shares Goblin art, and TCRF reads it as
  //                    a cut surface-overworld goblin
  //   0x66 Phoenix   — all four stats exact; shares Rust Bird (a bird) art
  //   0x8D Hobgoblin — lvl 48 / 320 EXP; shares Goblin art, paired with Captain
  //                    by TCRF as the goblins cut from outside the Floating Continent
  //   0xBE Spriggan  — all four stats exact; shares Ogre art, TCRF captions it "IcOgre"
  //   0xBF TerribleD — lvl/EXP/gil exact; shares GreenDragon art. Abbreviated to
  //                    match the ROM's own convention for dragons (RedD, 2HeadD).
  [0x35, 'Fury'],         [0x63, 'Captain'],      [0x66, 'Phoenix'],
  [0x8D, 'Hobgoblin'],    [0xBE, 'Spriggan'],     [0xBF, 'TerribleD'],
  // 0x59 LostGold — TCRF's seventh dummied enemy, matched on all four stats
  // (lvl 30 / 265 HP / 560 EXP / 310 gil). Unlike the six above it DOES sit in
  // an encounter monster list (98, pal 172/167), which is why its sprite and
  // palette were already correct and only its name was missing; TCRF notes it
  // is reachable in one Goldor Manor room but hard to trigger.
  [0x59, 'LostGold'],
]);
