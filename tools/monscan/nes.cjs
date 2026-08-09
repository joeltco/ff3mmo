// Headless NES harness for FF3 sprite/palette capture.
//
// jsnes ships a UMD bundle but its package.json says "type": "module", so Node
// loads dist/jsnes.js as ESM, the UMD's CommonJS branch never runs, and the
// import comes back empty. vendor/jsnes.cjs is a byte copy with a .cjs suffix
// so Node treats it as CommonJS and the exports actually appear.
const { readFileSync, writeFileSync } = require('fs');
const zlib = require('zlib');
const jsnes = require('./vendor/jsnes.cjs');

const ROM = '/home/joeltco/projects/ff3mmo/Final Fantasy III (Japan).nes';

const BTN = {
  a: jsnes.Controller.BUTTON_A,
  b: jsnes.Controller.BUTTON_B,
  select: jsnes.Controller.BUTTON_SELECT,
  start: jsnes.Controller.BUTTON_START,
  up: jsnes.Controller.BUTTON_UP,
  down: jsnes.Controller.BUTTON_DOWN,
  left: jsnes.Controller.BUTTON_LEFT,
  right: jsnes.Controller.BUTTON_RIGHT,
};

class Nes {
  constructor(romPath = ROM) {
    this.fb = new Uint32Array(256 * 240);
    this.frames = 0;
    this.nes = new jsnes.NES({
      onFrame: (buf) => { this.fb.set(buf); this.frames++; },
      onAudioSample: () => {},
    });
    this.nes.loadROM(readFileSync(romPath, 'binary'));
  }

  /** Advance n frames with no input. */
  run(n) { for (let i = 0; i < n; i++) this.nes.frame(); return this; }

  /**
   * Every distinct pattern-table state seen during one frame.
   *
   * MMC3 swaps CHR banks mid-frame — FF3 shows monster tiles at the top of the
   * screen and UI tiles at the bottom. Reading the pattern table after
   * nes.frame() returns therefore gives whatever was mapped last, which is the
   * UI bank. That's why searching for a monster's tile bytes found goblins
   * (still mapped) but missed everything larger. Snapshotting per scanline and
   * keeping the distinct states catches the monster's bank while it's live.
   */
  patternSnapshots() {
    const ppu = this.nes.ppu;
    const seen = new Map();
    const orig = ppu.endScanline.bind(ppu);
    ppu.endScanline = () => {
      orig();
      if (ppu.scanline % 8 === 0) {
        const buf = Buffer.from(this.vram.slice(0, 0x2000));
        const key = buf.length + ':' + buf.readUInt32LE(0) + ':' + buf.readUInt32LE(0x1000);
        if (!seen.has(key)) seen.set(key, buf);
      }
    };
    try { this.nes.frame(); } finally { ppu.endScanline = orig; }
    return [...seen.values()];
  }

  /** Hold a button for `hold` frames, then idle for `after`. */
  press(name, hold = 4, after = 6) {
    const b = BTN[name];
    if (b === undefined) throw new Error('unknown button ' + name);
    this.nes.buttonDown(1, b);
    this.run(hold);
    this.nes.buttonUp(1, b);
    return this.run(after);
  }

  /** Hold a direction for n frames without releasing between frames. */
  hold(name, n) {
    const b = BTN[name];
    this.nes.buttonDown(1, b);
    this.run(n);
    this.nes.buttonUp(1, b);
    return this;
  }

  // ── savestates ──────────────────────────────────────────────────
  // Reaching a battle costs ~3000 frames of scripted input. Snapshot once and
  // restore per monster instead of replaying the intro 195 times.
  //
  // jsnes' fromJSON does raw property assignment, so a state captured from a
  // live machine must be deep-cloned before reuse or two restores will alias
  // the same arrays and corrupt each other.
  save() { return JSON.parse(JSON.stringify(this.nes.toJSON())); }

  load(state) {
    this.nes.fromJSON(JSON.parse(JSON.stringify(state)));
    return this;
  }

  // ── memory views ────────────────────────────────────────────────
  get ram() { return this.nes.cpu.mem; }            // $0000-$07FF mirrored
  get vram() { return this.nes.ppu.vramMem; }

  /** 32 bytes of palette RAM at $3F00, masked to real NES indices. */
  palette() {
    const out = [];
    for (let i = 0; i < 32; i++) out.push(this.vram[0x3F00 + i] & 0x3F);
    return out;
  }

  /** Nametable 0 tile ids (960) — what's actually on screen. */
  nametable() { return Array.from(this.vram.slice(0x2000, 0x23C0)); }

  /** Attribute table 0 (64 bytes). Each byte = palette select for a 32x32 area,
   *  2 bits per 16x16 quadrant. This is the data the monster catalog is missing. */
  attributes() { return Array.from(this.vram.slice(0x23C0, 0x2400)); }

  /** Palette index (0-3) for the tile at nametable column/row. */
  paletteAt(col, row) {
    const attr = this.vram[0x23C0 + ((row >> 2) * 8) + (col >> 2)];
    const shift = ((row & 2) << 1) | (col & 2);
    return (attr >> shift) & 3;
  }

  /** Write the current frame to a PNG so it can be eyeballed. */
  screenshot(path) {
    writeFileSync(path, encodePng(this.fb, 256, 240));
    return path;
  }
}

// ── minimal PNG encoder (truecolour, no deps) ─────────────────────
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(fb, w, h) {
  // jsnes packs each pixel as 0xAABBGGRR in a Uint32Array.
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;                                   // filter: none
    for (let x = 0; x < w; x++) {
      const px = fb[y * w + x];
      raw[p++] = px & 0xFF;
      raw[p++] = (px >> 8) & 0xFF;
      raw[p++] = (px >> 16) & 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { Nes, BTN, encodePng, ROM };
