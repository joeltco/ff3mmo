#!/usr/bin/env node
// check-battle-hud-fit.mjs — every encounter we ship must FIT the battle HUD's
// enemy-name box.
//
//   node tools/check-battle-hud-fit.mjs
//   node tools/check-battle-hud-fit.mjs --list     # show every formation
//
// WHY NOW
// The zones used to be hand-authored, so the names in them were whatever
// somebody had already looked at. v1.10.56 replaced all of them with the
// cartridge's own tables and pulled in monsters this game had never drawn —
// CursdCopper, Lizardman, Parademon, Berserker — plus three-species formations.
// Nothing checks that those fit, and nothing would: the box CLIPS.
//
// THE REAL ESTATE (battle-draw-menu.js#_drawBattleEnemyBox)
//   width   BATTLE_PANEL_W = 120px, and `measureText` is a flat 8px per glyph
//           -> 15 GLYPHS. Anything longer is silently cut off mid-word.
//   height  HUD_BOT_H = 64px at rowH = 10 -> 6 ROWS. The list is centred, so
//           overflow rides UP out of the box rather than down.
//   count   a species with more than one body gains " x{N}" — 3 more glyphs,
//           and `measureText` counts the space (it only skips bytes < 0x28).
//
// ⛔ THE MAXIMUM IS NOT THE FORMATION'S max COUNT. Bodies are capped at FOUR by
// `startRandomEncounter`, so "Mummy x3-5" can never draw "x5"; using the table's
// max would invent an overflow that cannot happen.
//
// ⛔ NOR IS THE MAX THE WORST CASE. Spawning every group at its maximum was the
// first version of this file, and it silently never produced a THREE-species
// battle: "Eye Fang x2 + Blue Wisp x1-3 + Carbuncle x1-3" fills all four bodies
// from the first two groups, so Carbuncle only appears when Blue Wisp rolls low.
// Altar Cave floors 3 and 4 do that in the shipped game. Every count combination
// is enumerated below instead — the layout has to hold for all of them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⛔ THE GAME BOOTS A PATCHED ROM. `src/main.js` applies `patches/ff3-awj.ips`
// before anything reads a string, and AWJ re-encodes the text: lowercase moves
// from $CA-$E3 to $A4-$BD and LIGATURE tiles ($BE-$DF) pack two letters into one
// 8px cell. Measuring the raw file therefore measures neither the right bytes
// nor the right WIDTH. The first version of this tool did exactly that.
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'patches', 'ff3-awj.ips'))));
const { initTextDecoder, getMonsterNameShrines } = await import('../src/text-decoder.js');
initTextDecoder(rom);
const { measureText } = await import('../src/font-renderer.js');
const { ENCOUNTERS } = await import('../src/data/encounters.js');
const { MONSTER_REGISTRY } = await import('../src/data/monster-sprites-rom.js');
// ⛔ Ask the SHIPPED layout where things go. A local copy of the geometry here
// would keep passing after someone changed the real one — which is the whole
// failure this file exists to catch.
const { _encounterGridPos, encounterColOff, encounterBoxWidth } = await import('../src/battle-layout.js');

/** Straight from battle-draw-menu.js — keep these in step with it. */
const PANEL_W = 120, ROW_H = 10, BOX_H = 64;
const MAX_GLYPHS = PANEL_W / 8;          // 15
const MAX_ROWS = Math.floor(BOX_H / ROW_H);
/** `startRandomEncounter` stops pushing bodies at four. */
const BODY_CAP = 4;

const args = process.argv.slice(2);
let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++;
  if (!cond) { bad++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  else if (args.includes('--list')) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
};

/** AWJ tile bytes -> readable text. Ligatures are shown as `[be]` so a name
 *  that renders in fewer cells than it has letters stays obvious. */
const ascii = (bytes) => {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xA4 && b <= 0xBD) s += String.fromCharCode(b - 0xA4 + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
    else if (b === 0xBB) s += 'x';
    else s += `[${b.toString(16)}]`;
  }
  return s;
};

/**
 * The name rows the HUD would draw for one formation, at the WORST body split
 * the spawner can actually produce.
 *
 * Mirrors `_battleEnemyNames`: one row per distinct species still on screen,
 * with " x{N}" appended when that species has more than one body.
 */
// ── THE ARENA (battle-layout.js#_encounterGridPos, battle-grid.js) ─────────
const HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const PADDING = 16, BODY_GAP_Y = 2;
/** Sprite size straight from the registry the game renders from. */
const dimsOf = (id) => {
  const e = MONSTER_REGISTRY.get(id);
  return e ? { w: e.cols * 8, h: e.rows * 8 } : null;
};

/**
 * Every distinct body list `startRandomEncounter` can produce for a formation.
 *
 * Group order, a count rolled in [min,max] per group, hard stop at four bodies —
 * enumerated over every roll rather than sampled, because the interesting cases
 * are the LOW rolls (they are what let a third species onto the field).
 */
function spawnOutcomes(formation) {
  const out = new Map();
  const rec = (gi, bodies) => {
    if (gi === formation.length || bodies.length >= BODY_CAP) {
      out.set(bodies.join(','), bodies.slice());
      return;
    }
    const g = formation[gi];
    for (let c = g.min; c <= g.max; c++) {
      const b = bodies.slice();
      for (let i = 0; i < c; i++) { if (b.length >= BODY_CAP) break; b.push(g.id); }
      rec(gi + 1, b);
    }
  };
  rec(0, []);
  return [...out.values()].filter((b) => b.length > 0);
}

/** The name rows the HUD would draw for one body list (mirrors `_battleEnemyNames`). */
function rowsFor(bodies) {
  const rows = [];
  const seen = new Set();
  for (const id of bodies) {
    if (seen.has(id)) continue;
    seen.add(id);
    const count = bodies.filter((b) => b === id).length;
    const base = getMonsterNameShrines(id);
    const arr = Array.from(base);
    if (count > 1) arr.push(0xFF, 0xBB, 0x80 + count);
    rows.push({ id, bytes: new Uint8Array(arr), text: ascii(arr), width: measureText(new Uint8Array(arr)) });
  }
  return rows;
}

function arenaFor(bodies) {
  // `startRandomEncounter` sorts TALLEST FIRST before drawing.
  const d = bodies.map((id) => ({ id, ...(dimsOf(id) || { w: 32, h: 32 }) }));
  d.sort((a, b) => b.h - a.h);
  const count = d.length;
  const widths = d.map((x) => x.w);
  const row0H = Math.max(d[0]?.h || 32, d[1]?.h || 0);
  const row1H = count > 2 ? Math.max(d[2]?.h || 32, d[3]?.h || 0) : 0;
  const sprH = Math.max(row0H, row1H);
  const innerH = row1H > 0 ? row0H + BODY_GAP_Y + row1H : row0H;
  const fullH = Math.ceil((innerH + PADDING) / 8) * 8;

  const colOff = encounterColOff(widths);
  const widest = Math.max(32, ...widths);
  const fullW = encounterBoxWidth(count, colOff, widths);
  const pos = _encounterGridPos(0, 0, fullW, fullH, count, sprH, row0H, row1H, widths, colOff);

  let overlap = 0;
  for (const [a, b] of [[0, 1], [2, 3]]) {
    if (!pos[a] || !pos[b]) continue;
    overlap = Math.max(overlap, (pos[a].x + widths[a]) - pos[b].x);
  }
  overlap = Math.max(0, overlap);
  let spill = 0;
  for (let i = 0; i < count; i++)
    spill = Math.max(spill, -pos[i].x, (pos[i].x + widths[i]) - fullW);
  spill = Math.max(0, spill);
  // ⛔ EVERY sprite must sit ON its column centre, not merely inside the box.
  // With a wide enough box a fixed half-width stops overlapping and starts
  // hanging sprites off-centre instead — visible as a lopsided row, and invisible
  // to an overlap-only check.
  const cx = Math.floor(fullW / 2);
  const colFor = (i) => {
    if (count === 1) return cx;
    if (count === 3 && i === 2) return cx;
    return i % 2 === 0 ? cx - colOff : cx + colOff;
  };
  let offColumn = 0;
  for (let i = 0; i < count; i++)
    offColumn = Math.max(offColumn, Math.abs((pos[i].x + widths[i] / 2) - colFor(i)));
  const offCentre = count === 1 ? offColumn : 0;
  return { count, d, pos, colOff, fullW, fullH, overlap, spill, offCentre, offColumn, widest,
           tallest: Math.max(...d.map((x) => x.h)) };
}

// `--draw <zone> <formation> [outcome]` — ASCII the box and the sprite
// rectangles. There is no headless battle renderer in this repo, so this is the
// closest thing to LOOKING at the layout instead of trusting the numbers.
// ⛔ Defaults to the outcome with the MOST SPECIES, because the max-count
// sampling this file used to do never produced a three-species battle at all.
if (args[0] === '--draw') {
  const zone = ENCOUNTERS.get(args[1]);
  if (!zone) { console.error(`no such zone: ${args[1]}`); process.exit(2); }
  const fi = Number(args[2] || 0);
  const outs = spawnOutcomes(zone.formations[fi]);
  const pick = args[3] != null ? outs[Number(args[3])]
    : outs.slice().sort((x, y) => new Set(y).size - new Set(x).size || y.length - x.length)[0];
  const a = arenaFor(pick);
  const { pos, colOff } = a;
  const SC = 4;                                     // 4px per cell
  const W = Math.ceil(a.fullW / SC), H = Math.ceil(a.fullH / SC);
  const grid = Array.from({ length: H }, () => Array(W).fill('.'));
  const marks = '1234';
  a.d.forEach((sprite, i) => {
    const x0 = Math.round(pos[i].x / SC), y0 = Math.round(pos[i].y / SC);
    for (let y = y0; y < y0 + Math.round(sprite.h / SC); y++)
      for (let x = x0; x < x0 + Math.round(sprite.w / SC); x++) {
        if (y < 0 || y >= H || x < 0 || x >= W) continue;
        grid[y][x] = grid[y][x] === '.' ? marks[i] : '#';   // '#' = OVERLAP
      }
  });
  console.log(`${args[1]} formation ${fi} — ${outs.length} spawn outcome(s); showing ${new Set(pick).size} species`);
  console.log(`box ${a.fullW}x${a.fullH}, colOff ${colOff}`);
  console.log(`bodies: ${a.d.map((x) => `0x${x.id.toString(16)} ${x.w}x${x.h}`).join(', ')}`);
  console.log(`names : ${rowsFor(pick).map((r) => `"${r.text}"`).join('  ')}`);
  console.log('+' + '-'.repeat(W) + '+');
  for (const row of grid) console.log('|' + row.join('') + '|');
  console.log('+' + '-'.repeat(W) + '+');
  console.log(`overlap ${a.overlap}px, spill ${a.spill}px, off-column ${a.offColumn}px   ('#' = two sprites on one pixel)`);
  process.exit(0);
}

console.log(`battle enemy-name box: ${PANEL_W}px wide (${MAX_GLYPHS} glyphs), ${MAX_ROWS} rows of ${ROW_H}px`);
console.log(`arena: ${HUD_VIEW_W}x${HUD_VIEW_H} viewport; column offset and box width derived per formation\n`);

const worst = [], arenaBad = [];
let outcomes = 0, maxSpecies = 0;
for (const [key, zone] of ENCOUNTERS) {
  for (let fi = 0; fi < zone.formations.length; fi++) {
    for (const bodies of spawnOutcomes(zone.formations[fi])) {
      outcomes++;
      const rows = rowsFor(bodies);
      maxSpecies = Math.max(maxSpecies, rows.length);
      const tag = `${key} f${fi} [${bodies.length} bodies, ${rows.length} species]`;
      for (const r of rows) {
        worst.push({ key, text: r.text, width: r.width });
        ok(`${tag} "${r.text}"`, r.width <= PANEL_W, `${r.width}px of ${PANEL_W}`);
      }
      ok(`${tag}: name rows fit`, rows.length <= MAX_ROWS, `${rows.length} > ${MAX_ROWS}`);

      const a = arenaFor(bodies);
      const label = `${tag} widest ${a.widest}px`;
      ok(`${label}: sprites do not overlap`, a.overlap === 0, `${a.overlap}px overlap`);
      ok(`${label}: sprites stay inside the box`, a.spill === 0, `${a.spill}px past the border`);
      ok(`${label}: box fits the viewport`, a.fullH <= HUD_VIEW_H && a.fullW <= HUD_VIEW_W,
         `${a.fullW}x${a.fullH} of ${HUD_VIEW_W}x${HUD_VIEW_H}`);
      ok(`${label}: a lone monster is centred`, a.offCentre === 0, `${a.offCentre}px off centre`);
      ok(`${label}: every sprite sits on its column`, a.offColumn === 0, `${a.offColumn}px off column`);
      if (a.overlap || a.spill || a.offCentre || a.offColumn) arenaBad.push({ key, fi, ...a });
    }
  }
}
console.log(`  ${outcomes} distinct spawn outcomes checked; most species in one battle: ${maxSpecies}\n`);

worst.sort((a, b) => b.width - a.width);
console.log('  widest names actually reachable:');
for (const w of worst.slice(0, 8))
  console.log(`    ${String(w.width).padStart(3)}px  "${w.text}"${w.width > PANEL_W ? '   ⛔ CLIPPED' : ''}   (${w.key})`);

if (arenaBad.length) {
  console.log('\n  ⛔ arena overflows:');
  const seen = new Set();
  for (const a of arenaBad) {
    const k = a.d.map((x) => x.id).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`    ${a.key} — ${a.count}x ${a.widest}px wide: ${a.overlap}px overlap, ${a.spill}px past the border`);
  }
}

console.log(`\n${bad ? `FAILED ${bad}/${n}` : `all ${n} checks pass`}`);
process.exit(bad ? 1 : 0);
