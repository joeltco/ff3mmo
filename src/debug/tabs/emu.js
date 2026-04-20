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

// Savestate slot (single slot — good enough for sprite capture workflows).
let savedState = null;

// Animation recorder
let recording = false;
let recFrames = [];
let recTarget = 0;

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

  // Probe the platform's audio sample rate once so we can tell jsnes to produce samples
  // at exactly that rate — no resampling needed.
  const sampleRate = _probeSampleRate();
  try {
    nes = new window.jsnes.NES({
      onFrame: _onFrame,
      onAudioSample: _onAudioSample,
      onStatusUpdate: (s) => { console.log('[jsnes]', s); _status('jsnes: ' + s); },
      onBatteryRamWrite: () => {},
      sampleRate,
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
  if (recording) _captureRecFrame();
  if (dom?.status) {
    const rec = recording ? ` · REC ${recFrames.length}/${recTarget}` : '';
    dom.status.textContent = (running ? `frame ${frameCount}` : `paused @ frame ${frameCount}`) + rec;
  }
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

function _probeSampleRate() {
  try {
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const r = tmp.sampleRate;
    tmp.close?.();
    return r;
  } catch { return 44100; }
}

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

function _saveState() {
  if (!nes) return;
  try {
    savedState = JSON.parse(JSON.stringify(nes.toJSON()));
    _status(`state saved @ frame ${frameCount}`);
  } catch (e) { _status('save failed: ' + e.message, true); console.error(e); }
}

function _loadState() {
  if (!nes || !savedState) { _status('no saved state', true); return; }
  try {
    nes.fromJSON(savedState);
    _status(`state loaded`);
  } catch (e) { _status('load failed: ' + e.message, true); console.error(e); }
}

// ── Animation recorder ──────────────────────────────────────────────────────
// Records OAM + palette + pattern table each frame for N frames, then emits a
// deduped animation dump — each unique tile appears once, each frame lists which
// OAM entries + tile-ids it references.

function _toggleRec() {
  if (recording) { _stopRec(); return; }
  const raw = dom.recInput.value.trim();
  const n = parseInt(raw || '60', 10);
  if (!Number.isFinite(n) || n <= 0 || n > 600) { _status('record count 1–600', true); return; }
  recFrames = [];
  recTarget = n;
  recording = true;
  dom.btnRec.textContent = 'STOP';
  _status(`recording ${n} frames…`);
}

function _captureRecFrame() {
  if (!nes) return;
  const oam = nes.ppu.spriteMem;
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], t = oam[i * 4 + 1], a = oam[i * 4 + 2], x = oam[i * 4 + 3];
    if (y >= 0xF0) continue;
    sprites.push({ i, y, t, a, x });
  }
  recFrames.push({ frame: frameCount, sprites });
  if (recFrames.length >= recTarget) _stopRec();
}

function _stopRec() {
  recording = false;
  dom.btnRec.textContent = 'REC';
  if (recFrames.length === 0) { _status('no frames recorded', true); return; }
  // Collect every unique tile index referenced across all frames.
  const tileIds = new Set();
  for (const f of recFrames) for (const s of f.sprites) tileIds.add(s.t);
  const out = [];
  out.push(`// Animation: ${recFrames.length} frames, ${tileIds.size} unique tiles`);
  out.push('');
  out.push(_dumpPalette());
  out.push('');
  out.push('// Tiles referenced by OAM during recording');
  const tiles = nes.ppu.ptTile;
  const sorted = Array.from(tileIds).sort((a, b) => a - b);
  for (const idx of sorted) {
    // Sprite tile addressing depends on PPU control reg bit — FF3 uses $1000 for
    // battle sprites. jsnes ptTile is indexed 0–511; OAM tile id + bank offset.
    const ptIdx = 256 + idx; // assume $1000 bank; raw tile bytes re-encoded
    const t = tiles[ptIdx];
    if (!t || !t.pix) continue;
    const bytes = _encodeTile(t.pix);
    out.push(`// tile $${_hex(idx, 2)}: new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]),`);
  }
  out.push('');
  out.push('// Per-frame OAM (i=slot, y, tile, attr, x)');
  for (const f of recFrames) {
    const s = f.sprites.map(sp => `{i:${sp.i},y:${sp.y},t:0x${_hex(sp.t, 2)},a:0x${_hex(sp.a, 2)},x:${sp.x}}`).join(',');
    out.push(`// f${f.frame}: [${s}]`);
  }
  dom.output.value = out.join('\n');
  _status(`recorded ${recFrames.length} frames, ${tileIds.size} unique tiles`);
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

// ── Capture ─────────────────────────────────────────────────────────────────

function _capture() {
  if (!nes) return;
  const wasRunning = running;
  if (running) _stop();
  const out = [];
  out.push(`// Capture at frame ${frameCount}`);
  out.push('');
  out.push(_dumpOAM());
  out.push('');
  out.push(_dumpPalette());
  out.push('');
  out.push('// Sprite pattern table at PPU $1000 — 256 tiles, raw 2BPP bytes');
  out.push(_dumpPatternTable(256, 256)); // tiles 256-511 = $1000-$1FFF
  dom.output.value = out.join('\n');
  if (wasRunning) _start();
}

function _dumpOAM() {
  const oam = nes.ppu.spriteMem; // 256 bytes
  const lines = ['// OAM (64 sprites: Y, tile, attr, X)'];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], t = oam[i * 4 + 1], a = oam[i * 4 + 2], x = oam[i * 4 + 3];
    if (y >= 0xF0) continue; // hidden
    lines.push(`//  [${String(i).padStart(2)}] y=${String(y).padStart(3)}  tile=$${_hex(t, 2)}  attr=$${_hex(a, 2)}  x=${String(x).padStart(3)}  pal${(a & 3)}${(a & 0x80) ? ' VFLIP' : ''}${(a & 0x40) ? ' HFLIP' : ''}`);
  }
  return lines.join('\n');
}

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

function _dumpPatternTable(startTile, count) {
  // jsnes decodes pattern tables into nes.ppu.ptTile[] (512 tiles).
  // We re-encode each to raw 2BPP (16 bytes per tile).
  const tiles = nes.ppu.ptTile;
  if (!tiles) return '// pattern table not available';
  const lines = [];
  for (let i = 0; i < count; i++) {
    const idx = startTile + i;
    const t = tiles[idx];
    if (!t || !t.pix) continue;
    const bytes = _encodeTile(t.pix);
    const label = `tile $${_hex(idx, 3)} (PPU $${_hex((idx & 0xFF) * 16 + (idx >= 256 ? 0x1000 : 0), 4)})`;
    lines.push(`new Uint8Array([${Array.from(bytes).map(b => '0x' + _hex(b, 2)).join(',')}]), // ${label}`);
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

function _hex(n, width) {
  return n.toString(16).toUpperCase().padStart(width, '0');
}

// ── Input ───────────────────────────────────────────────────────────────────

function _press(btn) { if (nes) nes.buttonDown(1, btn); }
function _release(btn) { if (nes) nes.buttonUp(1, btn); }

function _installKeys() {
  const pressed = new Set();
  dom._keyDown = (e) => {
    const btn = KEY_MAP[e.key];
    if (btn === undefined) return;
    if (!pressed.has(btn)) { _press(btn); pressed.add(btn); }
    e.preventDefault(); e.stopImmediatePropagation();
  };
  dom._keyUp = (e) => {
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

  const status = document.createElement('div');
  status.style.cssText = 'color:#c8a832;font-size:10px;padding:5px 8px;background:#1e1e2e;border:1px solid #444;border-radius:3px;font-family:monospace;';
  status.textContent = 'initializing...';
  rightCol.appendChild(status);

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

  // Capture row: savestate, snapshot, record, raw dump
  const capRow = document.createElement('div');
  capRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const btnSave = mkBtn('SAVE', _saveState);
  const btnLoad = mkBtn('LOAD', _loadState);
  const btnSnap = mkBtn('SNAP OAM', _snapshotOAM);
  const btnRec = mkBtn('REC', _toggleRec);
  const recInput = document.createElement('input');
  recInput.value = '60';
  recInput.title = 'frames to record';
  recInput.style.cssText = 'width:48px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const btnCapture = mkBtn('DUMP ALL', _capture);
  capRow.append(btnSave, btnLoad, btnSnap, btnRec, recInput, btnCapture);
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

  parent.appendChild(root);

  const d = { root, canvas, status, btnPause, btnStep, btnReset, btnSound, btnSave, btnLoad, btnSnap, btnRec, recInput, btnCapture, tileInput, btnTileDump, output };
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
