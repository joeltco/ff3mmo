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
  // ── Cave of Seals — ROM maps 103, 104, 105, 106 ──────────────────────────
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
  // ⛔ THIS IS A WALKABLE FLOOR NOW, NOT THE BOSS CHAMBER. The Cave of Seals
  // gained a fourth walkable floor in v1.11.3 to match Altar Cave's shape, so
  // the zone that used to be its boss room is the deepest floor you fight on —
  // the cartridge's own B3F, at the cartridge's own rate. The boss chamber moved
  // down to `seals_cave_f5`.
  ['seals_cave_f4', {
    rom: { map: 106, group: 0x09 },
    rate: 6,   // out of 256 per step — the cartridge's rate for map 106
    formations: [
      [{ id: 0x0b, min: 1, max: 1 }, { id: 0x0a, min: 3, max: 5 }],   // 0x0a  Skeleton x1-1 + Mummy x3-5
      [{ id: 0x0d, min: 2, max: 2 }, { id: 0x0c, min: 2, max: 4 }],   // 0x0b  Larva x2-2 + CursdCopper x2-4
      [{ id: 0x0f, min: 1, max: 1 }, { id: 0x0e, min: 3, max: 5 }],   // 0x0c  Revenant x1-1 + Shadow x3-5
    ],
    weights: [36, 24, 4],   // out of 64
  }],
  // The BOSS CHAMBER. The cartridge gives map 106 a rate of 6/256, but our
  // chamber is a single room with a scripted fight, so the rate is forced to 0.
  // The group is kept so the formations it would have rolled stay visible.
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
]);
