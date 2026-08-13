#!/usr/bin/env node
// check-msgbox-typing.mjs — the FF2-style type-out must always finish.
//
// A reveal that stalls leaves the player staring at half a sentence with no way
// forward, and Z must fill the page in rather than skip it. Both are cheap to
// assert and expensive to discover in play.
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ getContext: () => ({}) }), addEventListener() {} };

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
