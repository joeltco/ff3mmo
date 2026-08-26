#!/usr/bin/env node
// quest-shot.mjs — draw what the quest giver actually says.
//
// The v1.8.6 audit moved progress onto the giver's line ({n}/{count}/{left},
// filled in by quests.js#talkQuest). check-dialogue-fit proves it WRAPS and
// audit-quests proves the tokens get filled — neither proves it reads right on
// screen, and a page is a picture before it is a string. So draw it.
//
// Pages come from the REAL talkQuest, not from a hand-copied string: if the
// substitution breaks, the shot breaks with it.
//
//   node tools/quest-shot.mjs                   -> quest-active.png (n=1)
//   node tools/quest-shot.mjs --n 2 --page 1
//   node tools/quest-shot.mjs --stage complete

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = {
  createElement: () => createCanvas(8, 8),
  addEventListener() {},
  getElementById: () => null,
};

const W = 256, H = 240;
const ZOOM = Math.max(1, parseInt(flag('zoom', '3'), 10));
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

const { initFont } = await import('../src/font-renderer.js');
const { ui } = await import('../src/ui-state.js');
const { initHUD } = await import('../src/hud-init.js');
const { initCursorTile } = await import('../src/sprite-init.js');
const { drawBorderedBox } = await import('../src/hud-drawing.js');
const { _nameToBytes } = await import('../src/text-utils.js');
const mb = await import('../src/message-box.js');
const { KEYWORDS } = await import('../src/data/keywords.js');
const { ps } = await import('../src/player-stats.js');
const { QUESTS } = await import('../src/data/quests.js');
const q = await import('../src/quests.js');

const ROM_PATH = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
// Same AWJ patch the game applies at boot — without it every glyph is garbage.
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(new URL('../patches/ff3-awj.ips', import.meta.url).pathname)));
initFont(rom);
ui.ctx = ctx;
initHUD(rom);
const _ct = initCursorTile(rom);
ui.cursorTileCanvas = _ct.cursorTileCanvas;
ui.cursorFadeCanvases = _ct.cursorFadeCanvases;
mb.registerMsgHighlights(Object.values(KEYWORDS).map(k => k.text));

const QID = flag('quest', 'ur_missing_brother');
const quest = QUESTS[QID];
if (!quest) { console.error('unknown quest ' + QID); process.exit(2); }
const SLAST = quest.stages[quest.stages.length - 1];
const { map: mapId, npc: npcKey } = SLAST.at;
const stage = flag('stage', 'active');
const n = parseInt(flag('n', '1'), 10);

// Put the save in the state that produces the stage we want, then ask the real
// talk handler for the pages.
ps.quests = stage === 'done'
  ? { [QID]: { s: 'done', n: SLAST.objective.count } }
  : stage === 'complete'
    ? { [QID]: { s: SLAST.id, n: SLAST.objective.count } }
    : { [QID]: { s: 'active', n } };
const pages = q.talkQuest(mapId, npcKey, () => {});
if (!pages) { console.error('talkQuest returned no pages for stage ' + stage); process.exit(2); }
const pageIdx = Math.min(parseInt(flag('page', '0'), 10), pages.length - 1);

console.log(`${QID} / ${stage}` + (stage === 'active' ? ` / n=${n}` : ''));
pages.forEach((p, i) => console.log(`  ${i === pageIdx ? '>' : ' '} "${p}"`));
if (pages.some(p => /[{}]/.test(p))) {
  console.error('  !! an unfilled token is in there — the player would read the braces');
}

ctx.fillStyle = '#000';
ctx.fillRect(0, 0, W, H);
mb.showMsgBox(_nameToBytes(pages[pageIdx]));
mb.msgState.state = 'hold';
mb.msgState.typed = mb.msgState.bytes.length;   // fully typed out
mb.drawMsgBox(ctx, drawBorderedBox);

const out = createCanvas(W * ZOOM, H * ZOOM);
const octx = out.getContext('2d');
octx.imageSmoothingEnabled = false;
octx.drawImage(canvas, 0, 0, W * ZOOM, H * ZOOM);
const dest = flag('out', `quest-${stage}.png`);
fs.writeFileSync(dest, out.toBuffer('image/png'));
console.log('wrote ' + dest);
