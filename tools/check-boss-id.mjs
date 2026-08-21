#!/usr/bin/env node
// check-boss-id.mjs — the boss's bestiary id is written down ONCE.
//
// It used to be the bare literal `0xCC` in seven places: boot.js (sprite load),
// battle-state.js (BOSS_ATK / BOSS_DEF / BOSS_MAX_HP), battle-update.js (victory
// rewards), pvp.js, input-handler.js and loading-screen.js — with pvp.js and
// input-handler.js re-deriving atk/def that battle-state.js already exports.
// That is the shape where a change lands in some copies and not others.
//
// Two checks, and they test different things:
//   1. TEXTUAL — no module outside data/bosses.js writes the id as a literal.
//      A grep is the right instrument here: textual duplication IS the defect.
//   2. BEHAVIOURAL — battleSt.bossId defaults to it and resolves in MONSTERS, so
//      the reward path has something real to read.
//
// ⛔ What this does NOT prove: that a SECOND boss pays out its own rewards.
// There is only one non-random encounter in the game, so that path cannot be
// exercised yet. When a second boss exists, extend this to drive the dissolve.

import fs from 'node:fs';
import path from 'node:path';

// battle-state.js pulls in ui-state.js, which reads `window` at module scope.
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null, addEventListener() {} };

const SRC = new URL('../src/', import.meta.url).pathname;
const fails = [];

const { DEFAULT_BOSS_ID } = await import('../src/data/bosses.js');
const { MONSTERS } = await import('../src/data/monsters.js');

// ── 1. no stray literals ───────────────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(SRC).filter(f => f.endsWith('.js') && !f.endsWith('data/bosses.js'));

// `0xCC` also appears as pixel/tile data (damage-numbers, spell-anim, palettes).
// Only flag it where it is used AS a monster id — a MONSTERS lookup or a
// loadBossSprite call.
const ID = DEFAULT_BOSS_ID;
const hex = '0x' + ID.toString(16).toUpperCase();
const pat = new RegExp(`(MONSTERS\\.get\\(\\s*0x${ID.toString(16)}|loadBossSprite\\(\\s*0x${ID.toString(16)})`, 'i');
// ⛔ Skip comment lines. A grep matches prose, and the very comment explaining
// this fix ("this read was `MONSTERS.get(0xCC)`") tripped the first version —
// a check that fails on its own documentation trains you to ignore it.
const isComment = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    if (pat.test(line)) fails.push(`${path.relative(SRC, f)}:${i + 1} uses the boss id as a literal — import DEFAULT_BOSS_ID from data/bosses.js\n      ${line.trim()}`);
  });
}
console.log(`modules scanned: ${files.length}, stray ${hex} monster-id literals: ${fails.length}`);

// ── 2. the default resolves and the field carries it ───────────────────────
const { battleSt } = await import('../src/battle-state.js');
const data = MONSTERS.get(DEFAULT_BOSS_ID);
console.log(`DEFAULT_BOSS_ID ${hex} -> ${data ? `hp ${data.hp} atk ${data.atk} exp ${data.exp} gil ${data.gil}` : 'NOT IN MONSTERS'}`);
console.log(`battleSt.bossId default: 0x${(battleSt.bossId ?? -1).toString(16).toUpperCase()}`);
if (!data) fails.push(`DEFAULT_BOSS_ID ${hex} is not in MONSTERS — every boss stat would fall back to a placeholder`);
if (battleSt.bossId !== DEFAULT_BOSS_ID) fails.push('battleSt.bossId does not default to DEFAULT_BOSS_ID — the reward path would read undefined');

if (fails.length) { console.log('\nFAIL:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\nboss id has a single source');
