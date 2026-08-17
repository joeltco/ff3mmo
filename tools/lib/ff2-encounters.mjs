// ff2-encounters.mjs — FF2's encounter tables are NOT decoded. This is why.
//
// ⭐⭐ UPDATE (v1.9.0): **FF2 BATTLES ARE NOW REACHABLE.** The blocker described
// below is gone. `tools/ff2-location-sweep.mjs` enters every location id via
// `lib/ff2-locations.mjs#enterLocation` and walks; 99 of 256 locations produce a
// battle within 60 steps. VERIFIED BY RENDERING, not by a heuristic: location
// 0x29 draws four purple beasts, location 0x60 draws three green bombs plus two
// armoured soldiers — different encounters in different places.
//
// ⛔⛔ THE OBVIOUS DETECTOR IS A FALSE TELL, and it fooled me for a whole pass.
// ">85% of the nametable changed" fires on a MAP TRANSITION: walking into an exit
// redraws everything. The first sweep reported 111 "battles"; rendering two showed
// both fired at the SAME step, with the party at the SAME coords, and `$48`
// changed to 1 — they were EXITS. ⭐ THE DISCRIMINATOR: a battle leaves the
// location id `$48` ALONE; an exit changes it. With that added, 12 of the 111
// turned out to be exits.
// ⛔ Also: `nes.opts.onFrame` assigned AFTER construction never fires, so the
// verification screenshots came out empty until onFrame was passed to `new NES`.
//
// ⛔⛔ TWO DISPROVEN LEADS FOR "formation id -> monsters" (v1.9.2). Do NOT re-chase:
//   1. `LDA $6A` at bank 1 $80FD is a FALSE MATCH — those bytes are DATA, part of
//      a pointer table ($A56A, $A5A4, $A5D8, $A60D ... monotonic LE words). A
//      static opcode scan cannot tell code from data; hook the read instead.
//   2. The address-delta differential (force formation 0x2B vs 0x77, diff the ROM
//      reads) DID find a contiguous range differing by exactly 0x4C — base $9B95
//      in BANK 8 = file 0x21BA5, read by `LDA ($02),Y` at $FD73. ⛔ BUT PATCHING
//      BYTES AT `0x21BA5 + formation` CHANGES NOTHING ON SCREEN (tested offsets
//      0-4). So it is NOT the formation record — it is a copy loop whose SOURCE
//      happens to shift with the formation, almost certainly graphics. The
//      delta trick finds correlated addresses; only a PATCH proves causation.
//
// ➡ STILL OPEN: the encounter TABLES themselves — which per-location table maps a
// location to its encounter set, and where the formations live. The way in is now
// to hook a battle-start and see which `$48`-indexed table was read; the candidate
// tables already found are `$9400` ($CAA5), `$8100` ($CF77), `$8000` ($D128) and
// `$7600` (RAM, bank 5 $AB2D).
//
// ⭐⭐ UPDATE (v1.8.98): THE MOVEMENT BLOCKER BELOW IS SOLVED. `lib/ff2-locations.mjs`
// warps to ANY location id — `$48` is the location id, the location->tilemap table
// is at file 0x3210 ($B200, bank 0), and the loader is invoked by planting a stub
// in the free RAM after FF2's NMI trampoline (its NMI vector is $0100, in RAM) and
// letting the game's own interrupt call `$D083`. Proven by patching one location's
// table entry to another's tilemap and watching it decompress the other's map,
// both directions, with the unpatched runs still differing.
// ⭐ SO THE NEXT ATTEMPT AT THE ENCOUNTER TABLES SHOULD START BY WARPING to a
// location that actually has encounters, then re-testing the detectors below —
// several of the "false tells" were only false because no battle was reachable.
// ⛔ The dead ends below are still worth reading: they are why walking, boot
// driving, and hunting a warp table all failed. Don't re-run them.
//
// ⛔ NOTHING HERE IS A TABLE ADDRESS. The blocker WAS upstream of the tables: no
// FF2 battle had ever been reached in this harness, so there was nothing to
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
// THE BOOT ROUTE WAS TRIED — `tools/ff2-make-field-state.mjs`
// It drives FF2 from boot headlessly and DOES reach the game: past the title, the
// opening crawl and the kana name grid (using `ff2-build-playable-rom.mjs`'s
// one-byte gate patch), out to a party with real HP and gil and no menu up.
//
// ⛔ It still does not produce a usable overworld state, for two measured reasons:
//   * the map NEVER redraws — 0 of 240 walking steps changed the nametable, and
//     only ~5 distinct tiles are visited, so the party is not under player control
//     there; it is an auto-moving sequence, not the field;
//   * the state does NOT replay on the stock rom — reloaded against it the party
//     drifts to a different position (138,34 -> 170,35) with no input at all.
//     The generator REFUSES to write in that case rather than shipping a state
//     that only works under its own patch.
//
// ⛔ Mashing past the intro is also load-bearing in a way that bites: pressing B
// to clear menus runs all the way back to the TITLE SCREEN if it is done blindly.
// Back out one press at a time and stop the moment no menu word is on screen.
//
// THE ff1-goto ROUTE WAS TRIED TOO — and FF2's warp table is not located.
// `ff1-goto.mjs` works because FF1's entrance tables are known: three parallel
// arrays at $AC00/$AC20/$AC40 (destination X, Y, MAP). Repoint the one door the
// party can reach and you are anywhere. FF2 has no such table in this repo, and
// two ways of finding it failed:
//   * Hunting the MAP ID in RAM across boot-time screen changes returns only
//     sprite bitmap rows ($0341-$0350, values like 3C/FF/C3) and stack bytes —
//     the change detector fires on animation, so the snapshots are not map loads.
//   * `MAPOBJ_TABLE` (0x3510), the one FF2 map table the repo does have, is
//     3-byte `type/x/y` records — NPCs and objects. There is no destination
//     field in it, so it is not the warp table.
//
// ⛔ THREE APPROACHES HAVE NOW DEAD-ENDED: walking from `ff2-outside` (blocked,
// no encounter in 3000 steps), driving from boot (reaches the game but lands in
// an auto-move sequence whose state will not replay on the stock rom), and
// locating a warp table (above). Each is recorded so a fourth attempt does not
// re-run them.
//
// WHERE TO START NEXT
// The cheapest unblock is external: FF2 map/warp documentation — which map ids
// are overworld, and what the starting area connects to. With a destination map
// id and the warp table's shape, the ff1-goto trick is a short job. Without one,
// the next honest step is tracing a REAL map transition, which needs the party
// under player control, which is the thing that is blocked.
export const NOT_DECODED = true;
export const PARTY_Y_ZP = 0x0069;
export const PARTY_X_ZP = 0x0068;          // by convention, NOT confirmed
export const COORD_MIRRORS = [0x2A, 0x2C, 0x2F, 0x30, 0xF5];
export const FALSE_TELLS = ['enemy RAM nonzero on the map', 'nametable changed and settled'];
