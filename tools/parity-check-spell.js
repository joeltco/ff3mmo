// tools/parity-check-spell.js
// Byte-level parity gate between source-code spell tiles and a REC OAM dump's
// ground-truth bytes. Currently hardcoded for Fire (spell $31 / impact at
// origin (40,104) tiles $49-$52). Generalize per-spell as more land.
//
// The win condition: every (tileId, byte[i]) pair in src/spell-anim.js's
// FIRE_T_NN constants matches the corresponding (group at 40,104) tile-byte
// in the dump. If anything differs, the dump shows it.
//
// usage: node tools/parity-check-spell.js fire <dump.txt>
// exit 0 = PASS, exit 1 = FAIL.

import fs from 'node:fs';
import path from 'node:path';

const SPELLS = {
  fire: {
    name: 'Fire impact (BM Lv1, $31)',
    sourceFile: 'src/spell-anim.js',
    sourceConstants: ['FIRE_T_49','FIRE_T_4A','FIRE_T_4B','FIRE_T_4C','FIRE_T_4D','FIRE_T_4E','FIRE_T_4F','FIRE_T_50','FIRE_T_51','FIRE_T_52'],
    sourcePalette: 'PAL_FIRE_IMPACT',
    expectedTileIds: [0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,0x50,0x51,0x52],
    expectedPalette: [0x0F, 0x16, 0x27, 0x30],
    matchByOrigin: { x: 40, y: 104, frameRange: [75, 106] },
  },
  'fire-projectile': {
    name: 'Fire projectile ($58 fly)',
    sourceFile: 'src/projectile-anim.js',
    sourceConstants: ['T_58_FIRE'],
    sourcePalette: null, // palette is in PROJECTILE_PAL[fire] — handled below
    expectedTileIds: [0x58],
    expectedPalette: [0x0F, 0x16, 0x27, 0x30],
    matchByFrameRange: [46, 55],
  },
  'bm-cast': {
    name: 'BM cast pose ($49-$57 ring)',
    sourceFile: 'src/cast-anim.js',
    sourceConstants: ['BM_T_49','BM_T_4A','BM_T_4B','BM_T_4C','BM_T_4D','BM_T_4E','BM_T_4F','BM_T_50','BM_T_51','BM_T_52','BM_T_54','BM_T_55','BM_T_56','BM_T_57'],
    sourcePalette: 'BM_PAL',
    expectedTileIds: [0x49,0x4A,0x4B,0x4C,0x4D,0x4E,0x4F,0x50,0x51,0x52,0x54,0x55,0x56,0x57],
    expectedPalette: [0x0F, 0x16, 0x27, 0x30],
    matchByOrigin: { x: 176, y: 41, frameRange: [0, 43] },
  },
  'bm-cast-body': {
    name: 'BM cast pose body ($43-$48 pal1)',
    sourceFile: 'src/cast-anim.js',
    sourceConstants: ['BM_T_43_BODY','BM_T_44_BODY','BM_T_45_BODY','BM_T_46_BODY','BM_T_47_BODY','BM_T_48_BODY'],
    sourcePalette: 'BM_BODY_PAL',
    expectedTileIds: [0x43,0x44,0x45,0x46,0x47,0x48],
    expectedPalette: [0x0F, 0x27, 0x18, 0x21],
    matchByOrigin: { x: 176, y: 41, frameRange: [0, 43] },
  },
};

// Extract a `new Uint8Array([...])` constant from a JS source by name.
function extractByteConstant(source, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*new Uint8Array\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = source.match(re);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 16));
}

// Extract a palette array constant by name.
function extractPaletteConstant(source, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`);
  const m = source.match(re);
  if (!m) return null;
  return m[1].split(',').map(s => parseInt(s.trim(), 16));
}

// Walk the dump and pull tile bytes within a frame range, optionally constrained
// to a specific group origin. Returns map: tileId → first-seen 16-byte array.
// matchSpec: { frameRange:[min,max], originX?: int, originY?: int }
function extractDumpTiles(dumpText, matchSpec) {
  const { frameRange, originX, originY } = matchSpec;
  const filterByOrigin = (originX != null && originY != null);
  const lines = dumpText.split('\n');
  const out = new Map();
  let curFrame = -1;
  let inMatchingGroup = false;
  let pendingTileId = null;

  for (const ln of lines) {
    const fHdr = ln.match(/^\/\/ ═══ frame (\d+) /);
    if (fHdr) {
      curFrame = Number(fHdr[1]);
      inMatchingGroup = false;
      pendingTileId = null;
      continue;
    }
    if (curFrame < frameRange[0] || curFrame > frameRange[1]) continue;
    const gHdr = ln.match(/^\/\/ ── group \d+ \(\d+ tiles, origin (-?\d+),(-?\d+)\) ──/);
    if (gHdr) {
      if (filterByOrigin) inMatchingGroup = (Number(gHdr[1]) === originX && Number(gHdr[2]) === originY);
      else inMatchingGroup = true;
      pendingTileId = null;
      continue;
    }
    if (!inMatchingGroup) continue;
    const tHdr = ln.match(/^\/\/\s+\[-?\d+,-?\d+\] tile=\$([0-9A-Fa-f]+) pal\d/);
    if (tHdr) { pendingTileId = parseInt(tHdr[1], 16); continue; }
    const tBytes = ln.match(/new Uint8Array\(\[([^\]]+)\]\)/);
    if (tBytes && pendingTileId != null) {
      const bytes = tBytes[1].split(',').map(s => parseInt(s.trim(), 16));
      if (!out.has(pendingTileId)) out.set(pendingTileId, bytes);
      pendingTileId = null;
    }
  }
  return out;
}

// Extract a key from a const-object literal like:
//   const PROJECTILE_PAL = { sight: [...], fire: [0x0F, 0x16, ...] };
function extractMapEntry(source, mapName, key) {
  const re = new RegExp(`const\\s+${mapName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const m = source.match(re);
  if (!m) return null;
  const body = m[1];
  const entryRe = new RegExp(`${key}\\s*:\\s*\\[([^\\]]+)\\]`);
  const e = body.match(entryRe);
  if (!e) return null;
  return e[1].split(',').map(s => parseInt(s.trim(), 16));
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: node tools/parity-check-spell.js <spellName> <dump.txt>');
    process.exit(1);
  }
  const spellName = args[0];
  const dumpPath = args[1];
  const spec = SPELLS[spellName];
  if (!spec) { console.error(`unknown spell: ${spellName}. known: ${Object.keys(SPELLS).join(', ')}`); process.exit(1); }

  const source = fs.readFileSync(spec.sourceFile, 'utf8');
  const dump = fs.readFileSync(dumpPath, 'utf8');

  // Extract source bytes per tile.
  const srcBytes = new Map();
  for (let i = 0; i < spec.sourceConstants.length; i++) {
    const bytes = extractByteConstant(source, spec.sourceConstants[i]);
    if (!bytes) { console.error(`FAIL: source constant ${spec.sourceConstants[i]} not found in ${spec.sourceFile}`); process.exit(1); }
    if (bytes.length !== 16) { console.error(`FAIL: ${spec.sourceConstants[i]} has ${bytes.length} bytes, expected 16`); process.exit(1); }
    srcBytes.set(spec.expectedTileIds[i], bytes);
  }

  // Palette: prefer named const; fall back to PROJECTILE_PAL[fire] for projectile.
  let srcPalette = null;
  if (spec.sourcePalette) {
    srcPalette = extractPaletteConstant(source, spec.sourcePalette);
  } else if (spellName === 'fire-projectile') {
    srcPalette = extractMapEntry(source, 'PROJECTILE_PAL', 'fire');
  }
  if (!srcPalette) { console.error(`FAIL: source palette not found`); process.exit(1); }

  // Extract dump bytes for the matching frame range / origin.
  const matchSpec = spec.matchByOrigin
    ? { frameRange: spec.matchByOrigin.frameRange, originX: spec.matchByOrigin.x, originY: spec.matchByOrigin.y }
    : { frameRange: spec.matchByFrameRange };
  const dumpBytes = extractDumpTiles(dump, matchSpec);

  // ── Diff ──
  console.log(`parity-check ${spec.name}`);
  console.log(`  source: ${spec.sourceFile}  dump: ${dumpPath}`);
  if (spec.matchByOrigin) {
    console.log(`  dump scope: origin (${spec.matchByOrigin.x},${spec.matchByOrigin.y}) frames ${spec.matchByOrigin.frameRange[0]}-${spec.matchByOrigin.frameRange[1]}`);
  } else {
    console.log(`  dump scope: any group, frames ${spec.matchByFrameRange[0]}-${spec.matchByFrameRange[1]}`);
  }
  console.log('');

  let fail = 0;

  // Palette
  const palMatch = srcPalette.length === spec.expectedPalette.length &&
                   srcPalette.every((v, i) => v === spec.expectedPalette[i]);
  if (palMatch) console.log(`  palette  PASS  [${srcPalette.map(v => '0x' + v.toString(16).padStart(2,'0').toUpperCase()).join(', ')}]`);
  else { console.log(`  palette  FAIL  src=[${srcPalette.map(v => '0x' + v.toString(16)).join(',')}]  expected=[${spec.expectedPalette.map(v => '0x' + v.toString(16)).join(',')}]`); fail++; }

  // Tile bytes
  for (const tileId of spec.expectedTileIds) {
    const src = srcBytes.get(tileId);
    const dmp = dumpBytes.get(tileId);
    const tileLabel = `$${tileId.toString(16).toUpperCase().padStart(2,'0')}`;
    if (!dmp) {
      console.log(`  tile ${tileLabel}  FAIL  dump has no bytes for this tile in target group`);
      fail++; continue;
    }
    const diffs = [];
    for (let i = 0; i < 16; i++) {
      if (src[i] !== dmp[i]) diffs.push({ i, src: src[i], dmp: dmp[i] });
    }
    if (diffs.length === 0) {
      console.log(`  tile ${tileLabel}  PASS  (16/16 bytes match)`);
    } else {
      console.log(`  tile ${tileLabel}  FAIL  ${diffs.length}/16 bytes differ:`);
      for (const d of diffs) {
        console.log(`    byte[${d.i}]  src=0x${d.src.toString(16).padStart(2,'0').toUpperCase()}  dump=0x${d.dmp.toString(16).padStart(2,'0').toUpperCase()}`);
      }
      fail++;
    }
  }

  console.log('');
  if (fail === 0) {
    console.log(`PASS — ${spec.name} source bytes match dump ground truth`);
    process.exit(0);
  } else {
    console.log(`FAIL — ${fail} mismatches. Update src/spell-anim.js to match dump.`);
    process.exit(1);
  }
}

main();
