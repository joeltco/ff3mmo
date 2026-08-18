// fm2-replay.cjs — replay an FCEUX .fm2 movie on the headless harness.
//
// ⭐ WHY THIS EXISTS: the launch animations (Cid's airship out of the sand, the
// Invincible out of the water, the Enterprise transforming) sit behind real
// progression. You cannot press buttons headlessly to reach them, and the same
// wall blocks any probe that needs the WORLD MAP rather than a battle. A movie
// walks the game there for free.
//
// ⛔ MOVIES ARE ROM-LOCKED. Both movies in tools/movies/ carry
// romChecksum base64:RafQLtDckmZaMNodm0rzXQ== = md5 45a7d02ed0dc92665a30da1d9b4af35d,
// which is the JP ROM *without* its 16-byte iNES header. FF3-English.nes hashes
// 2e517105c0084e36a8e7d47f941a2c8c and WILL desync. This module verifies the
// hash and refuses rather than replaying into garbage — a desynced movie still
// produces a plausible-looking screen, which is exactly the failure that reads
// as success.
//
// fm2 input line: |cmd|port0|port1||  with 8 chars per port in order RLDUTSBA,
// '.' meaning released.
//
//   node tools/fm2-replay.cjs tools/movies/naruko-finalfantasyiii.fm2 --frames 20000 --png out.png
//
const { readFileSync } = require('fs');
const crypto = require('crypto');

const ORDER = ['right', 'left', 'down', 'up', 'start', 'select', 'b', 'a'];

function parseFm2(path) {
  const txt = readFileSync(path, 'utf8');
  const header = {};
  const frames = [];
  for (const line of txt.split('\n')) {
    if (line.startsWith('|')) {
      // |cmd|port0|port1||
      const parts = line.split('|');
      const cmd = parseInt(parts[1], 10) || 0;
      const p0 = parts[2] || '........';
      const held = [];
      for (let i = 0; i < 8; i++) if (p0[i] && p0[i] !== '.') held.push(ORDER[i]);
      frames.push({ cmd, held });
    } else {
      const sp = line.indexOf(' ');
      if (sp > 0) header[line.slice(0, sp)] = line.slice(sp + 1).trim();
    }
  }
  return { header, frames };
}

/** md5 of the ROM with the 16-byte iNES header stripped — what fm2 records. */
function romHashHeaderless(romPath) {
  const buf = readFileSync(romPath);
  return crypto.createHash('md5').update(buf.subarray(16)).digest('hex');
}

function expectedHash(header) {
  const raw = (header.romChecksum || '').replace(/^base64:/, '');
  if (!raw) return null;
  return Buffer.from(raw, 'base64').toString('hex');
}

/**
 * Replay `movie` on `nes` for `count` frames.
 * onFrame(i, nes) is called AFTER each frame; return false to stop early.
 */
function replay(nes, movie, count, onFrame) {
  const held = new Set();
  const n = Math.min(count, movie.frames.length);
  for (let i = 0; i < n; i++) {
    const f = movie.frames[i];
    // ⛔ THE COMMAND COLUMN IS NOT DECORATION. Both movies in tools/movies/ issue
    // a soft reset (cmd bit 0) within the first ten frames, and the glitched TAS
    // issues two more at ~39005 and ~39670 — FF3's reset trick. Ignoring them
    // desyncs everything downstream, and a desynced FF3 still renders a party
    // walking around a cave, which reads as a successful replay. Soft reset =
    // jump the reset vector with RAM INTACT (cpu.requestIrq(IRQ_RESET)), NOT
    // nes.reset(), which rebuilds the CPU/PPU/mapper and wipes RAM to 0xFF.
    if (f.cmd & 1) {
      const cpu = nes.nes.cpu;
      cpu.requestIrq(cpu.IRQ_RESET);
    }
    const want = new Set(f.held);
    for (const b of held) if (!want.has(b)) { nes.nes.buttonUp(1, BTNOF(b)); held.delete(b); }
    for (const b of want) if (!held.has(b)) { nes.nes.buttonDown(1, BTNOF(b)); held.add(b); }
    nes.nes.frame();
    if (onFrame && onFrame(i, nes) === false) return i;
  }
  return n;
}

let _jsnes = null;
function BTNOF(name) {
  if (!_jsnes) _jsnes = require('./monscan/vendor/jsnes.cjs');
  const M = {
    a: _jsnes.Controller.BUTTON_A, b: _jsnes.Controller.BUTTON_B,
    select: _jsnes.Controller.BUTTON_SELECT, start: _jsnes.Controller.BUTTON_START,
    up: _jsnes.Controller.BUTTON_UP, down: _jsnes.Controller.BUTTON_DOWN,
    left: _jsnes.Controller.BUTTON_LEFT, right: _jsnes.Controller.BUTTON_RIGHT,
  };
  return M[name];
}

module.exports = { parseFm2, replay, romHashHeaderless, expectedHash };

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const moviePath = args[0];
  if (!moviePath) { console.error('usage: fm2-replay.cjs <movie.fm2> [--frames N] [--png out.png] [--rom path]'); process.exit(2); }
  const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
  const romPath = get('--rom', '/home/joeltco/projects/ff3mmo/Final Fantasy III (Japan).nes');
  const count = parseInt(get('--frames', '0'), 10) || Infinity;

  const movie = parseFm2(moviePath);
  const want = expectedHash(movie.header), got = romHashHeaderless(romPath);
  console.log(`movie   ${moviePath}`);
  console.log(`  frames in file : ${movie.frames.length}`);
  console.log(`  romFilename    : ${movie.header.romFilename}`);
  console.log(`  expects md5    : ${want}`);
  console.log(`  rom headerless : ${got}  ${want === got ? '✅ match' : '⛔ MISMATCH'}`);
  if (want && want !== got) {
    console.error('\n⛔ Refusing to replay: the movie was recorded on a different ROM and will desync.');
    console.error('   A desynced replay still renders a plausible screen — that is the trap.');
    process.exit(1);
  }
  const { Nes } = require('./monscan/nes.cjs');
  const nes = new Nes(romPath);
  const t0 = Date.now();
  const done = replay(nes, movie, count);
  console.log(`\nreplayed ${done} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const png = get('--png', null);
  if (png) { nes.screenshot(png); console.log(`screenshot -> ${png}`); }
}
