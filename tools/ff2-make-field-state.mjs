#!/usr/bin/env node
// ff2-make-field-state.mjs — boot FF2 headlessly to a live in-game field state.
//
// WHY
// `ff2-outside.state.gz` sits somewhere the party cannot leave: it walks in place,
// covers ~31 tiles at most, and produced no encounter in 3000 steps in every
// direction (see `tools/lib/ff2-encounters.mjs`). Everything FF2-side that needs
// a battle is blocked behind that. This drives the game from BOOT instead.
//
//   node tools/ff2-make-field-state.mjs
//   node tools/ff2-make-field-state.mjs --out tools/states/ff2-field.state.gz
//
// HOW
//   1. `ff2-build-playable-rom.mjs`'s one-byte patch (CMP #$06 -> #$05 at the
//      name-length gate) so the kana name grid can be escaped headlessly — it has
//      no confirm cell and no input-reachable exit.
//   2. Mash A/START through the title, the opening crawl and name entry until the
//      party has a position.
//   3. ⛔ Back out of menus ONE press at a time, stopping the moment no menu word
//      is on screen. Pressing B blindly runs all the way back to the title.
//
// ⛔ WHAT THIS STATE IS AND IS NOT. It is verifiably IN-GAME: a real party with
// HP and gil, on a map, with no menu up. It is NOT confirmed to be encounter
// -bearing overworld — walking from it covers few tiles and no battle has been
// reached. Do not treat it as an encounter harness until something fights.
//
// ⛔ The state is saved from the PATCHED rom but the patch only matters during
// name entry, so it should replay on the stock rom. That is checked, not assumed.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F2 from './lib/ff2-text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', path.join(HERE, 'states', 'ff2-field.state.gz'));
const SRC = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';

/** The one-byte name-gate patch, located by signature (never a bare offset). */
const SIG = [0xA5, 0x08, 0xC9, 0x06, 0x90, 0x06, 0xA9, 0x00, 0x85, 0x08, 0x18, 0x60];
const stock = new Uint8Array(fs.readFileSync(SRC));
const patched = Uint8Array.from(stock);
{
  const hits = [];
  for (let i = 0; i < stock.length - SIG.length; i++) {
    let ok = true;
    for (let j = 0; j < SIG.length; j++) if (stock[i + j] !== SIG[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) { console.error(`expected 1 name gate, found ${hits.length}`); process.exit(1); }
  patched[hits[0] + 3] = 0x05;
}

/** Any of these on screen means a menu is up; the field is where none is. */
const MENU_WORDS = ['たすねる', 'アイテム', 'まほう', 'そうひ', 'ステータス', 'セーフ', 'ニューケーム'];
const PARTY_X = 0x68, PARTY_Y = 0x69;

const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
nes.loadROM(Buffer.from(patched).toString('binary'));
const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
const tap = (b, h = 6, g = 10) => { nes.buttonDown(1, b); run(h); nes.buttonUp(1, b); run(g); };
const screenText = () => {
  const v = nes.ppu.vramMem;
  let s = '';
  for (let i = 0x2000; i < 0x23C0; i++) { const g = F2.glyph(v[i]); s += (g === null ? '' : g); }
  return s;
};
const inMenu = () => { const t = screenText(); return MENU_WORDS.some(w => t.includes(w)); };

run(120);
for (let k = 0; k < 900; k++) {
  tap(k % 12 < 9 ? Controller.BUTTON_A : Controller.BUTTON_START, 6, 8);
  if (nes.cpu.mem[PARTY_Y] !== 0 && k > 200) break;
}
for (let k = 0; k < 6 && inMenu(); k++) { tap(Controller.BUTTON_B, 6, 20); run(40); }

const pos = `${nes.cpu.mem[PARTY_X]},${nes.cpu.mem[PARTY_Y]}`;
console.log(`in-game: menu=${inMenu() ? 'STILL UP' : 'clear'}  party at ${pos}`);
if (inMenu() || nes.cpu.mem[PARTY_Y] === 0) {
  console.error('⛔ never reached a clear field — not writing');
  process.exit(1);
}

// ── does it walk, and does the map redraw? honest, not assumed ───────────────
const nt = () => [...nes.ppu.vramMem.slice(0x2000, 0x23C0)];
const before = nt();
const tiles = new Set();
const D = [Controller.BUTTON_UP, Controller.BUTTON_RIGHT, Controller.BUTTON_DOWN, Controller.BUTTON_LEFT];
{
  const probe = JSON.parse(JSON.stringify(nes.toJSON()));
  let changed = 0;
  for (let s = 0; s < 240; s++) {
    const b = D[Math.floor(s / 9) % 4];
    nes.buttonDown(1, b); run(8); nes.buttonUp(1, b); run(10);
    tiles.add(`${nes.cpu.mem[PARTY_X]},${nes.cpu.mem[PARTY_Y]}`);
    const now = nt();
    for (let i = 0; i < now.length; i++) if (now[i] !== before[i]) { changed++; break; }
  }
  console.log(`  walk probe: ${tiles.size} distinct tiles, screen redrew on ${changed}/240 steps`);
  nes.fromJSON(probe);                      // rewind — save the CLEAN field state
}

const json = JSON.stringify(nes.toJSON());
{
  const check = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  check.loadROM(Buffer.from(stock).toString('binary'));      // the STOCK rom
  check.fromJSON(JSON.parse(json));
  for (let i = 0; i < 120; i++) check.frame();
  const ok = check.cpu.mem[PARTY_Y] === nes.cpu.mem[PARTY_Y];
  console.log(`  replay on the STOCK rom: party at ${check.cpu.mem[PARTY_X]},${check.cpu.mem[PARTY_Y]} — ${ok ? 'OK' : 'FAILED'}`);
  if (!ok) { console.error('⛔ the state does not stand on its own; not writing'); process.exit(1); }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(json, 'utf8')));
console.log(`wrote ${path.relative(path.join(HERE, '..'), OUT)} (${(fs.statSync(OUT).size / 1024) | 0} KB)`);
console.log('⛔ in-game and menu-free — NOT confirmed to be encounter-bearing overworld.');
