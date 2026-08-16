// ff2-encounters.mjs — FF2's encounter tables are NOT decoded. This is why.
//
// ⛔ NOTHING HERE IS A TABLE ADDRESS. The blocker is upstream of the tables: no
// FF2 battle has ever been reached in this harness, so there is nothing to
// measure against and no way to calibrate a detector. Recording the dead ends so
// the next attempt starts where this one stopped.
//
// WHAT A DETECTOR NEEDS
// FF1 and FF3 each have a verified "am I in a battle" tell — the word RUN on
// FF1's screen, `Guard`/`Item` on FF3's. Both were confirmed by seeing them
// appear only in battle. FF2's battle menu is KANA, so the equivalent means
// decoding the battle screen with `ff2-text.mjs`'s glyph table... which cannot be
// done until a battle is on screen at least once.
//
// ⛔ FALSE TELL #1 — "the enemy RAM is nonzero". `ENEMY_RAM` ($7E3A) already
// holds nonzero bytes while standing on the MAP, so this fires instantly and
// reports a battle from frame one. It is stale data, not a battle.
//
// ⛔ FALSE TELL #2 — "the nametable changed and settled". Map scrolling changes
// up to ~42% of the nametable, and a settled screen after 16 steps turned out to
// be more map: the decoded tiles are terrain (ベボボ...), and the enemy RAM was
// byte-identical to its map contents.
//
// WHAT WAS ESTABLISHED
//   ⭐ $0069 is the party's Y — it steps 0x1B -> 0x14 walking UP, in lockstep
//      with $2A, $2C, $2F, $30 and $F5, then sticks at 0x14 against blocked
//      terrain. ($68 is presumably X, by the FF3 convention.)
//   ⭐ The party DOES move: 74 RAM bytes change while walking, and it covers ~31
//      distinct tiles. It is not frozen; there is simply nothing to fight here.
//   ⛔ No encounter in 3000 steps in every direction, from the savestate's own
//      position or after poking $68/$69 to eight different coordinates — every
//      one of which produced an IDENTICAL result, so the poke is not taking. FF1
//      has the same trap: its $68/$69 are not writable and only the overworld's
//      $27/$28 are.
//   ⛔ There is also no step counter in zero page: no byte decreases as the party
//      walks, so FF2 appears to roll per step rather than count down to one.
//
// WHERE TO START NEXT
// The savestate is the problem, not the search. `tools/states/ff2-outside.state.gz`
// is somewhere without random encounters. Either drive FF2 from boot to the
// overworld and save there, or do what `ff1-goto.mjs` does — find the entrance
// table, repoint a reachable door at an encounter map, and walk through it.
export const NOT_DECODED = true;
export const PARTY_Y_ZP = 0x0069;
export const PARTY_X_ZP = 0x0068;          // by convention, NOT confirmed
export const COORD_MIRRORS = [0x2A, 0x2C, 0x2F, 0x30, 0xF5];
export const FALSE_TELLS = ['enemy RAM nonzero on the map', 'nametable changed and settled'];
