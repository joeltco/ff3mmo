// Summon tier table — each summon has THREE effects and the caster's JOB picks
// which one fires.
//
// This is FF3 mechanics, sourced, not measured off the ROM and not invented:
//   • Evoker  — randomly casts one of the FIRST TWO. One is usually a support
//               or status effect on everyone; the other is a direct attack on a
//               SINGLE enemy.
//   • Summoner — always the THIRD. Always a direct attack, always ALL enemies,
//               far higher power.
//   • Sage    — on NES uses the SUMMONER version, not the two-effect one.
//
// Sources: Final Fantasy Wiki "Magic (Final Fantasy III)", Gamer Corner Guides
// (Evoker / Summoner job pages), Steam Community FF3 summons guide.
//
// Independent corroboration from the ROM itself: STRING_SUMMONS ($0607) holds
// each creature's name THREE times — Chocobo x3, Shiva x3, Ramuhr x3 and so on
// — one entry per effect. That is what made the three-tier structure visible
// before any of this was looked up.
//
// NOTE this is a GAMEPLAY difference, not an art one. Conjurer and Sage load
// byte-identical creature and cast art in capture (verified across varied RNG),
// so the tier changes which effect fires, its power and its targeting — not
// which creature appears.
//
// `all: true` hits every enemy; `all: false` is single-target.
// `kind`: 'damage' | 'status' | 'heal' | 'buff' | 'escape' | 'instakill'.

export const SUMMON_TIERS = new Map([
  [0x37, {   // Chocobo
    evoker: [
      { name: 'Dash',      kind: 'escape',    all: false, power: 0 },
      { name: 'Kick',      kind: 'damage',    all: false, power: 16 },
    ],
    summoner: { name: 'Chocobo Kick', kind: 'damage', all: false, power: 16 },
  }],
  [0x30, {   // Shiva
    evoker: [
      { name: 'Mesmerize', kind: 'status',    all: true,  power: 0, status: 'sleep', hit: 80 },
      { name: 'Icy Stare', kind: 'damage',    all: false, power: 53, element: 'ice' },
    ],
    summoner: { name: 'Diamond Dust', kind: 'damage', all: true, power: 32, element: 'ice' },
  }],
  [0x29, {   // Ramuh
    evoker: [
      { name: 'Mind Blast',   kind: 'status', all: true,  power: 0, status: 'paralysis', hit: 70 },
      { name: 'Thunderstorm', kind: 'damage', all: false, power: 48, element: 'bolt' },
    ],
    summoner: { name: 'Judgment Bolt', kind: 'damage', all: true, power: 96, element: 'bolt' },
  }],
  [0x22, {   // Ifrit
    evoker: [
      { name: 'Healing Light', kind: 'heal',  all: true,  power: 90 },
      { name: 'Hellfire',      kind: 'damage', all: false, power: 85, element: 'fire' },
    ],
    summoner: { name: 'Inferno', kind: 'damage', all: true, power: 128, element: 'fire' },
  }],
  [0x1b, {   // Titan
    evoker: [
      { name: 'Clobber', kind: 'damage', all: false, power: 101, element: 'earth' },
      { name: 'Stomp',   kind: 'damage', all: false, power: 106 },
    ],
    summoner: { name: 'Earthen Fury', kind: 'damage', all: true, power: 160, element: 'earth' },
  }],
  [0x14, {   // Odin
    evoker: [
      { name: 'Protective Light', kind: 'buff',   all: true,  power: 0 },
      { name: 'Slash',            kind: 'damage', all: false, power: 117 },
    ],
    // Zantetsuken — this is the slice. Instantly KOs every enemy.
    summoner: { name: 'Zantetsuken', kind: 'instakill', all: true, power: 195 },
  }],
  [0x0d, {   // Leviathan
    evoker: [
      { name: 'Demon Eye', kind: 'status', all: true, power: 0, status: 'petrify', hit: 5 },
      { name: 'Cyclone',   kind: 'damage', all: true, power: 133, element: 'air' },
    ],
    summoner: { name: 'Tidal Wave', kind: 'damage', all: true, power: 202, element: 'water' },
  }],
  [0x06, {   // Bahamut
    evoker: [
      { name: 'Aura', kind: 'buff',      all: true,  power: 0 },
      { name: 'Rend', kind: 'instakill', all: false, power: 144 },
    ],
    summoner: { name: 'Mega Flair', kind: 'damage', all: true, power: 255 },
  }],
]);

// Job indices from src/data/jobs.js. Conjurer is FF3's Evoker; Summoner and
// Sage both fire the third effect on NES.
export const JOB_CONJURER = 15;
export const JOB_SUMMONER = 17;
export const JOB_SAGE = 20;

/** 'evoker' for the Conjurer, 'summoner' for Summoner and Sage. */
export function summonTierForJob(jobIdx) {
  return jobIdx === JOB_CONJURER ? 'evoker' : 'summoner';
}
