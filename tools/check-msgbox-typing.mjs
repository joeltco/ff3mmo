#!/usr/bin/env node
// check-msgbox-typing.mjs — the FF2-style type-out must always finish.
//
// A reveal that stalls leaves the player staring at half a sentence with no way
// forward, and Z must fill the page in rather than skip it. Both are cheap to
// assert and expensive to discover in play.
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
// getElementById is needed because data/strings.js reads the version badge at
// module load; without it this file dies on import, not on an assertion.
globalThis.document = {
  createElement: () => ({ getContext: () => ({}) }),
  addEventListener() {}, getElementById: () => null,
};

import { readFileSync } from 'node:fs';
const { _nameToBytes } = await import('../src/text-utils.js');
const mb = await import('../src/message-box.js');
const { msgState, showMsgBox, updateMsgBox, isMsgTyping, completeMsgTyping } = mb;

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

// Drive a page from slide-in through a full reveal.
showMsgBox(_nameToBytes('The old well ran dry.'));
let guard = 0;
while (msgState.state === 'slide-in' && guard++ < 500) updateMsgBox(16);
if (msgState.state === 'hold') ok('box reaches hold'); else bad(`stuck in ${msgState.state}`);
if (msgState.typed === 0) ok('page starts fully hidden'); else bad(`page started at typed=${msgState.typed}`);
if (isMsgTyping()) ok('reports typing while revealing'); else bad('not typing at start of hold');

guard = 0;
while (isMsgTyping() && guard++ < 2000) updateMsgBox(16);
if (!isMsgTyping()) ok(`reveal completes (${guard} ticks)`); else bad('reveal never completed — player would be stuck');
if (msgState.typed >= msgState.bytes.length) ok('every byte revealed');
else bad(`only ${msgState.typed}/${msgState.bytes.length} bytes revealed`);

// Z mid-reveal fills the page instead of skipping it.
showMsgBox(_nameToBytes('Something down there took my brother.'));
guard = 0;
while (msgState.state === 'slide-in' && guard++ < 500) updateMsgBox(16);
updateMsgBox(16);
if (isMsgTyping()) {
  completeMsgTyping();
  if (!isMsgTyping() && msgState.typed >= msgState.bytes.length) ok('Z fills the page in one press');
  else bad('completeMsgTyping did not finish the page');
} else bad('page was not typing to begin with');

// A page of pure spaces must still terminate.
showMsgBox(_nameToBytes('   '));
guard = 0;
while (msgState.state === 'slide-in' && guard++ < 500) updateMsgBox(16);
guard = 0;
while (isMsgTyping() && guard++ < 2000) updateMsgBox(16);
if (!isMsgTyping()) ok('a whitespace-only page terminates'); else bad('whitespace page hangs the reveal');

// ── the incoming page must not FLASH during the page scroll ─────────────
// v1.7.988: the scroll drew the incoming page in FULL (an omitted `reveal`
// meant "unlimited"), then page-scroll -> hold called _restartTyping() and
// blanked it. On screen: the text appeared, vanished, then typed itself out.
// Counting ink is the only way to see it — the state machine is happy either
// way.
{
  const { createCanvas } = await import('@napi-rs/canvas');
  // The real canvas has to replace the stub before hud-init builds its tiles.
  globalThis.document.createElement = () => createCanvas(8, 8);
  const { initFont } = await import('../src/font-renderer.js');
  const { ui } = await import('../src/ui-state.js');
  const { initHUD } = await import('../src/hud-init.js');
  const { drawBorderedBox } = await import('../src/hud-drawing.js');
  const { applyIPS } = await import('../src/ips-patcher.js');

  const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
  const rom = new Uint8Array(readFileSync(ROM));
  applyIPS(rom, new Uint8Array(readFileSync(new URL('../patches/ff3-awj.ips', import.meta.url))));
  const W = 256, H = 240;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  initFont(rom); ui.ctx = ctx; initHUD(rom);

  // Sample the box INTERIOR only. The border tiles are white, so measuring the
  // whole box counts the frame as text — an empty box read as 362 "text" pixels
  // and the first draft of this check failed on it. Box is 144x48 at y=32 with
  // an 8px border, so the interior is x 8..136, y 40..72.
  const textPixels = () => {
    const px = ctx.getImageData(8, 40, 128, 32).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 180 && px[i + 1] > 180 && px[i + 2] > 180) n++;
    }
    return n;
  };
  const frame = () => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); mb.drawMsgBox(ctx, drawBorderedBox); return textPixels(); };

  mb.forceCloseMsgBox();
  mb.showMsgBoxPages([_nameToBytes('First page here.'), _nameToBytes('Second page now.')]);
  mb.msgState.state = 'hold';
  mb.msgState.typed = mb.msgState.bytes.length;
  const full = frame();
  if (full < 50) bad(`a fully revealed page drew only ${full} text pixels — the harness cannot see text`);
  else ok(`a revealed page draws ${full} text pixels`);

  mb.msgState.onAdvance();          // start the scroll to page 2
  if (mb.msgState.state !== 'page-scroll') bad(`advancing left state "${mb.msgState.state}", expected page-scroll`);
  else ok('advancing starts a page scroll');
  // Sample LATE in the scroll, not halfway. Measured: the outgoing page has
  // left the box interior by t=80, and with the bug the incoming page fills it
  // back up (0 -> 287 by t=120) only to be blanked when the scroll lands. At
  // the halfway point BOTH readings are 0, so a mid-scroll check passes with
  // or without the bug — the first draft of this assertion did exactly that.
  mb.msgState.timer = 140;   // SCROLL_MS is 160
  const late = frame();
  if (late > 5) {
    bad(`late in the scroll the box interior holds ${late} text pixels — the incoming page is ` +
        `drawn in full and will be blanked the moment the scroll lands (the flash)`);
  } else {
    ok(`late in the scroll the box is empty (${late} px): the incoming page is not flashing in`);
  }

  // Land the scroll: the box must be EMPTY the instant it settles...
  for (let i = 0; i < 12 && mb.msgState.state === 'page-scroll'; i++) mb.updateMsgBox(33);
  if (mb.msgState.state !== 'hold') bad(`the scroll left state "${mb.msgState.state}", expected hold`);
  else ok('the scroll lands on hold');
  const settled = frame();
  if (process.env.MB_DEBUG) console.log('    [debug] state=' + mb.msgState.state + ' typed=' + mb.msgState.typed +
    ' len=' + (mb.msgState.bytes ? mb.msgState.bytes.length : -1) + ' scrollFrom=' + !!mb.msgState.scrollFromBytes +
    ' timer=' + mb.msgState.timer);
  if (settled > 5) bad(`the page shows ${settled} pixels of text the moment the scroll lands; it must type out from empty`);
  else ok('the new page starts empty');

  // ...and then type itself in.
  for (let i = 0; i < 60 && mb.isMsgTyping(); i++) mb.updateMsgBox(33);
  const typed = frame();
  if (typed < 50) bad(`page 2 never typed in — ${typed} text pixels after the reveal`);
  else ok(`page 2 types in (${typed} text pixels)`);
  mb.forceCloseMsgBox();
}

// ── the type-out must be SILENT ──────────────────────────────────────────
// A per-character blip shipped in v1.7.979 and had to be pulled in v1.7.986
// ("why are messages having weird sfx as the words scroll"). FF2 has no text
// sound to copy — see the note at the top of message-box.js. This asserts the
// module never calls into the audio layer at all, which is the only way to keep
// it from creeping back in as "just a little tick".
{
  const src = readFileSync(new URL('../src/message-box.js', import.meta.url), 'utf8');
  const sound = src.match(/\b(playSFX|playFF2Sfx|playTrack|playFF1Track|playFF2Track)\s*\(/g);
  if (sound) bad(`message-box.js calls the audio layer (${[...new Set(sound)].join(', ')}) — the text type-out must stay silent`);
  else ok('the type-out makes no sound');
}

if (failed) { console.error(`\ncheck-msgbox-typing: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-msgbox-typing: OK');
