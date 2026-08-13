#!/usr/bin/env node
// check-msg-highlight.mjs — Key Terms must be COLOURED, in the right place.
//
// The highlight is drawn as runs: the box splits each wrapped line wherever the
// mask changes and chains drawText calls, relying on drawText's returned width
// to line the runs back up. Two things can silently break there — the mask
// lands on the wrong bytes (highlighting "the" instead of "cave"), or the runs
// drift and the text comes out with a gap or an overlap. Neither shows up in a
// unit test of the matcher, so this RENDERS the box and reads the pixels back.
//
//   node tools/check-msg-highlight.mjs

import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {}, getElementById: () => null };

const { _nameToBytes } = await import('../src/text-utils.js');
const mb = await import('../src/message-box.js');
const { KEYWORDS } = await import('../src/data/keywords.js');
const { initFont } = await import('../src/font-renderer.js');
const fs = await import('node:fs');

const ROM_PATH = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
let rom;
try { rom = new Uint8Array(fs.readFileSync(ROM_PATH)); }
catch { console.error(`check-msg-highlight: SKIP — no FF3 ROM at ${ROM_PATH}`); process.exit(0); }
initFont(rom);

const fail = [];
const err = (m) => fail.push(m);

// ── the mask, via the real render path ────────────────────────────────────
// message-box does not export the matcher, so measure it the way the player
// sees it: draw the page and ask which columns came out red.
const W = 256, H = 240;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

mb.registerMsgHighlights(Object.values(KEYWORDS).map(k => k.text));

// The highlight palette's fill colour (slot 3 of TEXT_RED = NES $16) vs the
// body text's ($30, near-white). Compare by "is it reddish", not exact RGB, so
// a palette tweak doesn't false-fail this gate.
const isRed = (r, g, b) => r > 100 && r > g * 1.6 && r > b * 1.6;
// "ink" = any pixel that is not the black backdrop. The body palette's outline
// colour is a dark blue, so testing for near-white would miss most of a glyph.
const isInk = (r, g, b) => r + g + b > 60;

function render(text) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  mb.forceCloseMsgBox();
  mb.showMsgBox(_nameToBytes(text));
  mb.msgState.state = 'hold';
  mb.msgState.typed = mb.msgState.bytes.length;   // fully revealed
  mb.drawMsgBox(ctx, () => {});                   // no border tiles in Node; text still draws
  const px = ctx.getImageData(0, 0, W, H).data;
  const cols = [];                                 // per 8px column: 'red' | 'pale' | null
  for (let cx = 0; cx < W; cx += 8) {
    let red = 0, ink = 0;
    for (let y = 32; y < 32 + 48; y++) {
      for (let x = cx; x < cx + 8; x++) {
        const i = (y * W + x) * 4;
        if (px[i + 3] === 0) continue;
        if (isRed(px[i], px[i + 1], px[i + 2])) red++;
        else if (isInk(px[i], px[i + 1], px[i + 2])) ink++;
      }
    }
    cols.push(red > 2 ? 'red' : ink > 2 ? 'pale' : null);
  }
  return cols;
}

// Every test line has an EVEN glyph count. The box centres text at
// tx = (144 - 8n)/2, which is 8-pixel aligned only when n is even; an odd-length
// line lands on a half-column and smears one extra column of ink, so an exact
// column count would be off by one for reasons that have nothing to do with the
// highlight. (Both odd-length cases in the first draft failed that way while the
// code was correct.)
//
// Every case below is a SINGLE wrapped line. Two lines overlap in the column
// map (both are centred), which makes "how many columns have ink" ambiguous —
// the first draft of this gate failed on exactly that and the code was fine.
const glyphs = (cols) => cols.filter(Boolean).length;
const redRun = (cols) => {
  const first = cols.indexOf('red'), last = cols.lastIndexOf('red');
  return first < 0 ? { n: 0, first, last, contiguous: true }
    : { n: cols.slice(first, last + 1).filter(c => c === 'red').length, first, last,
        contiguous: cols.slice(first, last + 1).every(c => c === 'red') };
};
const contiguousInk = (cols) => {
  const first = cols.findIndex(Boolean), last = cols.length - 1 - [...cols].reverse().findIndex(Boolean);
  if (first < 0) return false;
  return cols.slice(first, last + 1).every(Boolean);
};

// ── 1. a term is red, contiguous, and sits where the word does ────────────
{
  const cols = render('my brother');
  if (process.env.HL_DEBUG) console.log('  1:', cols.map(c => c === 'red' ? 'R' : c ? '.' : ' ').join('|'));
  const r = redRun(cols);
  if (r.n !== 7) err(`"my brother" lit ${r.n} columns red, expected 7 (BROTHER)`);
  if (!r.contiguous) err('the red columns are broken up — the mask is not covering one word');
  if (glyphs(cols) !== 10) err(`the line occupies ${glyphs(cols)} glyph columns, expected 10 ("my brother")`);
  if (!contiguousInk(cols)) err('a gap opened in the line — the highlight runs drifted apart');
  if (r.last !== cols.length - 1 - [...cols].reverse().findIndex(Boolean)) {
    err('the red block is not at the end of the line, but BROTHER is the last word');
  }
}

// ── 2. a term inside a longer word must NOT light up ──────────────────────
{
  const cols = render('a caveman!');           // 10 glyphs
  if (redRun(cols).n !== 0) err(`"caveman" lit ${redRun(cols).n} columns — CAVE must not match inside a longer word`);
  if (glyphs(cols) !== 10) err(`"a caveman!" occupies ${glyphs(cols)} columns, expected 10`);
}

// ── 3. the plural still counts ────────────────────────────────────────────
{
  const cols = render('in the caves');         // 12 glyphs
  const r = redRun(cols);
  if (r.n !== 5) err(`"caves" lit ${r.n} columns, expected 5 (CAVE + s)`);
  if (!r.contiguous) err('the plural highlight is not contiguous');
}

// ── 4. runs must not drift ────────────────────────────────────────────────
// Same-length lines, one with a term and one without, must occupy the same
// columns. Chaining drawText's return value is what keeps them aligned; if a
// run is measured instead of chained, the highlighted line shifts.
{
  const lit   = render('a cave b');
  const plain = render('a xave b');
  if (glyphs(lit) !== glyphs(plain)) {
    err(`highlighted line spans ${glyphs(lit)} columns vs ${glyphs(plain)} for the same-length plain line — the runs drifted`);
  }
  if (lit.findIndex(Boolean) !== plain.findIndex(Boolean)) {
    err('the highlighted line starts in a different column than the plain one — centring broke');
  }
  if (redRun(lit).n !== 4) err(`"a cave b" lit ${redRun(lit).n} columns, expected 4`);
  if (redRun(plain).n !== 0) err('"xave" matched CAVE');
}

// ── 5. mid-type-out, the highlight cannot run ahead of the reveal ────────
{
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  mb.forceCloseMsgBox();
  const page = _nameToBytes('my brother');
  mb.showMsgBox(page);
  mb.msgState.state = 'hold';
  mb.msgState.typed = 6;                     // "my bro"
  mb.drawMsgBox(ctx, () => {});
  const px = ctx.getImageData(0, 0, W, H).data;
  let red = 0, ink = 0;
  for (let cx = 0; cx < W; cx += 8) {
    let nr = 0, ni = 0;
    for (let y = 32; y < 80; y++) for (let x = cx; x < cx + 8; x++) {
      const i = (y * W + x) * 4;
      if (!px[i + 3]) continue;
      if (isRed(px[i], px[i + 1], px[i + 2])) nr++;
      else if (isInk(px[i], px[i + 1], px[i + 2])) ni++;
    }
    if (nr > 2) red++; else if (ni > 2) ink++;
  }
  // 6 bytes revealed = "my bro": 3 plain columns, 3 red.
  if (red !== 3) err(`6 bytes revealed should light 3 red columns, got ${red} — the highlight is ahead of the reveal`);
  if (red + ink !== 6) err(`6 bytes revealed drew ${red + ink} glyph columns`);
}

// ── 6. on a TWO-line page the mask must follow the wrap ─────────────────
// The mask is indexed against the whole page; each line has to read its own
// slice of it. Without the slice every line reads from byte 0, so a term on
// line 2 goes dark (and a term on line 1 would smear onto line 2). Every other
// case here is single-line, where slicing is a no-op — this is the one that
// notices.
{
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  mb.forceCloseMsgBox();
  mb.showMsgBox(_nameToBytes('It took my brother'));   // wraps: "It took my" / "brother"
  mb.msgState.state = 'hold';
  mb.msgState.typed = mb.msgState.bytes.length;
  mb.drawMsgBox(ctx, () => {});
  if (mb.msgLineCount(mb.msgState.bytes) !== 2) err('the two-line fixture stopped wrapping to two lines');
  const px = ctx.getImageData(0, 0, W, H).data;
  let redTop = 0, redBottom = 0;
  for (let y = 32; y < 80; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!px[i + 3] || !isRed(px[i], px[i + 1], px[i + 2])) continue;
      if (y < 56) redTop++; else redBottom++;
    }
  }
  if (redBottom === 0) err('BROTHER is on line 2 and nothing there is red — the mask is not sliced per line');
  if (redTop !== 0) err(`line 1 has ${redTop} red pixels but holds no term — the mask is off by a line`);
}

// ── no DARK pixels inside the box ───────────────────────────────────────
// font-renderer paints colour index 0 transparent but 1 and 2 SOLID. The shared
// TEXT_RED / TEXT_GREY constants carry 0x0F / 0x06 / 0x00 in those slots
// because they are built for a black background, so on the blue message box
// they stamp a dark block behind every highlighted word — "there's black in the
// text". Counting red pixels does not see it: the red is still there, sitting
// on a black tile. This does.
{
  // The other cases above pass a NO-OP border function, which is fine when all
  // they count is glyph ink. Here the box must actually be PAINTED — with no
  // border the interior is the black backdrop and every pixel reads as "dark",
  // which is how the first version of this check failed on correct code.
  const { ui } = await import('../src/ui-state.js');
  const { initHUD } = await import('../src/hud-init.js');
  const { drawBorderedBox } = await import('../src/hud-drawing.js');
  const { applyIPS } = await import('../src/ips-patcher.js');
  const romPatched = new Uint8Array(fs.readFileSync(ROM_PATH));
  applyIPS(romPatched, new Uint8Array(fs.readFileSync(new URL('../patches/ff3-awj.ips', import.meta.url).pathname)));
  ui.ctx = ctx;
  initHUD(romPatched);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  mb.forceCloseMsgBox();
  mb.showMsgBox(_nameToBytes('my brother'));
  mb.msgState.state = 'hold';
  mb.msgState.typed = mb.msgState.bytes.length;
  mb.drawMsgBox(ctx, drawBorderedBox);
  // Box interior only: x 8..136, y 40..72. The border is white and the ground
  // outside the box is black, so both would poison the measurement.
  const px = ctx.getImageData(8, 40, 128, 32).data;
  // Compare by BRIGHTNESS against the box's own blue, not against black. The
  // offending block is NES 0x06, which renders (90,4,0) — a dark red that sails
  // through a "< 40 on every channel" test. Box blue 0x02 is (18,18,171), sum
  // 207; the glyph fills are all brighter still. Anything below 150 is a slot
  // painting something that does not belong in this box.
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    if (px[i] + px[i + 1] + px[i + 2] < 150) dark++;
  }
  if (dark > 0) {
    err(`${dark} pixels inside the message box are darker than its own blue — a text ` +
        `palette is painting colour index 1/2 with a dark colour (the block behind ` +
        `highlighted words)`);
  }
}

if (fail.length) {
  for (const m of fail) console.error(`  \u2717 ${m}`);
  console.error(`\ncheck-msg-highlight: FAIL — ${fail.length} problem(s)`);
  process.exit(1);
}
console.log(`check-msg-highlight: OK — ${Object.keys(KEYWORDS).length} terms colour in place, ` +
            `runs stay aligned, plurals count, substrings do not`);
