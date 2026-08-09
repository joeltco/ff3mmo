#!/usr/bin/env node
// Render any 2BPP sprite in this repo as block text, so a sprite can be looked
// at in a terminal or pasted into a chat instead of only existing as pixels in
// a canvas.
//
//   node tools/sprite-ascii.mjs monster 0x00
//   node tools/sprite-ascii.mjs monster 0xb5 --captured   # monscan palettes
//   node tools/sprite-ascii.mjs monster 0x05 --color      # real colors (ANSI)
//   node tools/sprite-ascii.mjs tiles src/data/onion-knight-sprites.js OK_IDLE --cols=2 --rows=3
//   node tools/sprite-ascii.mjs list [filter]
//
// Glyphs are ranked by how BRIGHT each color actually is — darkest visible
// color gets ░, brightest gets █, transparent is blank.
//
// Ranking by palette index instead (the ['.','░','▒','█'][val] convention in
// tools/dump-hit-tiles.js) renders a perfectly good sprite as static: index
// order has nothing to do with brightness, so a bee whose body alternates
// index 1 and 3 comes out looking like noise. `--by-index` switches back when
// you want to see the index structure itself, e.g. checking a tilePal split.
//
// Glyphs rather than color by default because ANSI escapes do not survive being
// pasted into most chat clients — the glyph grid does. `--color` switches to
// 24-bit ANSI for when you are running this yourself in a real terminal.
//
// NOTE: there is deliberately no "read tiles at ROM offset N" mode. ROM bytes
// are not PPU bytes (MMC3 bank switching), so a ROM-offset viewer would quietly
// invite the exact mistake CLAUDE.md bans. Capture from a running PPU instead.

import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { NES_SYSTEM_PALETTE } from '../src/tile-decoder.js';
import { MONSTER_REGISTRY, PALETTE_TABLE } from '../src/data/monster-sprites-rom.js';
import { MONSTER_NAMES_SHRINES } from '../src/data/monsters.js';

const GLYPHS = ['.', '░', '▒', '█'];
const CAPTURED = new URL('./monscan/monster-palettes.json', import.meta.url);
const MONSTERS_SRC = new URL('../src/data/monsters.js', import.meta.url);

/** MONSTER_NAMES_SHRINES only covers 114 of the 231 monsters, but every row in
 *  monsters.js carries its name as a trailing comment. Fall back to those so a
 *  lookup answers "Goblin" instead of "(unnamed)". */
const COMMENT_NAMES = (() => {
  const map = new Map();
  for (const line of readFileSync(MONSTERS_SRC, 'utf8').split('\n')) {
    const m = /^\s*\[0x([0-9a-fA-F]{2}),.*\],\s*\/\/\s*(\S.*?)\s*$/.exec(line);
    if (m) map.set(parseInt(m[1], 16), m[2]);
  }
  return map;
})();
const nameOf = (id) => MONSTER_NAMES_SHRINES.get(id) || COMMENT_NAMES.get(id) || '(unnamed)';

// ── args ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
const opt = (name, dflt) => (flags[name] === undefined ? dflt : flags[name]);
const num = (name, dflt) => (flags[name] === undefined ? dflt : parseInt(flags[name], 10));

const MAX_WIDTH = num('max-width', 100);
const COLOR = !!flags.color;
const HALF = !!flags.half;
const BY_INDEX = !!flags['by-index'];
const EMOJI_MODE = !!flags.emoji;
const TRIM = opt('trim', true) !== 'false';

// ── 2BPP decode ────────────────────────────────────────────────────

/** One 8x8 tile → 64 palette indices (0-3). Bitplane 0 first, plane 1 at +8. */
function decodeTile(raw, tileIdx) {
  const off = tileIdx * 16;
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const bp0 = raw[off + row] | 0;
    const bp1 = raw[off + row + 8] | 0;
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      out[row * 8 + col] = (((bp1 >> bit) & 1) << 1) | ((bp0 >> bit) & 1);
    }
  }
  return out;
}

/**
 * Lay tiles out into a pixel grid.
 *
 * `palForTile(tileIdx)` returns the 4 NES color indices that tile uses, so a
 * monster split across pal0/pal1 resolves per tile exactly the way
 * src/monster-sprites.js#_renderSprite does.
 */
function buildGrid(raw, cols, rows, palForTile) {
  const w = cols * 8, h = rows * 8;
  const ci = new Uint8Array(w * h);        // palette index 0-3 (0 = transparent)
  const color = new Int16Array(w * h).fill(-1); // resolved NES color, -1 = clear
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileIdx = ty * cols + tx;
      const pal = palForTile(tileIdx);
      const tile = decodeTile(raw, tileIdx);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const v = tile[py * 8 + px];
          const p = (ty * 8 + py) * w + (tx * 8 + px);
          ci[p] = v;
          if (v !== 0) color[p] = pal[v] & 0x3F;
        }
      }
    }
  }
  return { ci, color, w, h };
}

/** Drop fully transparent border rows/columns; sprites carry a lot of margin. */
function trim(g) {
  let top = 0, bottom = g.h - 1, left = 0, right = g.w - 1;
  const rowClear = (y) => { for (let x = 0; x < g.w; x++) if (g.ci[y * g.w + x]) return false; return true; };
  const colClear = (x) => { for (let y = 0; y < g.h; y++) if (g.ci[y * g.w + x]) return false; return true; };
  while (top <= bottom && rowClear(top)) top++;
  while (bottom > top && rowClear(bottom)) bottom--;
  while (left <= right && colClear(left)) left++;
  while (right > left && colClear(right)) right--;
  if (top > bottom) return { ...g, cropped: null };            // fully blank
  const w = right - left + 1, h = bottom - top + 1;
  if (w === g.w && h === g.h) return { ...g, cropped: null };
  const ci = new Uint8Array(w * h), color = new Int16Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      ci[y * w + x] = g.ci[(top + y) * g.w + (left + x)];
      color[y * w + x] = g.color[(top + y) * g.w + (left + x)];
    }
  return { ci, color, w, h, cropped: { top, left, from: `${g.w}x${g.h}` } };
}

// ── rendering ──────────────────────────────────────────────────────
const rgbOf = (nesColor) => NES_SYSTEM_PALETTE[nesColor] || [0, 0, 0];
const lumaOf = (c) => { const [r, g, b] = rgbOf(c); return 0.299 * r + 0.587 * g + 0.114 * b; };

/**
 * Emoji squares — the only colored output that survives a plain-text channel.
 *
 * ANSI needs a terminal to interpret it; pasted into a chat client the escapes
 * either show as literal `[38;2;...m` or get stripped. These are ordinary
 * characters, so they arrive as color anywhere. The cost is a 9-color palette
 * standing in for the NES's 64, so it is an impression of the real colors, not
 * a match — use --color when accuracy matters and you are in a terminal.
 *
 * They are also double-width, which makes one emoji per pixel come out square
 * without the 2x horizontal doubling the glyph modes need.
 */
const HUES = [
  [[229, 57, 53], '🟥', '🔴'], [[244, 144, 12], '🟧', '🟠'], [[253, 203, 88], '🟨', '🟡'],
  [[120, 177, 89], '🟩', '🟢'], [[85, 153, 229], '🟦', '🔵'], [[170, 116, 187], '🟪', '🟣'],
  [[150, 104, 72], '🟫', '🟤'], [[49, 55, 61], '⬛', '⚫'], [[230, 233, 234], '⬜', '⚪'],
];
// Squares first, then the circle of each hue. Two shapes per hue means a second
// blue can stay blue instead of being forced onto a wrong color entirely — the
// circles cost nothing in accuracy since they carry the same RGB.
const EMOJI = [
  ...HUES.map(([rgb, sq]) => [sq, rgb, 0]),
  ...HUES.map(([rgb, , ci]) => [ci, rgb, 1]),
];
const EMOJI_CLEAR = '\u3000';   // ideographic space: double-width, so it aligns
const dist2 = (c, rgb) => {
  const [r, g, b] = rgbOf(c);
  return (rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2;
};

/**
 * Assign each of the sprite's colors its OWN emoji square.
 *
 * Picking the independent nearest square per color collapses distinct colors
 * together — KillerBee's $13 (#6c2eff) and $21 (#56b4ff) both land on 🟦 and
 * the body loses all its shading. Matching greedily but without reuse keeps the
 * contrast that makes the sprite readable, at the cost of pushing some colors
 * to a square that is not their literal closest.
 */
function assignEmoji(colors) {
  const pairs = [];
  // The +shape tiebreak keeps a square ahead of its identical-RGB circle.
  for (const c of colors)
    for (const [glyph, rgb, shape] of EMOJI) pairs.push([dist2(c, rgb) + shape, c, glyph]);
  pairs.sort((a, b) => a[0] - b[0]);
  const map = new Map(), taken = new Set();
  for (const [, c, glyph] of pairs) {
    if (map.has(c) || taken.has(glyph)) continue;
    map.set(c, glyph); taken.add(glyph);
  }
  for (const c of colors) if (!map.has(c)) map.set(c, '⬛');   // >9 colors: reuse
  return map;
}

/**
 * Glyph per NES color, darkest visible → brightest.
 *
 * Built per sprite from the colors it actually uses, so a two-tone monster gets
 * a clean ▒/█ split instead of both landing on the same glyph.
 */
function buildRamp(g) {
  const used = [...new Set([...g.color].filter((c) => c >= 0))].sort((a, b) => lumaOf(a) - lumaOf(b));
  const ramp = ({ 1: ['█'], 2: ['▒', '█'], 3: ['░', '▒', '█'] })[used.length] || ['░', '▒', '▓', '█'];
  const map = new Map();
  used.forEach((c, i) => map.set(c, ramp[Math.min(i, ramp.length - 1)]));
  return { map, used, emoji: assignEmoji(used) };
}
const fg = (c, s) => { const [r, g, b] = rgbOf(c); return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`; };
/**
 * One half-block cell holding two stacked pixels.
 *
 * Which glyph matters when only one half is opaque. Always drawing ▀ and just
 * omitting the missing color leaves that half painted in the terminal's DEFAULT
 * foreground — so a transparent top edge came out as a solid bar of whatever
 * color the user's terminal happens to use. Drawing ▄ instead when only the
 * bottom pixel exists keeps the empty half genuinely empty.
 */
const halfCell = (top, bot) => {
  const paint = (glyph, c) => {
    const [r, g, b] = rgbOf(c);
    return `\x1b[38;2;${r};${g};${b}m${glyph}\x1b[0m`;
  };
  if (top >= 0 && bot >= 0) {
    const [tr, tg, tb] = rgbOf(top), [br, bg, bb] = rgbOf(bot);
    return `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀\x1b[0m`;
  }
  if (top >= 0) return paint('▀', top);
  if (bot >= 0) return paint('▄', bot);
  return ' ';
};

/**
 * Columns per pixel.
 *
 * A terminal cell is about twice as tall as it is wide, so a full-block pixel
 * needs two columns to come out square. A HALF-block cell already holds two
 * stacked pixels, which makes each pixel one column wide by half a cell tall —
 * square at one column. Doubling there stretches the sprite 2:1 sideways, which
 * is what made --half look squashed.
 */
function pixelWidth(w) {
  const forced = num('px', 0);
  if (forced === 1 || forced === 2) return forced;
  if (HALF) return 1;
  return w * 2 <= MAX_WIDTH ? 2 : 1;
}

function renderFull(g, ramp) {
  const pw = pixelWidth(g.w);
  const lines = [];
  for (let y = 0; y < g.h; y++) {
    let line = '';
    for (let x = 0; x < g.w; x++) {
      const p = y * g.w + x;
      if (EMOJI_MODE) line += g.color[p] < 0 ? EMOJI_CLEAR : (ramp.emoji.get(g.color[p]) || '⬛');
      else if (COLOR) line += g.color[p] < 0 ? ' '.repeat(pw) : fg(g.color[p], '█'.repeat(pw));
      else if (BY_INDEX) line += GLYPHS[g.ci[p]].repeat(pw);
      else line += (g.color[p] < 0 ? ' ' : ramp.map.get(g.color[p]) || '█').repeat(pw);
    }
    lines.push(EMOJI_MODE ? line.replace(/(?:\u3000)+$/, '') : line.replace(/\s+$/, ''));
  }
  return lines;
}

/** Two pixel rows per text row via half blocks. In glyph mode this can only
 *  show occupancy, not which palette index — it is a shape check, not a
 *  color-accurate view. */
function renderHalf(g) {
  const pw = pixelWidth(g.w);
  const lines = [];
  for (let y = 0; y < g.h; y += 2) {
    let line = '';
    for (let x = 0; x < g.w; x++) {
      const t = y * g.w + x;
      const b = (y + 1) < g.h ? (y + 1) * g.w + x : -1;
      if (COLOR) {
        const cell = halfCell(g.color[t], b < 0 ? -1 : g.color[b]);
        line += pw === 2 ? cell + cell : cell;
      } else {
        const tOn = g.ci[t] !== 0, bOn = b >= 0 && g.ci[b] !== 0;
        const ch = tOn && bOn ? '█' : tOn ? '▀' : bOn ? '▄' : ' ';
        line += ch.repeat(pw);
      }
    }
    lines.push(line);
  }
  return lines;
}

function legend(pals, ramp) {
  const out = [];
  for (const [label, pal] of pals) {
    const parts = pal.map((c, i) => {
      if (i === 0) return `- clear`;
      const [r, g, b] = rgbOf(c);
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const glyph = EMOJI_MODE ? (ramp.emoji.get(c) || '⬛') : BY_INDEX ? GLYPHS[i] : (ramp.map.get(c) || '?');
      const tag = `${glyph} $${c.toString(16).padStart(2, '0')} ${hex}`;
      return COLOR ? fg(c, tag) : tag;
    });
    out.push(`  ${label}: ${parts.join('   ')}`);
  }
  return out;
}

function show(g, pals, header) {
  // Emoji cells are already square, and renderHalf has no emoji path — say so
  // rather than silently dropping back to occupancy glyphs.
  if (EMOJI_MODE && HALF) console.log('  (--half ignored: emoji cells are already 1 char per pixel)');
  const t = TRIM ? trim(g) : { ...g, cropped: null };
  console.log(header);
  if (t.cropped) console.log(`  (trimmed blank margin: ${t.cropped.from} -> ${t.w}x${t.h}` +
                             `, origin +${t.cropped.left},+${t.cropped.top})`);
  if (t.w > MAX_WIDTH && pixelWidth(t.w) === 1 && !HALF)
    console.log(`  (${t.w} px wide — --half halves the height, --max-width raises the cap)`);
  const ramp = buildRamp(t);
  console.log(legend(pals, ramp).join('\n'));
  console.log();
  for (const line of (HALF ? renderHalf(t) : renderFull(t, ramp))) console.log(line);
}

// ── sources ────────────────────────────────────────────────────────

function monsterPals(id, entry) {
  if (flags.captured) {
    const all = JSON.parse(readFileSync(CAPTURED, 'utf8'));
    const cap = all[id];
    if (!cap || !cap.ok)
      throw new Error(`0x${id.toString(16)} has no captured palette` +
                      (cap ? ` (${cap.reason})` : '') + ' — drop --captured');
    // monscan stores the live BG palettes plus the per-tile 0/1 split it read
    // out of the attribute table, which is the same shape the registry uses.
    return { pal0: cap.bg[0], pal1: cap.bg[1], tilePal: cap.tilePal, src: 'monscan capture' };
  }
  return {
    pal0: entry.pal0Raw || PALETTE_TABLE[entry.pal0] || [0x0F, 0x00, 0x10, 0x20],
    pal1: entry.pal1Raw || PALETTE_TABLE[entry.pal1] || [0x0F, 0x00, 0x10, 0x20],
    tilePal: entry.tilePal,
    src: 'shipped registry',
  };
}

function cmdMonster(idStr) {
  const id = parseInt(idStr, 16);
  const entry = MONSTER_REGISTRY.get(id);
  if (!entry) throw new Error(`no sprite registry entry for 0x${id.toString(16)}`);
  const { pal0, pal1, tilePal, src } = monsterPals(id, entry);
  const { cols, rows } = entry;

  // Mirror src/monster-sprites.js#_renderSprite exactly: with a tilePal the
  // split is per tile, without one it falls back to "top two rows are pal0".
  const palForTile = (i) => (tilePal ? (tilePal[i] === 1 ? pal1 : pal0)
                                     : ((i / cols | 0) < 2 ? pal0 : pal1));
  const g = buildGrid(entry.raw, cols, rows, palForTile);
  show(g, [['pal0', pal0], ['pal1', pal1]],
       `0x${id.toString(16).padStart(2, '0')} ${nameOf(id)} — ${cols}x${rows} tiles ` +
       `(${cols * 8}x${rows * 8} px), palettes from ${src}` +
       (tilePal ? '' : ', NO tilePal (falling back to rows<2 = pal0)'));
}

async function cmdTiles(modPath, exportName) {
  const mod = await import(pathToFileURL(modPath).href);
  const raw = mod[exportName];
  if (!raw) throw new Error(`${modPath} has no export "${exportName}"`);
  const cols = num('cols', mod[`${exportName.replace(/_RAW$/, '')}_COLS`] ?? 0);
  const rows = num('rows', mod[`${exportName.replace(/_RAW$/, '')}_ROWS`] ?? 0);
  if (!cols || !rows)
    throw new Error(`pass --cols and --rows (${raw.length} bytes = ${raw.length / 16} tiles)`);
  // Any 4 NES colors work for a shape check; --pal takes real ones.
  const pal = (opt('pal', '0f,00,10,30')).split(',').map((s) => parseInt(s, 16));
  const g = buildGrid(raw, cols, rows, () => pal);
  show(g, [['pal', pal]],
       `${modPath} ${exportName} — ${cols}x${rows} tiles (${cols * 8}x${rows * 8} px)`);
}

function cmdList(filter) {
  const rows = [];
  for (const [id, e] of MONSTER_REGISTRY) {
    const name = nameOf(id);
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;
    rows.push(`0x${id.toString(16).padStart(2, '0')}  ${String(e.cols + 'x' + e.rows).padEnd(6)}` +
              `${e.tilePal ? 'tilePal' : '  --   '}  ${name}`);
  }
  console.log(rows.join('\n'));
  console.log(`\n${rows.length} monsters`);
}

// ── main ───────────────────────────────────────────────────────────
const [cmd, ...rest] = positional;
try {
  if (cmd === 'monster') cmdMonster(rest[0]);
  else if (cmd === 'tiles') await cmdTiles(rest[0], rest[1]);
  else if (cmd === 'list') cmdList(rest[0]);
  else {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
