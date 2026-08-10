// Prove the headless cast path reproduces KNOWN-GOOD spell art.
//
//   node spell-verify.cjs
//
// Fire ($31) already has verified tile bytes in src/spell-anim.js — captured
// from a hand-run REC OAM session and gated by tools/parity-check-spell.js.
// That makes it the one spell whose answer is known in advance, so it is the
// only honest way to test a new capture path: drive Fire headlessly, read the
// tiles the PPU actually holds during the impact, and compare byte-for-byte
// against what shipped. Anything less than an exact match means the path is
// wrong, and no other spell captured with it can be trusted.
//
// The cast window is LOCATED, not counted. Every content hash the $49-$60 band
// holds while the menus are open is recorded first; recording starts the frame
// a hash appears there that the menus never produced. No press-count guessing,
// which is what made the earlier attempts land on the wrong frames.

const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes, BTN } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const LO = 0x49, HI = 0x60;

const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const SRAM_BASE = 0x6000, CHARS_A_OFF = 0x100, CHARS_B_OFF = 0x200;
const JOB_OFF = 0x00, LEVEL_OFF = 0x01, MP_OFF = 0x30;
const SPELL_LIST_OFF = 0x07, JOB_LEVELS_OFF = 0x10;
const SAGE = 0x14, ALL_MASK = 0x7F;

function grantMagic(n) {
  const a = SRAM_BASE + CHARS_A_OFF, b = SRAM_BASE + CHARS_B_OFF;
  n.ram[a + JOB_OFF] = SAGE;
  n.ram[a + LEVEL_OFF] = 50;
  n.ram[b + JOB_LEVELS_OFF + SAGE * 2] = 99;
  for (let lvl = 0; lvl < 8; lvl++) {
    n.ram[a + MP_OFF + lvl * 2] = 0x09;
    n.ram[a + MP_OFF + lvl * 2 + 1] = 0x09;
    n.ram[b + SPELL_LIST_OFF + lvl] = ALL_MASK;
  }
}

function singleSpawnRom(id) {
  const rom = readFileSync(BASE_ROM);
  const gob = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((v) => v === 0x00)) gob.push(e);
  }
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === id) { list = m; break; }
  }
  const p = Buffer.from(rom), mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = id; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (const g of gob) { p[ENCOUNTER_SET + g * 2] = list; p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0; }
  const path = join(mkdtempSync(join(tmpdir(), 'spellverify-')), 'p.nes');
  writeFileSync(path, p);
  return path;
}

const spriteCount = (n) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (n.nes.ppu.sprY[i] < 0xEF) c++;
  return c;
};
// Per-scanline, not per-frame. MMC3 swaps CHR mid-screen and FF3 leaves the UI
// bank mapped by the time frame() returns, so an end-of-frame read of $49-$60
// reports menu tiles no matter what the effect drew. Reading every 8 scanlines
// and keeping the union is what the README's first trap is about; the first cut
// of this tool ignored it and matched 0 of 10 shipped Fire tiles.
const perFrame = [];                       // Map(slot -> Set(hex)) for the frame just run
function installSampler(n) {
  const ppu = n.nes.ppu;
  const orig = ppu.endScanline.bind(ppu);
  let cur = null;
  ppu.endScanline = () => {
    orig();
    if (ppu.scanline % 8) return;
    if (!cur) { cur = new Map(); perFrame.push(cur); }
    const base = ppu.f_spPatternTable ? 0x1000 : 0x0000;
    for (let t = LO; t <= HI; t++) {
      const hex = Buffer.from(n.vram.slice(base + t * 16, base + t * 16 + 16)).toString('hex');
      if (hex === '0'.repeat(32)) continue;
      if (!cur.has(t)) cur.set(t, new Set());
      cur.get(t).add(hex);
    }
    if (ppu.scanline >= 232) cur = null;    // next sample starts a new frame
  };
}
/** Every byte-pattern slot `t` held during the frame most recently run. */
const slotStates = (t) => {
  const last = perFrame[perFrame.length - 1];
  return last && last.has(t) ? [...last.get(t)] : [];
};
const dropFrames = () => { perFrame.length = 0; };

// ── boot into a fight with a fully-stocked Sage ────────────────────
const n = new Nes(singleSpawnRom(0x00));
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
let inBattle = false;
for (let blk = 0; blk < 20 && !inBattle; blk++) {
  for (let k = 0; k < 6 && !inBattle; k++) { grantMagic(n); n.press('a', 8, 25); inBattle = spriteCount(n) > 12; }
  if (!inBattle) { grantMagic(n); n.press('down', 8, 40); inBattle = spriteCount(n) > 12; }
}
if (!inBattle) { console.error('never reached a battle'); process.exit(2); }
n.run(60);

// ── select Fire: Magic → 7 rows down (levels 8..2) → column 1 ──────
// Confirmed off the game's own menu: the rows read Flare/Death/Meteor,
// Quake/Breakga/Drain, Firaga/Bio/Warp, Thundara/Raze/Erase, ... , Fire/
// Blizzard/Sleep — i.e. seven levels of seven IDs, then level 1 at $31.
installSampler(n);
const menuSeen = new Set();
const noteSlots = () => {
  for (const frame of perFrame) for (const [t, set] of frame) for (const hex of set) menuSeen.add(t + ':' + hex);
  dropFrames();
};
const step = (btn) => { n.press(btn, 8, 30); noteSlots(); };

step('a'); step('down'); step('a');
for (let i = 0; i < 7; i++) step('down');
step('a');                                   // pick Fire
step('a');                                   // confirm the goblin as target

// The other three GUARD, they do not attack. Three fighters kill a 32 HP goblin
// before the Sage's turn comes up, so the first attempt recorded the physical
// round and "Enemy defeated!" — Fire was never cast at all. Guard leaves the
// target alive for the spell.
for (let c = 0; c < 3; c++) { step('down'); step('a'); }

// Record EVERY frame of the round rather than starting once new CHR is spotted.
// The round begins inside the commit presses, so the earlier version folded the
// Fire tiles into the menu baseline and then never recognised them as new — it
// recorded the goblin's counterattacks instead.
const record = [];
let castFrame = -1;
for (let f = 0; f < 600; f++) {
  const snap = { f, tiles: {}, pal: n.palette().slice(16), oam: [] };
  for (let t = LO; t <= HI; t++) {
    const states = slotStates(t);
    if (states.length) snap.tiles[t] = states;
  }
  const p = n.nes.ppu;
  for (let i = 0; i < 64; i++) {
    if (p.sprY[i] >= 0xEF) continue;
    const tile = p.sprTile[i];
    if (tile < LO || tile > HI) continue;
    snap.oam.push({ tile, x: p.sprX[i], y: p.sprY[i], pal: p.sprCol[i] >> 2, h: !!p.horiFlip[i], v: !!p.vertFlip[i] });
  }
  if (castFrame < 0) {
    for (const t of Object.keys(snap.tiles)) {
      if (snap.tiles[t].some((hex) => !menuSeen.has(t + ':' + hex))) { castFrame = f; break; }
    }
  }
  record.push(snap);
  if (f % 8 === 0) n.screenshot(`/tmp/spellverify-${String(f).padStart(3, '0')}.png`);
  dropFrames();
  // Keep tapping A while recording instead of counting presses beforehand.
  // Exact press counts kept landing either before the round started or after
  // the cast was over; recording continuously makes the count stop mattering.
  if (f < 200 && f % 20 === 0) { n.nes.buttonDown(1, BTN.a); n.run(1); n.nes.buttonUp(1, BTN.a); }
  else n.run(1);
}
console.log(castFrame < 0 ? 'no CHR outside the menu baseline appeared'
  : `first non-menu CHR in $49-$60 at frame +${castFrame}`);

// ── compare against the shipped, already-verified Fire bytes ───────
const src = readFileSync(REPO + '/src/spell-anim.js', 'utf8');
const shipped = {};
for (const m of src.matchAll(/const FIRE_T_([0-9A-F]{2}) = new Uint8Array\(\[([^\]]+)\]\)/g)) {
  shipped[parseInt(m[1], 16)] = m[2].split(',').map((s) => parseInt(s.trim(), 16))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}
const wantSlots = Object.keys(shipped).map(Number).sort((a, b) => a - b);
console.log(`shipped Fire impact: ${wantSlots.length} tiles, $${wantSlots[0].toString(16)}-$${wantSlots[wantSlots.length - 1].toString(16)}`);

let best = null;
for (const snap of record) {
  let hit = 0;
  for (const t of wantSlots) if ((snap.tiles[t] || []).includes(shipped[t])) hit++;
  if (!best || hit > best.hit) best = { hit, f: snap.f, oam: snap.oam.length };
}
console.log(`best frame: ${best.hit}/${wantSlots.length} slots match the shipped bytes exactly ` +
  `(frame +${best.f}, ${best.oam} effect sprites on screen)`);

writeFileSync(__dirname + '/spell-verify.json', JSON.stringify({ castFrame, record }));
console.log('-> spell-verify.json');
process.exit(best.hit === wantSlots.length ? 0 : 1);
