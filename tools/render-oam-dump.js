// tools/render-oam-dump.js
// Mechanical decode of an EMU REC OAM dump into per-frame PNGs + a contact sheet.
// Zero interpretation: parses the dump, decodes NES 2bpp tiles using the dump's
// own SP palettes, composites each (group, tile) at its origin, writes PNGs.
//
// Bring-up: `node tools/render-oam-dump.js ~/emu-snap-f9627.txt` → writes
// tools/oam-render/<basename>/frame-NNNN.png and contact.png. Open frame-0000.png
// to verify the decoder against a known reference (e.g. BM cast pose at origin
// 176,41). If the bring-up frame doesn't match the in-game reference, the
// decoder is wrong and nothing downstream is trustworthy.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// NES master palette (NESDev wiki canonical RGB approximation).
// Index 0x00-0x3F → [R,G,B]. Indices 0x0D, 0x1D, 0x2D, 0x3D are "blacker than
// black"; 0x0F is the standard universal black used by FF3.
const NES_PALETTE = [
  [ 84, 84, 84],[  0, 30,116],[  8, 16,144],[ 48,  0,136],[ 68,  0,100],[ 92,  0, 48],[ 84,  4,  0],[ 60, 24,  0],
  [ 32, 42,  0],[  8, 58,  0],[  0, 64,  0],[  0, 60,  0],[  0, 50, 60],[  0,  0,  0],[  0,  0,  0],[  0,  0,  0],
  [152,150,152],[  8, 76,196],[ 48, 50,236],[ 92, 30,228],[136, 20,176],[160, 20,100],[152, 34, 32],[120, 60,  0],
  [ 84, 90,  0],[ 40,114,  0],[  8,124,  0],[  0,118, 40],[  0,102,120],[  0,  0,  0],[  0,  0,  0],[  0,  0,  0],
  [236,238,236],[ 76,154,236],[120,124,236],[176, 98,236],[228, 84,236],[236, 88,180],[236,106,100],[212,136, 32],
  [160,170,  0],[116,196,  0],[ 76,208, 32],[ 56,204,108],[ 56,180,204],[ 60, 60, 60],[  0,  0,  0],[  0,  0,  0],
  [236,238,236],[168,204,236],[188,188,236],[212,178,236],[236,174,236],[236,174,212],[236,180,176],[228,196,144],
  [204,210,120],[180,222,120],[168,226,144],[152,226,180],[160,214,228],[160,162,160],[  0,  0,  0],[  0,  0,  0],
];

// ── Parser ──────────────────────────────────────────────────────────────────

function parseDump(text) {
  const lines = text.split('\n');
  const frames = [];
  let cur = null;
  let curGroup = null;
  let pendingTile = null;
  let palettes = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // Frame divider: `// ═══ frame N (snap @ fM, t≈Tms) ═══...`
    const fHdr = ln.match(/^\/\/ ═══ frame (\d+) \(snap @ f(\d+), t≈(-?\d+)ms\)/);
    if (fHdr) {
      if (cur) frames.push(cur);
      cur = {
        frameIdx: Number(fHdr[1]),
        frameNum: Number(fHdr[2]),
        tMs: Number(fHdr[3]),
        palettes: { bg: [[15,15,15,15],[15,15,15,15],[15,15,15,15],[15,15,15,15]],
                    sp: [[15,15,15,15],[15,15,15,15],[15,15,15,15],[15,15,15,15]] },
        groups: [],
      };
      curGroup = null;
      pendingTile = null;
      continue;
    }
    if (!cur) continue;

    // Palette lines: `//  SP3: [0x0F, 0x16, 0x27, 0x30]` (also BG0-3 / SP0-3)
    const palHdr = ln.match(/^\/\/\s+(BG|SP)([0-3]):\s*\[([^\]]+)\]/);
    if (palHdr) {
      const which = palHdr[1] === 'BG' ? 'bg' : 'sp';
      const idx = Number(palHdr[2]);
      const vals = palHdr[3].split(',').map(s => parseInt(s.trim(), 16));
      cur.palettes[which][idx] = vals;
      continue;
    }

    // Group header: `// ── group G (N tiles, origin X,Y) ──`
    const gHdr = ln.match(/^\/\/ ── group (\d+) \(\d+ tiles, origin (-?\d+),(-?\d+)\) ──/);
    if (gHdr) {
      curGroup = { origin: [Number(gHdr[2]), Number(gHdr[3])], tiles: [] };
      cur.groups.push(curGroup);
      pendingTile = null;
      continue;
    }
    if (!curGroup) continue;

    // Tile attribute line: `//   [dx,dy] tile=$XX palN [VFLIP] [HFLIP]`
    const tHdr = ln.match(/^\/\/\s+\[(-?\d+),(-?\d+)\] tile=\$([0-9A-Fa-f]+) pal(\d)( VFLIP)?( HFLIP)?/);
    if (tHdr) {
      pendingTile = {
        dx: Number(tHdr[1]),
        dy: Number(tHdr[2]),
        id: parseInt(tHdr[3], 16),
        pal: Number(tHdr[4]),
        vflip: !!tHdr[5],
        hflip: !!tHdr[6],
        bytes: null,
      };
      continue;
    }

    // Tile bytes: `new Uint8Array([0xNN,...]),`
    const tBytes = ln.match(/new Uint8Array\(\[([^\]]+)\]\)/);
    if (tBytes && pendingTile) {
      const bytes = tBytes[1].split(',').map(s => parseInt(s.trim(), 16));
      if (bytes.length !== 16) {
        throw new Error(`tile bytes wrong length ${bytes.length} at line ${i+1}`);
      }
      pendingTile.bytes = bytes;
      curGroup.tiles.push(pendingTile);
      pendingTile = null;
      continue;
    }
  }
  if (cur) frames.push(cur);
  return frames;
}

// ── Tile decode ─────────────────────────────────────────────────────────────

// 16 bytes → 64 indices (color 0-3). NES 2bpp planar:
//   bytes[0..7]   = bit-plane 0 for rows 0..7
//   bytes[8..15]  = bit-plane 1 for rows 0..7
//   pixel = (plane1 bit << 1) | plane0 bit, MSB-first within each row byte
function decodeTile(bytes) {
  const out = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    const p0 = bytes[row];
    const p1 = bytes[row + 8];
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const lo = (p0 >> bit) & 1;
      const hi = (p1 >> bit) & 1;
      out[row * 8 + col] = (hi << 1) | lo;
    }
  }
  return out;
}

// ── Frame compositor ────────────────────────────────────────────────────────

const SCREEN_W = 256;
const SCREEN_H = 240;
const BG = [24, 24, 32]; // dark slate so transparent vs sprite-pixel-with-color-0 is visible

function renderFrame(frame) {
  const buf = new Uint8Array(SCREEN_W * SCREEN_H * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = BG[0]; buf[i+1] = BG[1]; buf[i+2] = BG[2];
  }
  for (const group of frame.groups) {
    const [ox0, oy0] = group.origin;
    for (const tile of group.tiles) {
      const indices = decodeTile(tile.bytes);
      const palette = frame.palettes.sp[tile.pal] || [15,15,15,15];
      const tx = ox0 + tile.dx;
      const ty = oy0 + tile.dy;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const sr = tile.vflip ? 7 - row : row;
          const sc = tile.hflip ? 7 - col : col;
          const idx = indices[sr * 8 + sc];
          if (idx === 0) continue; // sprite color 0 is transparent
          const nesColor = palette[idx] & 0x3F;
          const [r, g, b] = NES_PALETTE[nesColor];
          const px = tx + col;
          const py = ty + row;
          if (px < 0 || px >= SCREEN_W || py < 0 || py >= SCREEN_H) continue;
          const pi = (py * SCREEN_W + px) * 3;
          buf[pi] = r; buf[pi+1] = g; buf[pi+2] = b;
        }
      }
    }
  }
  return buf;
}

// ── PNG encoder (truecolor RGB, no alpha) ───────────────────────────────────

function crc32(buf) {
  if (!crc32.table) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    crc32.table = t;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgb, w, h) {
  // Filter byte 0x00 prepended to each scanline.
  const stride = w * 3;
  const filtered = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    filtered[y * (stride + 1)] = 0;
    rgb.subarray ? Buffer.from(rgb.subarray(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1)
                 : Buffer.from(rgb.slice(y * stride, y * stride + stride)).copy(filtered, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(filtered);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 2;     // color type = truecolor RGB
  ihdr[10] = 0;    // compression
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // interlace
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Composite multiple frame buffers into one tall contact sheet.
function buildContactSheet(frameBufs, cols = 4) {
  const n = frameBufs.length;
  const rows = Math.ceil(n / cols);
  const sheetW = cols * SCREEN_W;
  const sheetH = rows * SCREEN_H;
  const sheet = new Uint8Array(sheetW * sheetH * 3);
  // Fill BG.
  for (let i = 0; i < sheet.length; i += 3) {
    sheet[i] = 0; sheet[i+1] = 0; sheet[i+2] = 0;
  }
  for (let f = 0; f < n; f++) {
    const cx = (f % cols) * SCREEN_W;
    const cy = Math.floor(f / cols) * SCREEN_H;
    const src = frameBufs[f];
    for (let y = 0; y < SCREEN_H; y++) {
      const srcOff = y * SCREEN_W * 3;
      const dstOff = ((cy + y) * sheetW + cx) * 3;
      for (let x = 0; x < SCREEN_W * 3; x++) sheet[dstOff + x] = src[srcOff + x];
    }
  }
  return { buf: sheet, w: sheetW, h: sheetH };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: node tools/render-oam-dump.js <dump.txt> [--frames N] [--out DIR]');
    process.exit(1);
  }
  const dumpPath = args[0];
  const framesArg = args.includes('--frames') ? Number(args[args.indexOf('--frames') + 1]) : null;
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

  const text = fs.readFileSync(dumpPath, 'utf8');
  const base = path.basename(dumpPath, path.extname(dumpPath));
  const outDir = outArg || path.join('tools', 'oam-render', base);
  fs.mkdirSync(outDir, { recursive: true });

  const frames = parseDump(text);
  console.log(`parsed ${frames.length} frames from ${dumpPath}`);

  const limit = framesArg ? Math.min(framesArg, frames.length) : frames.length;
  const bufs = [];
  for (let i = 0; i < limit; i++) {
    const buf = renderFrame(frames[i]);
    bufs.push(buf);
    const png = encodePNG(buf, SCREEN_W, SCREEN_H);
    const name = `frame-${String(frames[i].frameIdx).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(outDir, name), png);
  }
  console.log(`wrote ${limit} per-frame PNGs to ${outDir}/`);

  // Contact sheet (cap to 64 frames so it stays openable).
  const sheetCount = Math.min(bufs.length, 64);
  const sheet = buildContactSheet(bufs.slice(0, sheetCount), 4);
  const sheetPng = encodePNG(sheet.buf, sheet.w, sheet.h);
  fs.writeFileSync(path.join(outDir, 'contact.png'), sheetPng);
  console.log(`wrote contact sheet (${sheetCount} frames, ${sheet.w}×${sheet.h}) to ${outDir}/contact.png`);
}

main();
