#!/usr/bin/env node
// Regenerate the SPELLS map inside src/data/spells.js from the ROM.
//
//   node tools/gen-spells-js.js            # splice the map in place
//   node tools/gen-spells-js.js --stdout   # print it instead, change nothing
//
// SPLICES rather than printing, and that is deliberate. Only the SPELLS map is
// generated; SPELL_NAMES_SHRINES, SPELL_MP_COST, SPELL_BUY_PRICE,
// MULTI_TARGET_SPELLS, SPELL_SCHOOL and every helper below it are
// hand-maintained with no ROM source to rebuild them from. The old usage was
// `node tools/gen-spells-js.js > src/data/spells.js`, copied from
// gen-monsters-js.js — but monsters.js really is generated end to end and this
// file is not, so that redirect would have silently deleted every table below
// the map.

import { readFileSync, writeFileSync } from 'fs';
import { initTextDecoder, getSpellName } from '../src/text-decoder.js';

const rom = readFileSync('FF3-English.nes');
initTextDecoder(rom);

function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
    else if (b === 0xC4) s += '!';
    else if (b === 0xC5) s += '?';
    else if (b === 0xC8) s += ':';
    else if (b === 0xC9) s += '-';
    else if (b >= 0x5C && b <= 0x7B) continue;
  }
  return s.trim();
}
function spellStr(id) { try { return nesText(getSpellName(id & 0x7F)); } catch { return `spell${id}`; } }

const SPELL_DATA = 0x0618D0;

const ELEM_MAP = { 1:'recovery', 2:'dark', 4:'bolt', 8:'ice', 16:'fire', 32:'air', 64:'earth', 128:'holy' };
function elemJS(b) {
  if (!b) return 'null';
  const e = [];
  for (const [bit, n] of Object.entries(ELEM_MAP)) if (b & parseInt(bit)) e.push(n);
  if (e.length === 1) return `'${e[0]}'`;
  return `[${e.map(x=>`'${x}'`).join(',')}]`;
}

// Spell type interpretation from Data Crystal
// type byte: 0x00=damage, 0xFF=cure_status, 0x02=poison, 0x04=blind, 0x05=petrify,
// 0x07=haste, 0x08=mini, 0x10=silence, 0x20=toad, 0x29=confuse+paralysis,
// 0x40=petrify, 0x51=sleep+paralysis, 0x80=death, 0x99=all_status
function typeJS(b) {
  if (b === 0x00) return "'damage'";
  if (b === 0xFF) return "'cure_status'";
  if (b === 0x02) return "'poison'";
  if (b === 0x04) return "'blind'";
  if (b === 0x05) return "'petrify'";
  if (b === 0x07) return "'haste'";
  if (b === 0x08) return "'mini'";
  if (b === 0x10) return "'silence'";
  if (b === 0x20) return "'toad'";
  if (b === 0x29) return "'confuse'";
  if (b === 0x40) return "'petrify'";
  if (b === 0x51) return "'sleep'";
  if (b === 0x80) return "'death'";
  if (b === 0x99) return "'all_status'";
  return `0x${b.toString(16).padStart(2,'0')}`;
}

// Target byte interpretation
// 0x00=single enemy, 0x01=single ally (heal), 0x02=single enemy (special),
// 0x03=drain (damage+heal), 0x04=single enemy (status), 0x05=revive,
// 0x06=cure status, 0x07=toggle status, 0x08=protect, 0x09=haste,
// 0x0A=reflect, 0x0B=erase, 0x0C=sight, 0x0D=libra,
// 0x0E=multiply, 0x0F=divide1, 0x10=summon, 0x11=divide2,
// 0x12=explode, 0x13=barrier_shift, 0x14=elixir, 0x15=guard,
// 0x16=bite, 0x17=all_enemies_special, 0x18=restore
function targetJS(b) {
  const map = {
    0x00:'enemy', 0x01:'ally', 0x02:'enemy', 0x03:'drain',
    0x04:'enemy_status', 0x05:'revive', 0x06:'cure_status', 0x07:'toggle_status',
    0x08:'protect', 0x09:'haste', 0x0A:'reflect', 0x0B:'erase',
    0x0C:'sight', 0x0D:'libra', 0x0E:'multiply', 0x0F:'divide',
    0x10:'summon', 0x11:'divide', 0x12:'explode', 0x13:'barrier_shift',
    0x14:'elixir', 0x15:'guard', 0x16:'bite', 0x17:'all_enemies',
    0x18:'restore', 0x33:'all_enemies'
  };
  return `'${map[b] || 'unknown_0x' + b.toString(16)}'`;
}

const lines = [];
// The file's header lives ABOVE the GENERATED marker and is hand-maintained;
// emitting it here would duplicate it into the spliced region on every run.
lines.push(`export const SPELLS = new Map([`);

// Player spells: 0-55 (white/black/summon magic + geomancer)
// Monster abilities: 56-87
for (let id = 0; id < 88; id++) {
  const off = SPELL_DATA + id * 8;
  const element = rom[off + 0];
  const hit = rom[off + 1];
  const power = rom[off + 2];
  const type = rom[off + 3];
  const target = rom[off + 4];
  const targeting = rom[off + 5];
  const anim = rom[off + 6];

  const name = spellStr(id);
  const props = [];
  props.push(`power: ${power.toString().padStart(3)}`);
  props.push(`hit: ${hit.toString().padStart(3)}`);
  props.push(`element: ${elemJS(element)}`);
  props.push(`type: ${typeJS(type)}`);
  props.push(`target: ${targetJS(target)}`);
  props.push(`anim: 0x${anim.toString(16).padStart(2, '0')}`);

  const comment = name || `spell_${id}`;
  lines.push(`  [0x${id.toString(16).padStart(2, '0')}, { ${props.join(', ')} }], // ${comment}`);
}

lines.push(`]);`);

const BEGIN = '// ─── BEGIN GENERATED (tools/gen-spells-js.js) ───';
const END = '// ─── END GENERATED ───';
const body = lines.join('\n');

if (process.argv.includes('--stdout')) {
  console.log(body);
} else {
  const target = 'src/data/spells.js';
  const cur = readFileSync(target, 'utf8');
  const a = cur.indexOf(BEGIN);
  const b = cur.indexOf(END);
  if (a < 0 || b < 0 || b < a) {
    console.error(`${target}: GENERATED markers missing or out of order — refusing to write.`);
    console.error('Restore them around the SPELLS map, or run with --stdout and splice by hand.');
    process.exit(1);
  }
  const out = cur.slice(0, a) + BEGIN + '\n' + body + '\n' + cur.slice(b);
  writeFileSync(target, out);
  const kept = cur.slice(b).split('\n').length;
  console.log(`spliced the SPELLS map into ${target}; ${kept} lines of hand-maintained code below it untouched.`);
}
