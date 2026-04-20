// EMU tab — jsnes-backed NES emulator for PPU/OAM/palette capture.
// jsnes is loaded via <script src="lib/jsnes.min.js"> in index.html, exposed as window.jsnes.
import { applyIPS } from '../../ips-patcher.js';

const SCREEN_W = 256;
const SCREEN_H = 240;

// Controller button indices (jsnes.Controller)
const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
const KEY_MAP = {
  'w': BTN.UP, 'a': BTN.LEFT, 's': BTN.DOWN, 'd': BTN.RIGHT,
  'ArrowUp': BTN.UP, 'ArrowLeft': BTN.LEFT, 'ArrowDown': BTN.DOWN, 'ArrowRight': BTN.RIGHT,
  'j': BTN.B, 'k': BTN.A,
  '/': BTN.START, '.': BTN.SELECT,
};

let nes = null;
let dom = null;
let ctx = null;
let running = false;
let rafId = 0;
let frameCount = 0;
let imgData = null;
let img32 = null;
let canvasCtx = null;

// Savestate slot (single slot — persisted to localStorage so it survives refreshes).
const SAVESTATE_KEY = 'ff3_emu_savestate_v1';
let savedState = null;
try {
  const stored = localStorage.getItem(SAVESTATE_KEY);
  if (stored) savedState = JSON.parse(stored);
} catch { /* ignore */ }

// Audio — ring buffer filled by jsnes onAudioSample, drained by a ScriptProcessorNode.
// ScriptProcessor is deprecated but still universally supported and fine for 256×240 NES audio.
let audioCtx = null;
let audioNode = null;
let audioMuted = true; // start muted so we don't need a user gesture to show the EMU
const AUDIO_BUF = 8192;
const audioL = new Float32Array(AUDIO_BUF);
const audioR = new Float32Array(AUDIO_BUF);
let audioWrite = 0;
let audioRead = 0;

export function mount(root, context) {
  ctx = context;
  dom = _buildDOM(root);

  if (!window.jsnes) { _status('jsnes library not loaded (check lib/jsnes.min.js)', true); return; }
  const rom = ctx.getFF3Buffer();
  if (!rom) { _status('No ROM loaded — load FF3 on the title screen first', true); return; }

  _patchAndInit(rom);
}

async function _patchAndInit(romBuffer) {
  // IPS is overwrite-only, so re-applying to an already-patched buffer is a no-op.
  const patched = new Uint8Array(new Uint8Array(romBuffer));
  try {
    _status('fetching English IPS patch…');
    const resp = await fetch('patches/ff3-english.ips');
    if (resp.ok) {
      applyIPS(patched, new Uint8Array(await resp.arrayBuffer()));
      _status('IPS applied, booting…');
    } else {
      _status('no IPS patch found, booting raw ROM…');
    }
  } catch (e) {
    console.warn('[emu] IPS fetch failed', e);
    _status('IPS fetch failed, booting raw ROM…');
  }
  _initEmulator(patched.buffer);
}

export function unmount() {
  _stop();
  _teardownAudio();
  if (dom?._keyDown) window.removeEventListener('keydown', dom._keyDown, true);
  if (dom?._keyUp) window.removeEventListener('keyup', dom._keyUp, true);
  if (dom?.root) dom.root.remove();
  nes = null; dom = null; ctx = null; imgData = null; img32 = null; canvasCtx = null;
}

function _initEmulator(romBuffer) {
  _status(`ROM ${romBuffer.byteLength} bytes, converting…`);
  const bytes = new Uint8Array(romBuffer);
  let romStr = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    romStr += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }

  canvasCtx = dom.canvas.getContext('2d');
  imgData = canvasCtx.createImageData(SCREEN_W, SCREEN_H);
  img32 = new Uint32Array(imgData.data.buffer);

  // jsnes produces samples at 44100 by default. Our ScriptProcessor output will
  // run at the AudioContext's rate (usually 48000) — a ~9% pitch shift we accept
  // to avoid making a throwaway AudioContext just to read .sampleRate before boot.
  try {
    nes = new window.jsnes.NES({
      onFrame: _onFrame,
      onAudioSample: _onAudioSample,
      onStatusUpdate: (s) => { console.log('[jsnes]', s); _status('jsnes: ' + s); },
      onBatteryRamWrite: () => {},
      sampleRate: 44100,
    });
  } catch (e) {
    _status('NES ctor failed: ' + e.message, true); console.error(e); return;
  }

  _status('loading ROM into jsnes…');
  try {
    nes.loadROM(romStr);
  } catch (e) {
    _status('loadROM failed: ' + e.message, true);
    console.error('[emu] loadROM', e);
    return;
  }

  // Mapper info
  const mapper = nes.rom?.mapperType;
  const prgCount = nes.rom?.romCount;
  const chrCount = nes.rom?.vromCount;
  _status(`ROM ok — mapper ${mapper}, PRG ${prgCount}×16KB, CHR ${chrCount}×8KB. Starting…`);

  frameCount = 0;
  _start();

  // If no frame renders within 500ms, report it.
  setTimeout(() => {
    if (frameCount === 0 && running) _status('no frames after 500ms — jsnes may be stuck', true);
  }, 500);
}

function _onFrame(buffer) {
  // jsnes frame buffer holds RGB packed as 0x00BBGGRR — we OR in full alpha.
  for (let i = 0; i < SCREEN_W * SCREEN_H; i++) img32[i] = 0xFF000000 | buffer[i];
  canvasCtx.putImageData(imgData, 0, 0);
  frameCount++;
  // Update only the frame counter element — status messages live separately.
  if (dom?.frame) dom.frame.textContent = running ? `f${frameCount}` : `⏸ f${frameCount}`;
}

function _start() {
  if (running) return;
  running = true;
  // NES NTSC runs at ~60.098 Hz. rAF fires at display refresh (often 90/120Hz on Android),
  // so we pace frames by wall-clock time rather than running one NES frame per rAF.
  const FRAME_MS = 1000 / 60.0988;
  let nextDue = performance.now();
  const tick = () => {
    if (!running || !nes) return;
    const now = performance.now();
    // If we fell more than ~5 frames behind (tab was hidden, etc), snap forward.
    if (now - nextDue > FRAME_MS * 5) nextDue = now;
    let steps = 0;
    while (now >= nextDue && steps < 3) {
      nes.frame();
      nextDue += FRAME_MS;
      steps++;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function _stop() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function _togglePause() {
  if (running) { _stop(); dom.btnPause.textContent = 'PLAY'; _status(`paused @ frame ${frameCount}`); }
  else { _start(); dom.btnPause.textContent = 'PAUSE'; }
}

function _step() {
  if (!nes) return;
  if (running) _togglePause();
  nes.frame();
}

function _reset() {
  if (!nes) return;
  _stop();
  // nes.reset() clears CPU/PPU/PAPU/mmap state but leaves PC at its default (0x7FFF).
  // mmap.loadROM() reloads PRG/CHR *and* queues IRQ_RESET so the CPU jumps to the
  // reset vector ($FFFC/$FFFD) on the next frame — that's the real power-on path.
  try {
    nes.reset();
    nes.mmap.loadROM();
    nes.ppu.setMirroring(nes.rom.getMirroringType());
  } catch (e) {
    _status('reset failed: ' + e.message, true); console.error('[emu] reset', e); return;
  }
  frameCount = 0;
  _status('reset — running');
  dom.btnPause.textContent = 'PAUSE';
  _start();
}

// ── Audio ───────────────────────────────────────────────────────────────────

function _onAudioSample(l, r) {
  if (audioMuted) return;
  audioL[audioWrite] = l;
  audioR[audioWrite] = r;
  audioWrite = (audioWrite + 1) % AUDIO_BUF;
  // If we've lapped the read pointer, drop samples (prefer fresh audio over growing lag).
  if (audioWrite === audioRead) audioRead = (audioRead + 1) % AUDIO_BUF;
}

function _initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { _status('no Web Audio support', true); return; }
  audioCtx = new AC();
  audioNode = audioCtx.createScriptProcessor(1024, 0, 2);
  audioNode.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const len = outL.length;
    for (let i = 0; i < len; i++) {
      if (audioRead === audioWrite) { outL[i] = 0; outR[i] = 0; continue; }
      outL[i] = audioL[audioRead];
      outR[i] = audioR[audioRead];
      audioRead = (audioRead + 1) % AUDIO_BUF;
    }
  };
  audioNode.connect(audioCtx.destination);
}

function _toggleSound() {
  if (audioMuted) {
    _initAudio();
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    audioMuted = false;
    dom.btnSound.textContent = 'MUTE';
  } else {
    audioMuted = true;
    if (audioCtx?.state === 'running') audioCtx.suspend();
    dom.btnSound.textContent = 'SOUND';
  }
}

function _teardownAudio() {
  audioMuted = true;
  if (audioNode) { try { audioNode.disconnect(); } catch {} audioNode = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  audioRead = audioWrite = 0;
}

function _status(msg, err = false) {
  if (!dom?.status) return;
  dom.status.textContent = msg;
  dom.status.style.color = err ? '#f66' : '#c8a832';
}

// ── Savestate ───────────────────────────────────────────────────────────────

// jsnes.toJSON() includes the full ROM (~256KB → ~1MB as JSON) which blows
// through localStorage quota on mobile. Strip it before persisting, re-attach
// on load — the ROM is available from ctx.getFF3Buffer() anyway.
function _saveState() {
  if (!nes) return;
  try {
    const full = nes.toJSON();
    const romData = full.romData;
    const slim = { ...full, romData: null };
    savedState = slim;
    try {
      const json = JSON.stringify(slim);
      localStorage.setItem(SAVESTATE_KEY, json);
      const kb = Math.round(json.length / 1024);
      _status(`state saved @ frame ${frameCount} (${kb} KB persisted)`);
    } catch (e) {
      console.warn('[emu] localStorage save failed', e);
      _status(`state saved @ frame ${frameCount} (in-memory only — localStorage: ${e.message})`, true);
    }
    // Keep romData on the in-memory copy so LOAD doesn't need to re-fetch.
    savedState.romData = romData;
  } catch (e) { _status('save failed: ' + e.message, true); console.error(e); }
}

function _loadState() {
  if (!nes || !savedState) { _status('no saved state', true); return; }
  try {
    // If state came from localStorage (refresh), romData was stripped to fit.
    // nes.romData is the already-loaded ROM string — re-attach for fromJSON.
    if (!savedState.romData && nes.romData) {
      savedState.romData = nes.romData;
    }
    nes.fromJSON(savedState);
    _status(`state loaded @ frame ${frameCount}`);
  } catch (e) { _status('load failed: ' + e.message, true); console.error(e); }
}

// ── OAM snapshot (meta-sprite grouping) ─────────────────────────────────────
// Groups currently-visible sprites into meta-sprites by XY adjacency, so you get
// clean "this monster" / "this weapon" clusters instead of raw OAM noise.

function _snapshotOAM() {
  if (!nes) return;
  const oam = nes.ppu.spriteMem;
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], t = oam[i * 4 + 1], a = oam[i * 4 + 2], x = oam[i * 4 + 3];
    if (y >= 0xF0) continue;
    sprites.push({ i, y: y + 1, t, a, x, group: -1 });
  }
  // Union-find by adjacency: two sprites are in the same group if one's bbox
  // touches the other (≤8px gap in X or Y).
  const groups = [];
  for (const s of sprites) {
    let merged = -1;
    for (let g = 0; g < groups.length; g++) {
      for (const other of groups[g]) {
        const dx = Math.abs(s.x - other.x), dy = Math.abs(s.y - other.y);
        if (dx <= 8 && dy <= 24) { // 16-wide / 24-tall tolerance
          if (merged === -1) { groups[g].push(s); merged = g; }
          else {
            groups[merged].push(...groups[g]);
            groups.splice(g, 1);
            merged = groups.indexOf(groups[merged]);
            g--;
          }
          break;
        }
      }
    }
    if (merged === -1) groups.push([s]);
  }
  const tiles = nes.ppu.ptTile;
  const out = [];
  out.push(`// OAM snapshot @ frame ${frameCount} — ${sprites.length} visible sprites in ${groups.length} groups`);
  out.push('');
  out.push(_dumpPalette());
  out.push('');
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const minX = Math.min(...grp.map(s => s.x));
    const minY = Math.min(...grp.map(s => s.y));
    out.push(`// ── group ${g} (${grp.length} tiles, origin ${minX},${minY}) ──`);
    for (const s of grp) {
      const ptIdx = 256 + s.t;
      const tile = tiles[ptIdx];
      if (!tile || !tile.pix) continue;
      const bytes = _encodeTile(tile.pix);
      const dx = s.x - minX, dy = s.y - minY;
      const flags = (s.a & 0x80 ? ' VFLIP' : '') + (s.a & 0x40 ? ' HFLIP' : '');
      out.push(`//   [${dx},${dy}] tile=$${_hex(s.t, 2)} pal${s.a & 3}${flags}`);
      out.push(`new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`);
    }
    out.push('');
  }
  dom.output.value = out.join('\n');
  _status(`snapshot: ${sprites.length} sprites in ${groups.length} groups`);
}

// ── BG snapshot (nametable + attribute table) ───────────────────────────────
// FF3 draws battle monsters as BG tiles, not OAM sprites. This captures the
// nametable, attribute table, and all non-blank tile patterns so you can see
// which BG palette each monster tile actually uses.

function _snapshotBG() {
  if (!nes) return;
  const v = nes.ppu.vramMem;
  const tiles = nes.ppu.ptTile;
  const out = [];
  out.push(`// BG snapshot @ frame ${frameCount}`);
  out.push('');
  out.push(_dumpPalette());
  out.push('');

  // Nametable 0 at $2000-$23BF (32 cols × 30 rows). Attribute table at $23C0-$23FF.
  // Attribute byte format DDCCBBAA covers a 32×32 px (4×4 tile) area.
  const NT = 0x2000, AT = 0x23C0;
  const getAttr = (col, row) => {
    // 4×4 tile block → attr byte index. 2×2 within that → which 2 bits.
    const blockCol = col >> 2, blockRow = row >> 2;
    const byte = v[AT + blockRow * 8 + blockCol];
    const subCol = (col >> 1) & 1, subRow = (row >> 1) & 1;
    const shift = (subRow << 2) | (subCol << 1);
    return (byte >> shift) & 3;
  };

  // Find the bounding box of non-blank tiles (so we skip empty borders).
  let minR = 30, maxR = -1, minC = 32, maxC = -1;
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 32; c++) {
      const t = v[NT + r * 32 + c];
      if (t !== 0) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  if (maxR < 0) { out.push('// (all tiles blank)'); dom.output.value = out.join('\n'); _status('BG empty'); return; }

  out.push(`// bounding box: cols ${minC}..${maxC}, rows ${minR}..${maxR}`);
  out.push('');

  // ASCII grid: for each non-blank cell show "TT/p" where TT=tile index hex, p=attr palette (0-3)
  out.push('// Grid (non-blank cells shown as TT/p where p=BG palette 0-3):');
  for (let r = minR; r <= maxR; r++) {
    const parts = [`//  r${r.toString().padStart(2, '0')}: `];
    for (let c = minC; c <= maxC; c++) {
      const t = v[NT + r * 32 + c];
      const p = getAttr(c, r);
      parts.push(t === 0 ? '     ' : `${_hex(t, 2)}/${p} `);
    }
    out.push(parts.join(''));
  }
  out.push('');

  // Unique tiles with their raw bytes — so you can match against MONSTER_REGISTRY.raw
  const seen = new Set();
  out.push('// Unique non-blank tile patterns:');
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const t = v[NT + r * 32 + c];
      if (t === 0 || seen.has(t)) continue;
      seen.add(t);
      // BG tiles are at pattern table $0000-$0FFF → ptTile index 0..255.
      // FF3 may swap the BG bank via PPU control reg; assume $0000 for now.
      const tile = tiles[t];
      if (!tile || !tile.pix) continue;
      const bytes = _encodeTile(tile.pix);
      out.push(`// tile $${_hex(t, 2)}`);
      out.push(`new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`);
    }
  }

  dom.output.value = out.join('\n');
  _status(`BG snapshot: ${seen.size} unique tiles in ${maxC - minC + 1}×${maxR - minR + 1} area`);
}

// ── Capture ─────────────────────────────────────────────────────────────────

function _dumpPalette() {
  const v = nes.ppu.vramMem;
  const lines = ['// PPU palette ($3F00-$3F1F)'];
  for (let p = 0; p < 8; p++) {
    const row = [];
    for (let i = 0; i < 4; i++) row.push('0x' + _hex(v[0x3F00 + p * 4 + i], 2));
    lines.push(`//  ${p < 4 ? 'BG' : 'SP'}${p % 4}: [${row.join(', ')}]`);
  }
  return lines.join('\n');
}

function _encodeTile(pix) {
  const out = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let bp0 = 0, bp1 = 0;
    for (let col = 0; col < 8; col++) {
      const v = pix[row * 8 + col] & 3;
      bp0 |= (v & 1) << (7 - col);
      bp1 |= ((v >> 1) & 1) << (7 - col);
    }
    out[row] = bp0;
    out[row + 8] = bp1;
  }
  return out;
}

function _dumpTileByIndex() {
  const raw = dom.tileInput.value.trim();
  if (!raw) { _status('enter a tile index (decimal or $hex)', true); return; }
  const idx = raw.startsWith('$') ? parseInt(raw.slice(1), 16) : parseInt(raw, raw.startsWith('0x') ? 16 : 10);
  if (isNaN(idx) || idx < 0 || idx > 511) { _status('tile index must be 0-511', true); return; }
  const t = nes.ppu.ptTile?.[idx];
  if (!t) { _status('tile not available', true); return; }
  const bytes = _encodeTile(t.pix);
  const label = `tile $${_hex(idx, 3)} @ PPU $${_hex((idx & 0xFF) * 16 + (idx >= 256 ? 0x1000 : 0), 4)}`;
  dom.output.value = `// ${label} (captured @ frame ${frameCount})\nnew Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`;
}

// ── Weapon tile dump ────────────────────────────────────────────────────────
// FF3 battle animations decompress the active weapon's CHR into PPU $1490-$15A0
// (tiles $49-$5A, sprite bank). Pause mid-swing then hit this button — we pull
// the tiles straight from jsnes's decoded pattern table, whatever the current
// CHR bank happens to be.
function _dumpWeaponTiles() {
  if (!nes) return;
  const tiles = nes.ppu.ptTile;
  if (!tiles) { _status('pattern table not ready', true); return; }
  const START = 256 + 0x49; // PPU $1490
  const END = 256 + 0x60;   // PPU $1600
  const out = [];
  out.push(`// Weapon tiles @ frame ${frameCount} (pause mid-swing for clean data)`);
  out.push('');
  out.push(_dumpPalette());
  out.push('');
  for (let i = START; i < END; i++) {
    const t = tiles[i];
    if (!t || !t.pix) continue;
    const bytes = _encodeTile(t.pix);
    const ppu = 0x1000 + (i - 256) * 16;
    out.push(`// tile $${_hex(i - 256, 2)} @ PPU $${_hex(ppu, 4)}`);
    out.push(`new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`);
  }
  dom.output.value = out.join('\n');
  _status(`dumped ${END - START} weapon tiles @ frame ${frameCount}`);
}

// ── Memory read/write (FF3 party + inventory) ───────────────────────────────
// FF3J save RAM layout (relative to $6000 SRAM base):
//   $6100: Character A × 4 (64 bytes each) — job, level, name, HP, MP, stats
//   $6200: Character B × 4 (64 bytes each) — equipment (head/body/arms/wpn/shield) + magic
//   $60C0: Inventory item IDs × 32
//   $60E0: Inventory quantities × 32
// During gameplay the game operates on this SRAM directly via MMC3 PRG-RAM mapping.
const SRAM_BASE = 0x6000;
const CHARS_A_OFF = 0x100;
const CHARS_B_OFF = 0x200;
const INV_IDS_OFF = 0x0C0;
const INV_QTY_OFF = 0x0E0;

function _ram(addr) { return nes?.cpu?.mem?.[addr] ?? 0; }
function _ramWrite(addr, val) {
  if (!nes?.cpu) return;
  nes.cpu.mem[addr] = val & 0xFF;
}

function _dumpState() {
  if (!nes) return;
  const out = [];
  out.push(`// Party + inventory @ frame ${frameCount}`);
  out.push('');
  for (let i = 0; i < 4; i++) {
    const a = SRAM_BASE + CHARS_A_OFF + i * 0x40;
    const b = SRAM_BASE + CHARS_B_OFF + i * 0x40;
    const job = _ram(a + 0x00);
    const lvl = _ram(a + 0x01);
    const name = Array.from({length:6}, (_,k) => _ram(a + 0x06 + k).toString(16).padStart(2,'0')).join(' ');
    const curHP = _ram(a + 0x0C) | (_ram(a + 0x0D) << 8);
    const maxHP = _ram(a + 0x0E) | (_ram(a + 0x0F) << 8);
    const equip = Array.from({length:7}, (_,k) => '$' + _hex(_ram(b + k), 2)).join(' ');
    out.push(`// char${i} @ A:$${_hex(a,4)} B:$${_hex(b,4)}`);
    out.push(`//   job=$${_hex(job,2)} lvl=${lvl} name=${name}`);
    out.push(`//   HP=${curHP}/${maxHP}`);
    out.push(`//   equip (head/body/arms/wpn/shld…): ${equip}`);
    out.push('');
  }
  out.push('// Inventory (32 slots)');
  for (let i = 0; i < 32; i++) {
    const id = _ram(SRAM_BASE + INV_IDS_OFF + i);
    const qty = _ram(SRAM_BASE + INV_QTY_OFF + i);
    if (id === 0 && qty === 0) continue;
    out.push(`//   [${String(i).padStart(2)}] id=$${_hex(id,2)} qty=${qty}`);
  }
  dom.output.value = out.join('\n');
  _status(`state dumped @ frame ${frameCount}`);
}

// Accepts multi-line input like:
//   $6100=01      — single byte
//   $6100: 01 02 03 04   — block write
//   6100=ff,6200=aa      — comma-separated
// Returns number of bytes written, or throws on parse error.
function _applyWrites() {
  if (!nes) return;
  const text = dom.writeInput.value.trim();
  if (!text) { _status('nothing to write', true); return; }
  const edits = [];
  // split on newlines + commas + semicolons
  const entries = text.split(/[\n,;]/).map(s => s.trim()).filter(Boolean);
  for (const e of entries) {
    // strip // comments
    const stripped = e.replace(/\/\/.*$/, '').trim();
    if (!stripped) continue;
    // allow "$ADDR=VAL" or "$ADDR: VAL VAL VAL"
    const m = stripped.match(/^\$?([0-9a-fA-F]+)\s*[:=]\s*(.+)$/);
    if (!m) { _status(`bad edit: ${e}`, true); return; }
    const addr = parseInt(m[1], 16);
    const vals = m[2].trim().split(/\s+/).map(v => parseInt(v.replace(/^0x|^\$/, ''), 16));
    if (vals.some(v => !Number.isFinite(v))) { _status(`bad value: ${e}`, true); return; }
    for (let k = 0; k < vals.length; k++) edits.push([addr + k, vals[k]]);
  }
  for (const [a, v] of edits) _ramWrite(a, v);
  _status(`wrote ${edits.length} bytes`);
}

// Preset helpers — quick scratch writes. Both only touch SRAM, so if the game
// caches values at battle start these won't take effect mid-battle.
const PRESETS = {
  'full-HP': () => {
    for (let i = 0; i < 4; i++) {
      const a = SRAM_BASE + CHARS_A_OFF + i * 0x40;
      const maxL = _ram(a + 0x0E), maxH = _ram(a + 0x0F);
      _ramWrite(a + 0x0C, maxL); _ramWrite(a + 0x0D, maxH);
    }
    return 'all HP → max';
  },
  'clear-inv': () => {
    for (let i = 0; i < 32; i++) {
      _ramWrite(SRAM_BASE + INV_IDS_OFF + i, 0);
      _ramWrite(SRAM_BASE + INV_QTY_OFF + i, 0);
    }
    return 'inventory cleared';
  },
};

function _runPreset(name) {
  if (!nes) return;
  const fn = PRESETS[name];
  if (!fn) return;
  try { _status(fn()); } catch (e) { _status('preset failed: ' + e.message, true); console.error(e); }
}

function _hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// ── Input ───────────────────────────────────────────────────────────────────

function _press(btn) { if (nes) nes.buttonDown(1, btn); }
function _release(btn) { if (nes) nes.buttonUp(1, btn); }

function _installKeys() {
  const pressed = new Set();
  // Don't steal keys while the user is typing in the write-bytes / tile-index inputs.
  const isTyping = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  dom._keyDown = (e) => {
    if (isTyping(e)) return;
    const btn = KEY_MAP[e.key];
    if (btn === undefined) return;
    if (!pressed.has(btn)) { _press(btn); pressed.add(btn); }
    e.preventDefault(); e.stopImmediatePropagation();
  };
  dom._keyUp = (e) => {
    if (isTyping(e)) return;
    const btn = KEY_MAP[e.key];
    if (btn === undefined) return;
    if (pressed.has(btn)) { _release(btn); pressed.delete(btn); }
    e.preventDefault(); e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', dom._keyDown, true);
  window.addEventListener('keyup', dom._keyUp, true);
}

function _bindButton(el, btn) {
  const press = (e) => { e?.preventDefault?.(); _press(btn); el.style.background = '#3a3a50'; };
  const rel = (e) => { e?.preventDefault?.(); _release(btn); el.style.background = '#1e1e2e'; };
  el.addEventListener('mousedown', press);
  el.addEventListener('mouseup', rel);
  el.addEventListener('mouseleave', rel);
  el.addEventListener('touchstart', press, { passive: false });
  el.addEventListener('touchend', rel, { passive: false });
  el.addEventListener('touchcancel', rel, { passive: false });
}

// ── DOM ─────────────────────────────────────────────────────────────────────

function _buildDOM(parent) {
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;overflow:auto;';

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap;';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.cssText = 'background:#000;display:inline-block;flex-shrink:0;border:1px solid #333;';
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W; canvas.height = SCREEN_H;
  canvas.style.cssText = `width:min(${SCREEN_W}px,70vw);height:auto;aspect-ratio:${SCREEN_W}/${SCREEN_H};image-rendering:pixelated;display:block;`;
  canvasWrap.appendChild(canvas);
  top.appendChild(canvasWrap);

  const rightCol = document.createElement('div');
  rightCol.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;min-width:220px;';

  // Status row: persistent message + live frame counter. Counter updates every frame,
  // but never overwrites the message text — that was the old bug.
  const statusRow = document.createElement('div');
  statusRow.style.cssText = 'display:flex;gap:4px;align-items:stretch;';
  const status = document.createElement('div');
  status.style.cssText = 'flex:1;min-width:0;color:#c8a832;font-size:10px;padding:5px 8px;background:#1e1e2e;border:1px solid #444;border-radius:3px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  status.textContent = 'initializing...';
  const frame = document.createElement('div');
  frame.style.cssText = 'color:#888;font-size:10px;padding:5px 8px;background:#1e1e2e;border:1px solid #444;border-radius:3px;font-family:monospace;min-width:60px;text-align:right;';
  frame.textContent = 'f0';
  statusRow.append(status, frame);
  rightCol.appendChild(statusRow);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-family:monospace;font-size:11px;cursor:pointer;white-space:nowrap;';
    b.addEventListener('click', onClick);
    return b;
  };
  const btnPause = mkBtn('PAUSE', _togglePause);
  const btnStep = mkBtn('STEP', _step);
  const btnReset = mkBtn('RESET', _reset);
  const btnSound = mkBtn('SOUND', _toggleSound);
  btnRow.append(btnPause, btnStep, btnReset, btnSound);
  rightCol.appendChild(btnRow);

  // Capture row: savestate + the two actual capture tools.
  const capRow = document.createElement('div');
  capRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const btnSave = mkBtn('SAVE', _saveState);
  const btnLoad = mkBtn('LOAD', _loadState);
  const btnSnap = mkBtn('SNAP OAM', _snapshotOAM);
  const btnSnapBG = mkBtn('SNAP BG', _snapshotBG);
  const btnWpn = mkBtn('WPN TILES', _dumpWeaponTiles);
  capRow.append(btnSave, btnLoad, btnSnap, btnSnapBG, btnWpn);
  rightCol.appendChild(capRow);

  // Tile dump input
  const tileRow = document.createElement('div');
  tileRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const tileLabel = document.createElement('span');
  tileLabel.textContent = 'Tile:';
  tileLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const tileInput = document.createElement('input');
  tileInput.placeholder = '0-511 or $xxx';
  tileInput.style.cssText = 'flex:1;min-width:0;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const btnTileDump = mkBtn('DUMP', _dumpTileByIndex);
  tileRow.append(tileLabel, tileInput, btnTileDump);
  rightCol.appendChild(tileRow);

  // Controller pad
  const pad = _buildPad();
  rightCol.appendChild(pad);

  const legend = document.createElement('div');
  legend.style.cssText = 'color:#666;font-size:10px;font-family:monospace;line-height:1.5;';
  legend.innerHTML = 'Keys: <b>WASD</b>/arrows dpad · <b>K</b> A · <b>J</b> B · <b>/</b> Start · <b>.</b> Select';
  rightCol.appendChild(legend);

  top.appendChild(rightCol);
  root.appendChild(top);

  const output = document.createElement('textarea');
  output.readOnly = true;
  output.placeholder = 'CAPTURE output goes here. Paste into src/data/job-sprites.js etc.';
  output.style.cssText = 'flex:1;min-height:140px;background:#0f0f18;color:#ccc;font-family:monospace;font-size:10px;border:1px solid #333;border-radius:3px;padding:6px;resize:vertical;';
  root.appendChild(output);

  // Memory edit panel (party + inventory)
  const editPanel = document.createElement('details');
  editPanel.style.cssText = 'border:1px solid #333;border-radius:3px;background:#141420;padding:6px;';
  const summary = document.createElement('summary');
  summary.textContent = 'PARTY / INVENTORY EDITOR';
  summary.style.cssText = 'cursor:pointer;color:#c8a832;font-size:11px;font-family:monospace;user-select:none;';
  editPanel.appendChild(summary);

  const editBody = document.createElement('div');
  editBody.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px;';

  const editBtnRow = document.createElement('div');
  editBtnRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  const btnDumpState = mkBtn('READ STATE', _dumpState);
  const btnFullHP = mkBtn('FULL HP', () => _runPreset('full-HP'));
  const btnClearInv = mkBtn('CLEAR INV', () => _runPreset('clear-inv'));
  editBtnRow.append(btnDumpState, btnFullHP, btnClearInv);
  editBody.appendChild(editBtnRow);

  const writeInput = document.createElement('textarea');
  writeInput.placeholder = 'write bytes — e.g. $6100=01  or  $6240: 1E 62 72 00';
  writeInput.style.cssText = 'min-height:48px;background:#0f0f18;color:#ccc;font-family:monospace;font-size:11px;border:1px solid #333;border-radius:3px;padding:6px;resize:vertical;';
  editBody.appendChild(writeInput);

  const btnApplyWrites = mkBtn('APPLY WRITES', _applyWrites);
  btnApplyWrites.style.alignSelf = 'flex-start';
  editBody.appendChild(btnApplyWrites);

  editPanel.appendChild(editBody);
  root.appendChild(editPanel);

  parent.appendChild(root);

  const d = { root, canvas, status, frame, btnPause, btnStep, btnReset, btnSound, btnSave, btnLoad, btnSnap, btnSnapBG, btnWpn, tileInput, btnTileDump, output, writeInput };
  dom = d;
  _installKeys();
  return d;
}

function _buildPad() {
  const pad = document.createElement('div');
  pad.style.cssText = 'display:flex;gap:20px;align-items:center;';

  const dpad = document.createElement('div');
  dpad.style.cssText = 'display:grid;grid-template-columns:repeat(3,34px);grid-template-rows:repeat(3,34px);gap:2px;';
  const padBtnCss = 'background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;';
  const _ = () => { const e = document.createElement('div'); e.style.visibility = 'hidden'; return e; };
  const up = document.createElement('button'); up.textContent = '▲'; up.style.cssText = padBtnCss;
  const dn = document.createElement('button'); dn.textContent = '▼'; dn.style.cssText = padBtnCss;
  const lf = document.createElement('button'); lf.textContent = '◀'; lf.style.cssText = padBtnCss;
  const rt = document.createElement('button'); rt.textContent = '▶'; rt.style.cssText = padBtnCss;
  dpad.append(_(), up, _(), lf, _(), rt, _(), dn, _());
  _bindButton(up, BTN.UP);
  _bindButton(dn, BTN.DOWN);
  _bindButton(lf, BTN.LEFT);
  _bindButton(rt, BTN.RIGHT);
  pad.appendChild(dpad);

  const actCol = document.createElement('div');
  actCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const actRow = document.createElement('div');
  actRow.style.cssText = 'display:flex;gap:4px;';
  const btnB = document.createElement('button'); btnB.textContent = 'B'; btnB.style.cssText = padBtnCss + 'width:40px;height:40px;border-radius:50%;';
  const btnA = document.createElement('button'); btnA.textContent = 'A'; btnA.style.cssText = padBtnCss + 'width:40px;height:40px;border-radius:50%;';
  actRow.append(btnB, btnA);
  _bindButton(btnA, BTN.A);
  _bindButton(btnB, BTN.B);
  const selRow = document.createElement('div');
  selRow.style.cssText = 'display:flex;gap:4px;';
  const btnSel = document.createElement('button'); btnSel.textContent = 'SEL'; btnSel.style.cssText = padBtnCss + 'padding:4px 8px;font-size:10px;';
  const btnStart = document.createElement('button'); btnStart.textContent = 'START'; btnStart.style.cssText = padBtnCss + 'padding:4px 8px;font-size:10px;';
  selRow.append(btnSel, btnStart);
  _bindButton(btnSel, BTN.SELECT);
  _bindButton(btnStart, BTN.START);
  actCol.append(actRow, selRow);
  pad.appendChild(actCol);

  return pad;
}
