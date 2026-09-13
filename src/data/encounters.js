// Encounter Catalog — GENERATED FROM THE FF3 ROM.
//
//   node tools/gen-encounters.mjs --write
//
// ⛔ DO NOT HAND-EDIT the generated zones. Every number below is pulled from the
// cartridge by `tools/lib/ff3-map-encounters.mjs`, which carries the CPU trace
// that decoded the chain:
//
//   map id ($48)  -> $92F0[map]            = the map's encounter GROUP
//   group         -> $94F0 + group*8       = EIGHT formation ids
//   slot          -> $BD78[random & 0x3F]  = 12/12/12/12/6/6/3/1 out of 64
//   formation     -> $5C010                = species record + count pattern
//   rate          -> $BE00[map]            = chance out of 256, checked per step
//
// ⭐ THE ODDS ARE THE POINT. Before this, every formation in a zone was equally
// likely because the zones were authored by hand and nothing said otherwise. The
// cartridge gives each group eight weighted slots, so a group's last entry is a
// 1-in-64 rarity — Altar Cave B1F is Goblins 63 times out of 64 and Eye
// Fang + Carbuncle once, not the coin-flip we were shipping.
//
// ⛔ RATE IS A PER-STEP PROBABILITY OUT OF 256, not a step count. Dungeon floors
// are 6/256 (~1 per 43 steps) and world-0 grass is 5/256 (~1 per 51); the
// step-threshold model this replaced ran roughly twice as hot.

/** ROM $BD78: how many of the 64 random values land on each of a group's 8 slots. */
export const SLOT_ODDS = [12, 12, 12, 12, 6, 6, 3, 1];

/**
 * Does this step start a fight? The cartridge's own test, at bank 61 $BDBD:
 * `JSR $C711 / CMP $F8 / BCS` — random(0..255) < the map's rate.
 */
export function rollEncounter(zone, rnd = Math.random) {
  const rate = zone ? zone.rate | 0 : 0;
  return rate > 0 && Math.floor(rnd() * 256) < rate;
}

/**
 * Which world-0 zone a tile sits in.
 *
 * The cartridge's own arithmetic, bank 61 $BCE6 — the column is
 * `(x+7) & $7F >> 5` and the row is `(y+7) & $60 >> 3`, which already folds
 * in the *4. The +7 is the ROM's: it shifts the region boundaries half a
 * screen, so dropping it would silently mis-assign a 7-tile band along every
 * edge.
 */
export function world0ZoneKey(tileX, tileY) {
  const idx = (((tileX + 7) & 0x7F) >> 5) | (((tileY + 7) & 0x60) >> 3);
  return 'world_r' + idx;
}

/**
 * Pick one of a zone's formations using the ROM's weights.
 *
 * ⛔ SINGLE SOURCE — the client (`battle-encounter.js`) and the PvE arbiter
 * (`pve-arbiter.js`) both call this. A local copy in either would drift and the
 * arbiter's replay-validate would start rejecting honest battles.
 */
export function pickFormation(zone, rnd = Math.random) {
  const fs = zone && zone.formations;
  if (!fs || !fs.length) return [{ id: 0x00, min: 1, max: 3 }];
  const w = zone.weights;
  if (!w || w.length !== fs.length) return fs[Math.floor(rnd() * fs.length)];
  let total = 0;
  for (const x of w) total += x;
  let r = Math.floor(rnd() * total);
  for (let i = 0; i < fs.length; i++) { r -= w[i]; if (r < 0) return fs[i]; }
  return fs[fs.length - 1];
}

export const ENCOUNTERS = new Map([
  // ── World map (FF3 world 0, 128x128) ──────────────────────────────────────
  //
  // The cartridge splits it into a 4x4 grid of 32-tile REGIONS (bank 61 $BCE6:
  // `(x+7)&$7F >>5` and `(y+7)&$60 >>3`), each with its own group. On foot the
  // rate is one constant, $9D47 = 5/256.
  // x 0-31, y 0-31
  ['world_r0', {
    rom: { world: 0, region: 0, group: 0x3c },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x28, min: 2, max: 4 }],   // 0x3c  Knocker x2-4
      [{ id: 0x29, min: 1, max: 2 }, { id: 0x2b, min: 1, max: 2 }],   // 0x3d  Flyer x1-2 + Gorgon x1-2
      [{ id: 0x2a, min: 2, max: 4 }],   // 0x3e  Lizardman x2-4
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  // x 32-63, y 0-31
  ['world_r1', {
    rom: { world: 0, region: 1, group: 0x3c },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x28, min: 2, max: 4 }],   // 0x3c  Knocker x2-4
      [{ id: 0x29, min: 1, max: 2 }, { id: 0x2b, min: 1, max: 2 }],   // 0x3d  Flyer x1-2 + Gorgon x1-2
      [{ id: 0x2a, min: 2, max: 4 }],   // 0x3e  Lizardman x2-4
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  // x 64-95, y 0-31
  ['world_r2', {
    rom: { world: 0, region: 2, group: 0x2d },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [33, 18, 12, 1],   // out of 64
  }],
  // x 96-127, y 0-31
  ['world_r3', {
    rom: { world: 0, region: 3, group: 0x2d },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [33, 18, 12, 1],   // out of 64
  }],
  // x 0-31, y 32-63
  ['world_r4', {
    rom: { world: 0, region: 4, group: 0x3f },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x2c, min: 2, max: 4 }],   // 0x3f  Red Cap x2-4
      [{ id: 0x2d, min: 2, max: 4 }],   // 0x40  Barometz x2-4
      [{ id: 0x2f, min: 1, max: 2 }, { id: 0x2e, min: 1, max: 2 }],   // 0x41  Tarantula x1-2 + Slime x1-2
      [{ id: 0x30, min: 2, max: 4 }],   // 0x42  Cuphgel x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // x 32-63, y 32-63
  ['world_r5', {
    rom: { world: 0, region: 5, group: 0x3c },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x28, min: 2, max: 4 }],   // 0x3c  Knocker x2-4
      [{ id: 0x29, min: 1, max: 2 }, { id: 0x2b, min: 1, max: 2 }],   // 0x3d  Flyer x1-2 + Gorgon x1-2
      [{ id: 0x2a, min: 2, max: 4 }],   // 0x3e  Lizardman x2-4
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  // x 64-95, y 32-63
  ['world_r6', {
    rom: { world: 0, region: 6, group: 0x2d },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [33, 18, 12, 1],   // out of 64
  }],
  // x 96-127, y 32-63
  ['world_r7', {
    rom: { world: 0, region: 7, group: 0x2d },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [33, 18, 12, 1],   // out of 64
  }],
  // x 0-31, y 64-95
  ['world_r8', {
    rom: { world: 0, region: 8, group: 0x39 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x25, min: 2, max: 4 }],   // 0x39  Griffon x2-4
      [{ id: 0x26, min: 2, max: 4 }],   // 0x3a  Lynx x2-4
      [{ id: 0x24, min: 1, max: 2 }, { id: 0x27, min: 2, max: 4 }],   // 0x3b  Parademon x1-2 + Hornet x2-4
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  // x 32-63, y 64-95
  ['world_r9', {
    rom: { world: 0, region: 9, group: 0x39 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x25, min: 2, max: 4 }],   // 0x39  Griffon x2-4
      [{ id: 0x26, min: 2, max: 4 }],   // 0x3a  Lynx x2-4
      [{ id: 0x24, min: 1, max: 2 }, { id: 0x27, min: 2, max: 4 }],   // 0x3b  Parademon x1-2 + Hornet x2-4
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  // x 64-95, y 64-95
  ['world_r10', {
    rom: { world: 0, region: 10, group: 0x2f },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // x 96-127, y 64-95
  ['world_r11', {
    rom: { world: 0, region: 11, group: 0x30 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // x 0-31, y 96-127
  ['world_r12', {
    rom: { world: 0, region: 12, group: 0x39 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x25, min: 2, max: 4 }],   // 0x39  Griffon x2-4
      [{ id: 0x26, min: 2, max: 4 }],   // 0x3a  Lynx x2-4
      [{ id: 0x24, min: 1, max: 2 }, { id: 0x27, min: 2, max: 4 }],   // 0x3b  Parademon x1-2 + Hornet x2-4
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  // x 32-63, y 96-127
  ['world_r13', {
    rom: { world: 0, region: 13, group: 0x30 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // x 64-95, y 96-127
  ['world_r14', {
    rom: { world: 0, region: 14, group: 0x30 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // x 96-127, y 96-127
  ['world_r15', {
    rom: { world: 0, region: 15, group: 0x30 },
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
      [{ id: 0x06, min: 3, max: 6 }],   // 0x2f  Berserker x3-6
      [{ id: 0x06, min: 1, max: 2 }, { id: 0x05, min: 2, max: 4 }],   // 0x30  Berserker x1-2 + Werewolf x2-4
    ],
    weights: [18, 18, 15, 13],   // out of 64
  }],
  // ── The Ur starter zone — ⛔ THE ONE ZONE THAT IS NOT THE ROM'S ───────────
  //
  // A deliberate design decision (v1.7.945), kept: within 8 tiles of Ur the
  // world rolls Goblins instead of what the cartridge puts there. The
  // cartridge's own answer for Ur's region is `world_r7` below — Killer Bees,
  // Werewolves and Berserkers, which an L1 party leaving town for the first
  // time does not survive. Everything OUTSIDE the radius is the ROM's.
  ['grasslands_valley', {
    rom: null,   // ⛔ ours, not the cartridge's
    rate: 5,   // out of 256 per step — ~1 per 51 steps
    formations: [
      [{ id: 0x00, min: 1, max: 3 }],   // Goblin x1-3
    ],
    weights: [64],
  }],
  // The Ur dark-tile encounter patch (src/map-loading.js). ⛔ NOT world_r7 —
  // that is the region Ur SITS IN; this is the town map's own table, and the
  // two differ (no Berserker, and a much hotter rate).
  ['grasslands_wild', {
    rom: { map: 114, group: 0x31 },
    rate: 18,   // out of 256 per step — ~1 per 14 steps
    formations: [
      [{ id: 0x04, min: 2, max: 4 }],   // 0x2d  Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }],   // 0x2e  Werewolf x2-4
    ],
    weights: [40, 24],   // out of 64
  }],
  // ── Altar Cave — ROM maps 111, 115, 112, 113, 22 ──────────────────────────
  ['altar_cave_f1', {
    rom: { map: 111, group: 0x00 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x00, min: 2, max: 4 }],   // 0x00  Goblin x2-4
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }],   // 0x01  Eye Fang x1-2 + Carbuncle x1-2
    ],
    weights: [63, 1],   // out of 64
  }],
  ['altar_cave_f2', {
    rom: { map: 115, group: 0x01 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }],   // 0x01  Eye Fang x1-2 + Carbuncle x1-2
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }],   // 0x02  Blue Wisp x1-2 + Carbuncle x2-4
    ],
    weights: [60, 4],   // out of 64
  }],
  ['altar_cave_f3', {
    rom: { map: 112, group: 0x02 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }],   // 0x02  Blue Wisp x1-2 + Carbuncle x2-4
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }],   // 0x03  Eye Fang x2-2 + Blue Wisp x1-3 + Carbuncle x1-3
    ],
    weights: [60, 4],   // out of 64
  }],
  ['altar_cave_f4', {
    rom: { map: 113, group: 0x03 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }],   // 0x03  Eye Fang x2-2 + Blue Wisp x1-3 + Carbuncle x1-3
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }],   // 0x02  Blue Wisp x1-2 + Carbuncle x2-4
    ],
    weights: [54, 10],   // out of 64
  }],
  // Floor 5 is the BOSS CHAMBER. The cartridge gives map 22 a rate of
  // 6/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['altar_cave_f5', {
    rom: { map: 22, group: 0x03 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }],   // 0x03  Eye Fang x2-2 + Blue Wisp x1-3 + Carbuncle x1-3
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }],   // 0x02  Blue Wisp x1-2 + Carbuncle x2-4
    ],
    weights: [54, 10],   // out of 64
  }],
  ['altar_cave_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xcc, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Cave of Seals — ROM maps 103, 104, 105, 106, 106 ──────────────────────────
  ['seals_cave_f1', {
    rom: { map: 103, group: 0x07 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0a, min: 2, max: 4 }],   // 0x07  Mummy x2-4
      [{ id: 0x0b, min: 2, max: 4 }],   // 0x08  Skeleton x2-4
      [{ id: 0x0e, min: 2, max: 4 }],   // 0x09  Shadow x2-4
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
    ],
    weights: [48, 12, 3, 1],   // out of 64
  }],
  ['seals_cave_f2', {
    rom: { map: 104, group: 0x08 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0b, min: 2, max: 4 }],   // 0x08  Skeleton x2-4
      [{ id: 0x0e, min: 2, max: 4 }],   // 0x09  Shadow x2-4
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
    ],
    weights: [24, 24, 12, 4],   // out of 64
  }],
  ['seals_cave_f3', {
    rom: { map: 105, group: 0x08 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0b, min: 2, max: 4 }],   // 0x08  Skeleton x2-4
      [{ id: 0x0e, min: 2, max: 4 }],   // 0x09  Shadow x2-4
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
    ],
    weights: [24, 24, 12, 4],   // out of 64
  }],
  ['seals_cave_f4', {
    rom: { map: 106, group: 0x09 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
      [{ id: 0x0f, min: 1, max: 1 }, { id: 0x0e, min: 3, max: 5 }],   // 0x0c  Revenant x1-1 + Shadow x3-5
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  // Floor 5 is the BOSS CHAMBER. The cartridge gives map 106 a rate of
  // 6/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['seals_cave_f5', {
    rom: { map: 106, group: 0x09 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
      [{ id: 0x0f, min: 1, max: 1 }, { id: 0x0e, min: 3, max: 5 }],   // 0x0c  Revenant x1-1 + Shadow x3-5
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  ['seals_cave_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xcd, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Tozus Tunnel — ROM maps 120, 121, 123 ──────────────────────────
  ['tozas_tunnel_f1', {
    rom: { map: 120, group: 0x0f },
    rate: 18,   // out of 256 per step — ~1 per 14 steps
    formations: [
      [{ id: 0x18, min: 2, max: 4 }],   // 0x58  Leprechaun x2-4
      [{ id: 0x19, min: 2, max: 4 }],   // 0x59  Darkface x2-4
      [{ id: 0x19, min: 1, max: 1 }, { id: 0x18, min: 1, max: 3 }],   // 0x5a  Darkface x1-1 + Leprechaun x1-3
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  ['tozas_tunnel_f2', {
    rom: { map: 121, group: 0x0f },
    rate: 18,   // out of 256 per step — ~1 per 14 steps
    formations: [
      [{ id: 0x18, min: 2, max: 4 }],   // 0x58  Leprechaun x2-4
      [{ id: 0x19, min: 2, max: 4 }],   // 0x59  Darkface x2-4
      [{ id: 0x19, min: 1, max: 1 }, { id: 0x18, min: 1, max: 3 }],   // 0x5a  Darkface x1-1 + Leprechaun x1-3
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  // Floor 3 is the BOSS CHAMBER. The cartridge gives map 123 a rate of
  // 18/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['tozas_tunnel_f3', {
    rom: { map: 123, group: 0x0f },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x18, min: 2, max: 4 }],   // 0x58  Leprechaun x2-4
      [{ id: 0x19, min: 2, max: 4 }],   // 0x59  Darkface x2-4
      [{ id: 0x19, min: 1, max: 1 }, { id: 0x18, min: 1, max: 3 }],   // 0x5a  Darkface x1-1 + Leprechaun x1-3
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  // ── Nepto Temple — ROM maps 97, 98, 99, 100 ──────────────────────────
  ['nepto_temple_f1', {
    rom: { map: 97, group: 0x10 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x1a, min: 2, max: 4 }],   // 0x10  Petit x2-4
      [{ id: 0x1c, min: 2, max: 4 }],   // 0x12  Lilliputian x2-4
    ],
    weights: [33, 31],   // out of 64
  }],
  ['nepto_temple_f2', {
    rom: { map: 98, group: 0x11 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x1b, min: 2, max: 4 }],   // 0x11  Poison Bat x2-4
      [{ id: 0x1e, min: 2, max: 4 }],   // 0x13  Blood Worm x2-4
    ],
    weights: [33, 31],   // out of 64
  }],
  ['nepto_temple_f3', {
    rom: { map: 99, group: 0x11 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x1b, min: 2, max: 4 }],   // 0x11  Poison Bat x2-4
      [{ id: 0x1e, min: 2, max: 4 }],   // 0x13  Blood Worm x2-4
    ],
    weights: [33, 31],   // out of 64
  }],
  // Floor 4 is the BOSS CHAMBER. The cartridge gives map 100 a rate of
  // 6/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['nepto_temple_f4', {
    rom: { map: 100, group: 0x12 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x1c, min: 1, max: 2 }, { id: 0x1d, min: 1, max: 2 }],   // 0x14  Lilliputian x1-2 + Wererat x1-2
      [{ id: 0x1e, min: 1, max: 2 }, { id: 0x1a, min: 1, max: 2 }],   // 0x15  Blood Worm x1-2 + Petit x1-2
    ],
    weights: [33, 31],   // out of 64
  }],
  ['nepto_temple_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xce, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Tower of Owen — ROM maps 126, 128, 130, 132, 134 ──────────────────────────
  ['tower_owen_f1', {
    rom: { map: 126, group: 0x17 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x34, min: 2, max: 4 }],   // 0x17  Petit Mage x2-4
      [{ id: 0x32, min: 2, max: 4 }],   // 0x18  Far Darrig x2-4
      [{ id: 0x31, min: 2, max: 4 }],   // 0x16  Pugman x2-4
    ],
    weights: [36, 16, 12],   // out of 64
  }],
  ['tower_owen_f2', {
    rom: { map: 128, group: 0x18 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x32, min: 2, max: 4 }],   // 0x18  Far Darrig x2-4
      [{ id: 0x34, min: 2, max: 4 }],   // 0x17  Petit Mage x2-4
      [{ id: 0x36, min: 2, max: 4 }],   // 0x19  Aughisky x2-4
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  ['tower_owen_f3', {
    rom: { map: 130, group: 0x1a },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x34, min: 1, max: 2 }, { id: 0x33, min: 1, max: 2 }],   // 0x1a  Petit Mage x1-2 + Blood Bat x1-2
      [{ id: 0x36, min: 2, max: 4 }],   // 0x19  Aughisky x2-4
      [{ id: 0x34, min: 2, max: 4 }],   // 0x1b  Petit Mage x2-4
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  ['tower_owen_f4', {
    rom: { map: 132, group: 0x1c },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x36, min: 1, max: 2 }, { id: 0x32, min: 1, max: 2 }],   // 0x1c  Aughisky x1-2 + Far Darrig x1-2
      [{ id: 0x34, min: 2, max: 4 }],   // 0x1b  Petit Mage x2-4
      [{ id: 0x34, min: 1, max: 2 }, { id: 0x33, min: 1, max: 2 }],   // 0x1d  Petit Mage x1-2 + Blood Bat x1-2
    ],
    weights: [30, 24, 10],   // out of 64
  }],
  // Floor 5 is the BOSS CHAMBER. The cartridge gives map 134 a rate of
  // 0/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['tower_owen_f5', {
    rom: { map: 134, group: 0x1d },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x34, min: 1, max: 2 }, { id: 0x33, min: 1, max: 2 }],   // 0x1d  Petit Mage x1-2 + Blood Bat x1-2
      [{ id: 0x36, min: 1, max: 2 }, { id: 0x32, min: 1, max: 2 }],   // 0x1c  Aughisky x1-2 + Far Darrig x1-2
      [{ id: 0x34, min: 2, max: 4 }],   // 0x1b  Petit Mage x2-4
      [{ id: 0x34, min: 1, max: 2 }, { id: 0x33, min: 1, max: 2 }],   // 0x1a  Petit Mage x1-2 + Blood Bat x1-2
    ],
    weights: [24, 24, 12, 4],   // out of 64
  }],
  ['tower_owen_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xcf, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Subterranean Lake — ROM maps 116, 117, 118, 119 ──────────────────────────
  ['subterranean_lake_f1', {
    rom: { map: 116, group: 0x1e },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x37, min: 2, max: 4 }],   // 0x1e  Bomb x2-4
      [{ id: 0x38, min: 2, max: 4 }],   // 0x1f  Manticore x2-4
    ],
    weights: [54, 10],   // out of 64
  }],
  ['subterranean_lake_f2', {
    rom: { map: 117, group: 0x1e },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x37, min: 2, max: 4 }],   // 0x1e  Bomb x2-4
      [{ id: 0x38, min: 2, max: 4 }],   // 0x1f  Manticore x2-4
    ],
    weights: [54, 10],   // out of 64
  }],
  ['subterranean_lake_f3', {
    rom: { map: 118, group: 0x1f },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x38, min: 2, max: 4 }],   // 0x1f  Manticore x2-4
      [{ id: 0x39, min: 2, max: 4 }],   // 0x20  Stalagmite x2-4
    ],
    weights: [54, 10],   // out of 64
  }],
  // Floor 4 is the BOSS CHAMBER. The cartridge gives map 119 a rate of
  // 6/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['subterranean_lake_f4', {
    rom: { map: 119, group: 0x20 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x3b, min: 1, max: 2 }, { id: 0x39, min: 1, max: 2 }],   // 0x21  Merman x1-2 + Stalagmite x1-2
      [{ id: 0x3c, min: 1, max: 2 }, { id: 0x3a, min: 1, max: 2 }],   // 0x22  RuinousWave x1-2 + Sea Devil x1-2
    ],
    weights: [36, 28],   // out of 64
  }],
  ['subterranean_lake_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xd0, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Flame Cave — ROM maps 107, 108, 109, 149 ──────────────────────────
  ['flame_cave_f1', {
    rom: { map: 107, group: 0x23 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x3d, min: 1, max: 2 }, { id: 0x41, min: 1, max: 2 }],   // 0x23  Balloon x1-2 + RMarshmao x1-2
      [{ id: 0x3f, min: 2, max: 4 }],   // 0x24  Crocotta x2-4
      [{ id: 0x40, min: 1, max: 2 }],   // 0x26  Adamantoise x1-2
      [{ id: 0x40, min: 1, max: 2 }, { id: 0x3d, min: 2, max: 4 }],   // 0x27  Adamantoise x1-2 + Balloon x2-4
    ],
    weights: [36, 24, 3, 1],   // out of 64
  }],
  ['flame_cave_f2', {
    rom: { map: 108, group: 0x24 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x3f, min: 2, max: 4 }],   // 0x24  Crocotta x2-4
      [{ id: 0x3d, min: 1, max: 2 }, { id: 0x41, min: 1, max: 2 }],   // 0x23  Balloon x1-2 + RMarshmao x1-2
      [{ id: 0x3e, min: 1, max: 2 }, { id: 0x3f, min: 1, max: 2 }],   // 0x25  Myrmecoleon x1-2 + Crocotta x1-2
      [{ id: 0x40, min: 1, max: 2 }],   // 0x26  Adamantoise x1-2
      [{ id: 0x40, min: 1, max: 2 }, { id: 0x3d, min: 2, max: 4 }],   // 0x27  Adamantoise x1-2 + Balloon x2-4
    ],
    weights: [36, 18, 6, 3, 1],   // out of 64
  }],
  ['flame_cave_f3', {
    rom: { map: 109, group: 0x25 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x3e, min: 1, max: 2 }, { id: 0x3f, min: 1, max: 2 }],   // 0x25  Myrmecoleon x1-2 + Crocotta x1-2
      [{ id: 0x40, min: 1, max: 2 }],   // 0x26  Adamantoise x1-2
      [{ id: 0x40, min: 1, max: 2 }, { id: 0x3d, min: 2, max: 4 }],   // 0x27  Adamantoise x1-2 + Balloon x2-4
    ],
    weights: [48, 12, 4],   // out of 64
  }],
  // Floor 4 is the BOSS CHAMBER. The cartridge gives map 149 a rate of
  // 0/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['flame_cave_f4', {
    rom: { map: 149, group: 0x00 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x00, min: 2, max: 4 }],   // 0x00  Goblin x2-4
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }],   // 0x01  Eye Fang x1-2 + Carbuncle x1-2
    ],
    weights: [63, 1],   // out of 64
  }],
  ['flame_cave_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xd1, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Castle Hein — ROM maps 136, 137, 138, 140, 139 ──────────────────────────
  ['castle_hein_f1', {
    rom: { map: 136, group: 0x28 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x42, min: 1, max: 2 }, { id: 0x43, min: 1, max: 2 }],   // 0x28  Pharaoh x1-2 + Lemur x1-2
      [{ id: 0x44, min: 1, max: 2 }, { id: 0x42, min: 2, max: 4 }],   // 0x29  Lamia x1-2 + Pharaoh x2-4
      [{ id: 0x45, min: 1, max: 2 }],   // 0x2b  Demon x1-2
      [{ id: 0x46, min: 1, max: 1 }],   // 0x2c  Dullahan x1-1
    ],
    weights: [36, 24, 3, 1],   // out of 64
  }],
  ['castle_hein_f2', {
    rom: { map: 137, group: 0x28 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x42, min: 1, max: 2 }, { id: 0x43, min: 1, max: 2 }],   // 0x28  Pharaoh x1-2 + Lemur x1-2
      [{ id: 0x44, min: 1, max: 2 }, { id: 0x42, min: 2, max: 4 }],   // 0x29  Lamia x1-2 + Pharaoh x2-4
      [{ id: 0x45, min: 1, max: 2 }],   // 0x2b  Demon x1-2
      [{ id: 0x46, min: 1, max: 1 }],   // 0x2c  Dullahan x1-1
    ],
    weights: [36, 24, 3, 1],   // out of 64
  }],
  ['castle_hein_f3', {
    rom: { map: 138, group: 0x29 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x44, min: 1, max: 2 }, { id: 0x42, min: 2, max: 4 }],   // 0x29  Lamia x1-2 + Pharaoh x2-4
      [{ id: 0x45, min: 1, max: 2 }],   // 0x2b  Demon x1-2
      [{ id: 0x46, min: 1, max: 1 }],   // 0x2c  Dullahan x1-1
    ],
    weights: [48, 15, 1],   // out of 64
  }],
  ['castle_hein_f4', {
    rom: { map: 140, group: 0x29 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x44, min: 1, max: 2 }, { id: 0x42, min: 2, max: 4 }],   // 0x29  Lamia x1-2 + Pharaoh x2-4
      [{ id: 0x45, min: 1, max: 2 }],   // 0x2b  Demon x1-2
      [{ id: 0x46, min: 1, max: 1 }],   // 0x2c  Dullahan x1-1
    ],
    weights: [48, 15, 1],   // out of 64
  }],
  // Floor 5 is the BOSS CHAMBER. The cartridge gives map 139 a rate of
  // 0/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['castle_hein_f5', {
    rom: { map: 139, group: 0x00 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0x00, min: 2, max: 4 }],   // 0x00  Goblin x2-4
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }],   // 0x01  Eye Fang x1-2 + Carbuncle x1-2
    ],
    weights: [63, 1],   // out of 64
  }],
  ['castle_hein_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xd2, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Mythril Mines — ROM maps 101, 102 ──────────────────────────
  ['mythril_mines_f1', {
    rom: { map: 101, group: 0x08 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0b, min: 2, max: 4 }],   // 0x08  Skeleton x2-4
      [{ id: 0x0e, min: 2, max: 4 }],   // 0x09  Shadow x2-4
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
    ],
    weights: [24, 24, 12, 4],   // out of 64
  }],
  ['mythril_mines_f2', {
    rom: { map: 102, group: 0x09 },
    rate: 6,   // out of 256 per step — ~1 per 43 steps
    formations: [
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
      [{ id: 0x0f, min: 1, max: 1 }, { id: 0x0e, min: 3, max: 5 }],   // 0x0c  Revenant x1-1 + Shadow x3-5
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  // ── Lake Dohr — ROM maps 151, 153, 154, 155 ──────────────────────────
  ['dohr_cave_f1', {
    rom: { map: 151, group: 0x43 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0x9f, min: 2, max: 4 }],   // 0x43  Ouroboros x2-4
      [{ id: 0xa0, min: 2, max: 4 }],   // 0x44  Plancti x2-4
      [{ id: 0xa1, min: 2, max: 4 }],   // 0x45  Sea Lion x2-4
    ],
    weights: [33, 30, 1],   // out of 64
  }],
  ['dohr_cave_f2', {
    rom: { map: 153, group: 0x44 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0xa0, min: 2, max: 4 }],   // 0x44  Plancti x2-4
      [{ id: 0xa1, min: 2, max: 4 }],   // 0x45  Sea Lion x2-4
      [{ id: 0xa2, min: 2, max: 4 }],   // 0x46  Remora x2-4
    ],
    weights: [33, 30, 1],   // out of 64
  }],
  ['dohr_cave_f3', {
    rom: { map: 154, group: 0x44 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0xa0, min: 2, max: 4 }],   // 0x44  Plancti x2-4
      [{ id: 0xa1, min: 2, max: 4 }],   // 0x45  Sea Lion x2-4
      [{ id: 0xa2, min: 2, max: 4 }],   // 0x46  Remora x2-4
    ],
    weights: [33, 30, 1],   // out of 64
  }],
  // Floor 4 is the BOSS CHAMBER. The cartridge gives map 155 a rate of
  // 8/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['dohr_cave_f4', {
    rom: { map: 155, group: 0x45 },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0xa1, min: 2, max: 4 }],   // 0x45  Sea Lion x2-4
      [{ id: 0xa2, min: 2, max: 4 }],   // 0x46  Remora x2-4
      [{ id: 0xa0, min: 2, max: 4 }],   // 0x44  Plancti x2-4
    ],
    weights: [30, 30, 4],   // out of 64
  }],
  ['dohr_cave_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xcb, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
  // ── Bahamut's Lair — ROM maps 156, 165, 166, 166 ──────────────────────────
  ['bahamut_cave_f1', {
    rom: { map: 156, group: 0x48 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0xa4, min: 2, max: 4 }],   // 0x48  Drake x2-4
      [{ id: 0xa4, min: 1, max: 2 }, { id: 0xa3, min: 2, max: 4 }],   // 0x49  Drake x1-2 + Grenade x2-4
    ],
    weights: [33, 31],   // out of 64
  }],
  ['bahamut_cave_f2', {
    rom: { map: 165, group: 0x49 },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0xa5, min: 2, max: 4 }],   // 0x4a  Great Boros x2-4
      [{ id: 0xa6, min: 2, max: 4 }],   // 0x4b  Saber Liger x2-4
      [{ id: 0xa4, min: 1, max: 2 }, { id: 0xa3, min: 2, max: 4 }],   // 0x49  Drake x1-2 + Grenade x2-4
    ],
    weights: [30, 19, 15],   // out of 64
  }],
  ['bahamut_cave_f3', {
    rom: { map: 166, group: 0x4a },
    rate: 8,   // out of 256 per step — ~1 per 32 steps
    formations: [
      [{ id: 0xa7, min: 2, max: 4 }],   // 0x4c  Queen Lamia x2-4
      [{ id: 0xa6, min: 2, max: 4 }],   // 0x4b  Saber Liger x2-4
      [{ id: 0xa5, min: 2, max: 4 }],   // 0x4a  Great Boros x2-4
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  // Floor 4 is the BOSS CHAMBER. The cartridge gives map 166 a rate of
  // 8/256, but our chamber is a single room with a scripted fight, so
  // the rate is forced to 0 here. The group is kept so the formations it
  // would have rolled stay visible.
  ['bahamut_cave_f4', {
    rom: { map: 166, group: 0x4a },
    rate: 0,   // out of 256 per step — never
    formations: [
      [{ id: 0xa7, min: 2, max: 4 }],   // 0x4c  Queen Lamia x2-4
      [{ id: 0xa6, min: 2, max: 4 }],   // 0x4b  Saber Liger x2-4
      [{ id: 0xa5, min: 2, max: 4 }],   // 0x4a  Great Boros x2-4
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  ['bahamut_cave_boss', {
    rom: null,   // ⛔ ours: the boss is placed by the dungeon registry, not rolled
    rate: 0,
    formations: [
      [{ id: 0xd6, min: 1, max: 1 }],
    ],
    weights: [64],
  }],
]);
