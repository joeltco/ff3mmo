// shop-flag.cjs — find the story flag that keeps Kazus's shops shut.
//
// Kazus is cursed: a ghost stands behind every counter and no shop opens on a
// fresh game (see docs/KAZUS.md). Canon shop inventories cannot be read until
// the emulated game is put PAST the curse, so: find the flag, set it, re-probe.
//
// The method is a DIFF, not a guess. Ur's weapon shop (map 5) and Kazus's
// weapon shop (map 16) are the same room layout with the same counter position,
// and one opens while the other does not. Hook every CPU read during the moment
// the shop would open, in both, and the addresses read ONLY in Kazus are where
// the extra check lives.
//
//   node tools/monscan/shop-flag.cjs                 # trace + diff
//   POKE=0x6234 node tools/monscan/shop-flag.cjs 16  # force one candidate
//
// Stage 2 (`SWEEP=1`) pokes each candidate to 0xFF before the counter press and
// reports which one makes the shop open — the flag is whichever one does.

const { Nes, BTN } = require('./nes.cjs');
const { mkdirSync } = require('fs');

const ROM_PATH = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const SHOTS = process.env.SHOT || '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/flag';
mkdirSync(SHOTS, { recursive: true });

function run(n, nes) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, hold = 8, after = 22) {
  nes.nes.buttonDown(1, BTN[b]); run(hold, nes);
  nes.nes.buttonUp(1, BTN[b]); run(after, nes);
}
function inBattle(nes) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++;
  return c > 12;
}
function bootToField(nes) {
  run(300, nes);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let block = 0; block < 10; block++) {
    for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25);
    press(nes, 'down', 8, 40);
  }
  run(400, nes);
  for (let t = 0; t < 40 && inBattle(nes); t++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(240, nes);
  }
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30);
  run(180, nes);
}
// Warp while re-asserting a poke every frame, so the value survives whatever
// the map-load code does to it on the way in.
function warpHolding(nes, mapId, poke, holdFrames = 300) {
  const cpu = nes.nes.cpu;
  for (let f = 0; f < holdFrames; f++) {
    if (poke) for (const a of poke.addrs) cpu.mem[a] = poke.value;
    cpu.mem[0x0700] = mapId & 0xFF;
    cpu.mem[0x00AB] = 0x80;
    nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) {
      // Keep holding through the load itself.
      for (let k = 0; k < 90; k++) {
        if (poke) for (const a of poke.addrs) cpu.mem[a] = poke.value;
        nes.nes.frame();
      }
      return true;
    }
  }
  return false;
}

function warp(nes, mapId, holdFrames = 300) {
  const cpu = nes.nes.cpu;
  for (let f = 0; f < holdFrames; f++) {
    cpu.mem[0x0700] = mapId & 0xFF;
    cpu.mem[0x00AB] = 0x80;
    nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) return true;
  }
  return false;
}

// Is the SHOP open — as opposed to a dialogue box, which is also a big blue
// panel and which a blue-fraction test happily calls a shop. That false
// positive already cost one sweep: the ghost shopkeeper says "The Djinn's curse
// has left me in this state..." and the detector read it as an open shop.
//
// MEASURED against three known frames (an open Ur shop, that ghost's message
// box, and a plain map):
//
//              top band   gap between the two top boxes
//   shop         0.43       0.25   <- black strip, two separate boxes
//   message box  0.46       0.69   <- one box spanning the width
//   map          0.00       0.00
//
// So: blue up top AND a dark gap at x 72-88. The gap is what separates a shop's
// two-box header ("Weapons" | "Welcome!") from a single wide message box.
function shopIsOpen(nes) {
  const fb = nes.nes.ppu.buffer;
  if (!fb) return false;
  const W = 256;
  const frac = (x0, y0, x1, y1) => {
    let n = 0, t = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = fb[y * W + x];
        const r = p & 255, g = (p >> 8) & 255, b = (p >> 16) & 255;
        t++;
        if (b > 100 && b > r + 50 && b > g + 40) n++;
      }
    }
    return t ? n / t : 0;
  };
  return frac(0, 8, 256, 40) > 0.2 && frac(72, 16, 88, 32) < 0.45;
}

// Walk to the counter and try to open the shop, recording every CPU read while
// it happens. Returns { opened, reads:Map(addr->count) }.
function approachCounter(nes, { record = false, steps = 4, poke = null } = {}) {
  const cpu = nes.nes.cpu;
  const reads = new Map();
  let orig = null;
  if (record) {
    orig = cpu.load.bind(cpu);
    cpu.load = function (addr) {
      // Only the two windows a story flag could live in: RAM and cart SRAM.
      if (addr < 0x800 || (addr >= 0x6000 && addr < 0x8000)) {
        reads.set(addr, (reads.get(addr) || 0) + 1);
      }
      return orig(addr);
    };
  }
  // ⛔ Verify the poke LANDS before trusting a negative. A write that never
  // took looks exactly like "this address is not the flag", and that mistake
  // costs a whole sweep. Read back through the CPU's own load path.
  if (poke != null) {
    for (const a of poke.addrs) cpu.mem[a] = poke.value;
    const stuck = poke.addrs.filter(a => cpu.load(a) !== poke.value);
    if (stuck.length) {
      console.log(`  !! poke did NOT land at ${stuck.slice(0, 6).map(a => '$' + a.toString(16)).join(' ')}` +
        (stuck.length > 6 ? ` (+${stuck.length - 6} more)` : '') + ' — result below is meaningless');
    } else {
      console.log(`  poke verified: ${poke.addrs.length} address(es) read back as 0x${poke.value.toString(16)}`);
    }
  }
  for (let i = 0; i < steps; i++) {
    if (poke != null) for (const a of poke.addrs) cpu.mem[a] = poke.value;
    press(nes, 'up', 14, 26);
    if (poke != null) for (const a of poke.addrs) cpu.mem[a] = poke.value;
    press(nes, 'a', 8, 30);
    run(30, nes);
    if (shopIsOpen(nes)) break;
  }
  run(40, nes);
  if (orig) cpu.load = orig;
  return { opened: shopIsOpen(nes), reads };
}

function visit(mapId, opts = {}) {
  const nes = new Nes(ROM_PATH);
  bootToField(nes);
  if (inBattle(nes)) return { error: 'stuck in battle' };

  // TRACE=load records during the WARP and the frames right after it, not at
  // the counter. A cursed town decides ghosts-or-people when the map LOADS —
  // the shopkeeper you walk up to is already a ghost — so the flag is read
  // there, and a counter-window trace never sees it. That is why the first
  // sweep came back with six addresses none of which opened anything.
  const loadTrace = opts.record && process.env.TRACE === 'load';
  const cpu = nes.nes.cpu;
  const reads = new Map();
  let orig = null;
  if (loadTrace) {
    orig = cpu.load.bind(cpu);
    cpu.load = function (addr) {
      if (addr < 0x800 || (addr >= 0x6000 && addr < 0x8000)) reads.set(addr, (reads.get(addr) || 0) + 1);
      return orig(addr);
    };
  }
  // ⛔ Poke BEFORE the warp, and hold it across the load. A cursed town decides
  // ghosts-or-people while the map loads, so a flag set afterwards changes
  // nothing — the ghosts are already standing there. The first sweep poked only
  // at the counter and reported every candidate as "still shut", which is a
  // property of WHEN it poked, not of the addresses.
  const prePoke = opts.poke || null;
  if (prePoke) {
    for (const a of prePoke.addrs) cpu.mem[a] = prePoke.value;
    const stuck = prePoke.addrs.filter(a => cpu.load(a) !== prePoke.value);
    console.log(stuck.length
      ? `  !! pre-warp poke did NOT land at ${stuck.slice(0, 6).map(a => '$' + a.toString(16)).join(' ')}`
      : `  pre-warp poke verified: ${prePoke.addrs.length} address(es) = 0x${prePoke.value.toString(16)}`);
  }
  let took = false;
  try { took = warpHolding(nes, mapId, prePoke); } catch (e) { if (orig) cpu.load = orig; return { error: 'warp crashed: ' + e.message }; }
  if (!took) { if (orig) cpu.load = orig; return { error: 'warp not accepted' }; }
  run(150, nes);
  if (loadTrace) { cpu.load = orig; }

  const r = approachCounter(nes, loadTrace ? { ...opts, record: false } : opts);
  nes.screenshot(`${SHOTS}/flag-${mapId}${opts.tag || ''}.png`);
  return loadTrace ? { opened: r.opened, reads } : r;
}

const arg = parseInt(process.argv[2] || '0', 10);

if (process.env.SWEEP) {
  // Stage 2 — force each candidate and see which one opens the shop.
  const cands = (process.env.CANDS || '').split(',').map(s => parseInt(s.trim(), 16)).filter(n => !isNaN(n));
  if (!cands.length) { console.error('SWEEP needs CANDS=0x..,0x..'); process.exit(2); }
  const VAL = parseInt(process.env.VAL || '0xFF', 16);
  if (process.env.GROUP) {
    // Poke the whole set at once. 34 candidates one at a time is 34 boots at a
    // couple of minutes each; bisecting a group is ~6. If the group opens the
    // shop the flag is inside it, and halving finds which.
    console.log(`GROUP poke of ${cands.length} address(es) = 0x${VAL.toString(16)} on map ${arg || 16}`);
    const r = visit(arg || 16, { record: false, poke: { addrs: cands, value: VAL }, tag: '-group' });
    console.log(r.error ? '  ERR ' + r.error : (r.opened ? '  *** SHOP OPENED ***' : '  still shut'));
    process.exit(0);
  }
  console.log(`sweeping ${cands.length} candidate(s) on map ${arg || 16}`);
  for (const a of cands) {
    const r = visit(arg || 16, { record: false, poke: { addrs: [a], value: VAL }, tag: '-poke' + a.toString(16) });
    console.log(`  $${a.toString(16).padStart(4, '0')} = 0x${VAL.toString(16)} -> ` +
      (r.error ? 'ERR ' + r.error : (r.opened ? '*** SHOP OPENED ***' : 'still shut')));
  }
  process.exit(0);
}

// Stage 1 — trace both shops and diff.
console.log('tracing Ur weapon shop (map 5) — this one OPENS');
const ur = visit(5, { record: true, tag: '-ur' });
console.log('  opened:', ur.opened, ur.error || '');
console.log('tracing Kazus weapon shop (map 16) — this one is SHUT');
const kz = visit(16, { record: true, tag: '-kz' });
console.log('  opened:', kz.opened, kz.error || '');

if (ur.error || kz.error) process.exit(1);
const only = [...kz.reads.keys()].filter(a => !ur.reads.has(a)).sort((a, b) => a - b);
const ram = only.filter(a => a < 0x800);
const sram = only.filter(a => a >= 0x6000);
console.log(`\nread ONLY while Kazus refused (${only.length} addresses)`);
console.log('  RAM  : ' + (ram.length ? ram.map(a => '$' + a.toString(16).padStart(3, '0')).join(' ') : 'none'));
console.log('  SRAM : ' + (sram.length ? sram.map(a => '$' + a.toString(16)).join(' ') : 'none'));
console.log('\nnext: SWEEP=1 CANDS=<comma-separated hex> node tools/monscan/shop-flag.cjs 16');
