#!/usr/bin/env node
// map-names.mjs — what each FF3 map is CALLED, straight out of the ROM.
//
// ⭐ MAP PROPERTY BYTE 2 IS THE LOCATION-NAME INDEX. The banner string shown on
// entry is dialogue string `0x100 + byte2`; `$FF` means the map draws no banner.
//
//   map 111 -> byte2 $9e -> string $19e -> "Altar Cave"
//   map 114 -> byte2 $7c -> string $17c -> "Ur"
//
// ⛔ TWO HITS ARE NOT A RULE, so this decodes the byte for all 256 maps: 78 of
// them resolve, and every one is a real place name or a floor label ("B2F"),
// with no garbage. A wrong offset would produce nonsense across the table, not
// a clean list — that spread is the actual evidence, not the two anchors.
//
// ⭐ BYTE 5 IS THE AREA ID and groups a dungeon's floors, which is how the
// bare "B2F" maps get attached to a parent. Both together answer "which maps
// are dungeon X" without booting an emulator.
//
// This exists because that question was previously answered by GUESSING from
// palettes and tileset ids. It produced a debug button labelled "Cave of Seals"
// pointing at the Subterranean Lake, and a boss skin that claimed to be the
// Cave of Seals while pointing at Altar Cave's own donor map.
//
//   node tools/map-names.mjs              # every named map
//   node tools/map-names.mjs --areas      # grouped by area id (dungeon floors)
//   node tools/map-names.mjs 103          # one map

import { loadRom, decodeString } from './lib/ff3-text.mjs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = loadRom(ROM);

const PROPS = 0x004010;
const NAME_STRING_BASE = 0x100;
const NO_NAME = 0xff;

/** Map property bytes this tool reads. Byte 2 = name index, 5 = area, 9 = palette, 10 = song. */
export function mapInfo(m) {
  const o = PROPS + m * 16;
  const nameIdx = rom[o + 2];
  return {
    id: m,
    tileset: (rom[o] >> 5) & 7,
    nameIdx,
    area: rom[o + 5],
    palette: rom[o + 9],
    song: rom[o + 10],
    name: nameIdx === NO_NAME ? null
      : decodeString(rom, NAME_STRING_BASE + nameIdx).replace(/\{[0-9a-f]+\}/gi, '').replace(/\s+/g, ' ').trim(),
  };
}

const hex = (v) => '$' + v.toString(16).padStart(2, '0');
const line = (i) => `${String(i.id).padStart(3)}  ts ${i.tileset}  area ${hex(i.area)}  pal ${hex(i.palette)}  song ${hex(i.song)}  ${i.name ?? '—'}`;

const args = process.argv.slice(2);
const all = Array.from({ length: 256 }, (_, m) => mapInfo(m));

if (args.length && /^\d+$/.test(args[0])) {
  console.log(line(mapInfo(Number(args[0]))));
} else if (args.includes('--areas')) {
  // Group by area so a dungeon's unnamed "B2F" floors sit under their parent.
  const byArea = new Map();
  for (const i of all) {
    if (!byArea.has(i.area)) byArea.set(i.area, []);
    byArea.get(i.area).push(i);
  }
  for (const [area, maps] of [...byArea].sort((a, b) => a[0] - b[0])) {
    // The parent is the first map in the area carrying a real place name.
    const parent = maps.find((i) => i.name && !/^B?\d+F$/.test(i.name));
    if (!parent) continue;
    console.log(`\narea ${hex(area)}  ${parent.name}`);
    for (const i of maps) console.log('  ' + line(i));
  }
} else {
  const named = all.filter((i) => i.name);
  console.log(`${named.length} of 256 maps carry a name banner\n`);
  for (const i of named) console.log(line(i));
}
