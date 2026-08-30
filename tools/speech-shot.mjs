#!/usr/bin/env node
// speech-shot.mjs — DRAW what somebody says, in a given state of the world.
//
// `audit-npc-talk` prints the transcript as text. A page is a picture before it
// is a string: it wraps, it highlights Key Terms red, it sits in a bordered box
// 144px wide. "It fits" and "it reads right" are different questions and only
// one of them can be answered by a gate.
//
// Pages come from `previewSpeech` — the same resolver the game runs — so if the
// layering or the token fill breaks, the shot breaks with it.
//
//   node tools/speech-shot.mjs --npc sara --map 2001 --flags djinn_sealed \
//        --quests sasune_missing_daughter=done --out shot.png
//   node tools/speech-shot.mjs --sheet release-1.11.15 --out sheet.png
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {}, getElementById: () => null };

const { initFont } = await import('../src/font-renderer.js');
const { ui } = await import('../src/ui-state.js');
const { initHUD } = await import('../src/hud-init.js');
const { initCursorTile } = await import('../src/sprite-init.js');
const { drawBorderedBox } = await import('../src/hud-drawing.js');
const { _nameToBytes } = await import('../src/text-utils.js');
const mb = await import('../src/message-box.js');
const { KEYWORDS } = await import('../src/data/keywords.js');
const { ps } = await import('../src/player-stats.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { previewSpeech } = await import('../src/speech.js');
const { hasFlag } = await import('../src/story-flags.js');
const { QUEST_DONE } = await import('../src/data/quests.js');

const ROM_PATH = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
// The same AWJ patch the game applies at boot — without it every glyph is garbage.
const { applyIPS } = await import('../src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(new URL('../patches/ff3-awj.ips', import.meta.url).pathname)));

const CELL_W = 144, CELL_H = 60;          // the message box's own viewport slice
const scratch = createCanvas(256, 240);
const sctx = scratch.getContext('2d');
initFont(rom);
ui.ctx = sctx;
initHUD(rom);
const _ct = initCursorTile(rom);
ui.cursorTileCanvas = _ct.cursorTileCanvas;
ui.cursorFadeCanvases = _ct.cursorFadeCanvases;
mb.registerMsgHighlights(Object.values(KEYWORDS).map((k) => k.text));

const rows = new Map();
for (const [mapId, list] of [...TOWN_NPCS, ...GENERATED_NPCS])
  for (const r of list) { if (!rows.has(r.key)) rows.set(r.key, []); rows.get(r.key).push({ mapId, ...r }); }

function setWorld({ flags = [], quests = {} }) {
  ps.flags = {}; for (const f of flags) ps.flags[f] = 1;
  ps.quests = {}; for (const [k, v] of Object.entries(quests)) ps.quests[k] = { s: v, n: 0 };
}
const questDone = (id) => !!(ps.quests[id] && ps.quests[id].s === QUEST_DONE);

/** Render ONE page into a CELL_W x CELL_H slice of the real box. */
function drawPage(page) {
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, 256, 240);
  mb.showMsgBox(_nameToBytes(page));
  mb.msgState.state = 'hold';
  mb.msgState.typed = mb.msgState.bytes.length;      // fully typed out
  mb.drawMsgBox(sctx, drawBorderedBox);
  return sctx.getImageData(0, 32, CELL_W, CELL_H);
}

/** Every page this person says in this world state, as image slices. */
function shotsFor(npcKey, world, forcePages) {
  setWorld(world);
  const row = (rows.get(npcKey) || []).find((r) => !r.when || r.when(questDone, hasFlag));
  if (!row && !forcePages) return { err: `${npcKey} is not placed in this state`, cells: [] };
  const pages = forcePages || (() => {
    const sp = previewSpeech(row.mapId, npcKey, row.spec);
    return sp ? sp.pages : null;
  })();
  if (!pages) return { err: `${npcKey} says nothing here`, cells: [] };
  return { err: null, cells: pages.map(drawPage) };
}

// ── the sheet ─────────────────────────────────────────────────────────────
const SHEETS = {
  // Every line 1.11.15 changed, with the line it replaced beside it.
  'release-1.11.15': [
    { label: 'Sara, endgame — WAS (the Djinn is dead)', npc: 'sara', was: true,
      pages: ['You told him, then.', 'I am still going back', 'for that thing.'],
      world: { flags: ['djinn_sealed', 'curse_lifted', 'daughter_home'], quests: {} } },
    { label: 'Sara, endgame — NOW', npc: 'sara',
      world: { flags: ['djinn_sealed', 'curse_lifted', 'daughter_home'],
               quests: { sasune_missing_daughter: 'done', kazus_sealed_cave: 'done' } } },
    { label: 'Cid, post-curse — was UNREACHABLE, now his idle', npc: 'cid',
      world: { flags: ['djinn_sealed', 'curse_lifted'], quests: { kazus_sealed_cave: 'done' } } },
    { label: 'King, cursed, daughter home — NEW variant', npc: 'sasune_king',
      world: { flags: ['daughter_home', 'sara_found', 'canoe_granted'],
               quests: { sasune_missing_daughter: 'done' } } },
    { label: 'King, restored, daughter home — NEW variant', npc: 'sasune_king',
      world: { flags: ['daughter_home', 'sara_found', 'canoe_granted', 'djinn_sealed', 'curse_lifted'],
               quests: { sasune_missing_daughter: 'done', kazus_sealed_cave: 'done' } } },
    { label: 'Ur, brother quest over — same words, now an idle variant', npc: 'ur_npc_05',
      world: { flags: ['brother_avenged'], quests: { ur_missing_brother: 'done' } } },
  ],
};

const sheetName = flag('sheet', null);
const OUT = flag('out', sheetName ? `speech-${sheetName}.png` : 'speech-shot.png');

if (!sheetName) {
  const world = { flags: (flag('flags', '') || '').split(',').filter(Boolean),
                  quests: Object.fromEntries((flag('quests', '') || '').split(',').filter(Boolean)
                    .map((p) => p.split('='))) };
  const { err, cells } = shotsFor(flag('npc', 'sara'), world);
  if (err) { console.error(err); process.exit(2); }
  const out = createCanvas(CELL_W, CELL_H * cells.length);
  const o = out.getContext('2d');
  cells.forEach((c, i) => o.putImageData(c, 0, i * CELL_H));
  fs.writeFileSync(OUT, out.toBuffer('image/png'));
  console.log(`wrote ${OUT}`);
} else {
  const spec = SHEETS[sheetName];
  if (!spec) { console.error(`unknown sheet ${sheetName}`); process.exit(2); }
  const built = spec.map((s) => ({ ...s, ...shotsFor(s.npc, s.world, s.pages) }));
  const Z = 2, PAD = 10, LABEL_H = 20;
  const height = built.reduce((h, b) => h + LABEL_H + Math.max(1, b.cells.length) * CELL_H * Z + PAD, 24);
  // Wide enough for the LABELS, not just the boxes — the first cut clipped
  // "...now his idle" to "...now his idl" and I only saw it by looking.
  const width = Math.max(CELL_W * Z + 24, 24 + Math.max(...built.map((b) => b.label.length)) * 7);
  const out = createCanvas(width, height);
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = false;
  o.fillStyle = '#101018'; o.fillRect(0, 0, out.width, out.height);
  o.font = 'bold 12px monospace'; o.fillStyle = '#e8e8f0';
  o.fillText('ff3mmo v1.11.15 — every line that changed', 12, 16);
  let y = 24;
  for (const b of built) {
    o.font = '11px monospace';
    o.fillStyle = b.was ? '#ff9a9a' : '#9fe8a0';
    o.fillText(b.label, 12, y + 13);
    y += LABEL_H;
    if (b.err) { o.fillStyle = '#ff6666'; o.fillText(b.err, 12, y + 12); y += CELL_H * Z + PAD; continue; }
    b.cells.forEach((c) => {
      const tmp = createCanvas(CELL_W, CELL_H);
      tmp.getContext('2d').putImageData(c, 0, 0);
      o.drawImage(tmp, 12, y, CELL_W * Z, CELL_H * Z);
      y += CELL_H * Z;
    });
    y += PAD;
  }
  fs.writeFileSync(OUT, out.toBuffer('image/png'));
  console.log(`wrote ${OUT} — ${built.length} states`);
  for (const b of built) console.log(`  ${b.err ? 'ERR ' : 'ok  '}${b.label}`);
}
