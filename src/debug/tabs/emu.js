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
// Which ROM the emulator is currently running. 'ff3' applies the English
// IPS patch on init; 'ff12' boots the raw FF1&2 buffer (no patch). Used
// for capturing FF1 shopkeeper / NPC sprites that don't ship with FF3.
let currentRom = 'ff3';

// Savestate slots — persisted to localStorage so they survive refreshes.
// Four numbered slots; SAVE/LOAD always act on the currently-selected slot.
//
// IMPORTANT: slots store the savestate as a JSON *string*, not a parsed object.
// jsnes' fromJSON does `target[prop] = source[prop]` (raw ref assignment, no
// copy), so the saved object's inner arrays alias the running NES's arrays —
// every CPU/PPU mutation between two LOADs silently rewrites the savestate.
// Parsing fresh on each LOAD decouples the saved state from the running emu.
const SAVESTATE_VERSION = 'v1';
const SLOT_COUNT = 4;
const SAVESTATE_LEGACY_KEY = 'ff3_emu_savestate_v1';
const _slotKey = (i) => `ff3_emu_savestate_slot_${i}_${SAVESTATE_VERSION}`;
let savedStates = new Array(SLOT_COUNT).fill(null);  // JSON string or null
let slotFrames = new Array(SLOT_COUNT).fill(null);   // cached frame # for status display
let selectedSlot = 0;
function _readSlotFrame(json) {
  if (!json) return null;
  // Cheap regex peek; avoids a full JSON.parse just to populate slot button labels.
  const m = json.match(/"frame":(\d+)/);
  return m ? Number(m[1]) : null;
}
try {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const stored = localStorage.getItem(_slotKey(i));
    if (stored) {
      savedStates[i] = stored;
      slotFrames[i] = _readSlotFrame(stored);
    }
  }
  // Migrate the pre-1.6.97 single-slot key into slot 0 if slot 0 is otherwise empty.
  if (!savedStates[0]) {
    const legacy = localStorage.getItem(SAVESTATE_LEGACY_KEY);
    if (legacy) {
      savedStates[0] = legacy;
      slotFrames[0] = _readSlotFrame(legacy);
      try {
        localStorage.setItem(_slotKey(0), legacy);
        localStorage.removeItem(SAVESTATE_LEGACY_KEY);
      } catch { /* keep in-memory only */ }
    }
  }
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
  // Always boot into FF3 first — that's the project's primary ROM.
  // The ROM-toggle row in the UI lets the user swap to FF1&2 mid-session.
  currentRom = 'ff3';
  _refreshRomButtons();
  const rom = ctx.getFF3Buffer();
  if (!rom) { _status('No ROM loaded — load FF3 on the title screen first', true); return; }

  _patchAndInit(rom, 'ff3');
}

// Swap the running emulator to the other ROM. No-op if already there or
// if the requested ROM hasn't been loaded yet (FF1&2 is optional —
// users only need it for FF1-derived sprite/music captures).
function _switchRom(target) {
  if (target === currentRom) return;
  if (target !== 'ff3' && target !== 'ff12') return;
  const rom = target === 'ff12' ? ctx.getFF12Buffer() : ctx.getFF3Buffer();
  if (!rom) {
    const label = target === 'ff12' ? 'FF1&2' : 'FF3';
    _status(`No ${label} ROM loaded — drop one on the title screen first`, true);
    return;
  }
  _stop();
  // Hand the old NES instance to GC; _initEmulator builds a fresh one.
  // Savestate slots are NOT cleared — they're shaped for the previous ROM,
  // so a LOAD after a ROM swap will fail loudly (jsnes guard) rather than
  // silently corrupt; that's the right trade for a debug tool.
  nes = null;
  frameCount = 0;
  if (dom?.frame) dom.frame.textContent = 'f0';
  currentRom = target;
  _refreshRomButtons();
  _patchAndInit(rom, target);
}

// Highlight the active ROM button gold; dim the other.
function _refreshRomButtons() {
  if (!dom?.btnRomFF3 || !dom?.btnRomFF12) return;
  for (const [id, btn] of [['ff3', dom.btnRomFF3], ['ff12', dom.btnRomFF12]]) {
    const active = id === currentRom;
    btn.style.borderColor = active ? '#c8a832' : '#444';
    btn.style.color = active ? '#c8a832' : '#888';
  }
}

async function _patchAndInit(romBuffer, romType) {
  const patched = new Uint8Array(new Uint8Array(romBuffer));
  // Only FF3 needs the English IPS — FF1&2 boots raw.
  if (romType === 'ff3') {
    // IPS is overwrite-only, so re-applying to an already-patched buffer is a no-op.
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
  } else {
    _status('booting FF1&2 raw ROM…');
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
      onBatteryRamWrite: _onBatteryRamWriteSfx,
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
    dom.btnSound.style.borderColor = '#3a8a3a';
    dom.btnSound.style.color = '#7ec27e';
  } else {
    audioMuted = true;
    if (audioCtx?.state === 'running') audioCtx.suspend();
    dom.btnSound.textContent = 'SOUND';
    dom.btnSound.style.borderColor = '#444';
    dom.btnSound.style.color = '#c8a832';
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

// ── Output helpers (copy / save / flash) ────────────────────────────────────

async function _copyOutput() {
  if (!dom?.output) return;
  const text = dom.output.value;
  if (!text) { _status('output is empty', true); return; }
  // Modern path — fails on non-secure contexts and some mobile WebViews.
  try {
    await navigator.clipboard.writeText(text);
    _flashButton(dom.btnCopy, 'COPIED ✓', 800);
    _status(`copied ${text.length} chars`);
    return;
  } catch { /* fall through */ }
  // Legacy fallback — select + execCommand.
  try {
    dom.output.select();
    dom.output.setSelectionRange(0, text.length);
    document.execCommand('copy');
    dom.output.setSelectionRange(0, 0);
    _flashButton(dom.btnCopy, 'COPIED ✓', 800);
    _status(`copied ${text.length} chars (legacy)`);
  } catch (e) {
    _status('copy failed: ' + e.message, true);
  }
}

function _saveOutputFile() {
  if (!dom?.output) return;
  const text = dom.output.value;
  if (!text) { _status('output is empty', true); return; }
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `emu-snap-f${frameCount}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  _status(`saved emu-snap-f${frameCount}.txt`);
}

function _flashButton(btn, label, ms) {
  if (!btn) return;
  const orig = btn.dataset.origLabel || btn.textContent;
  btn.dataset.origLabel = orig;
  btn.textContent = label;
  setTimeout(() => {
    if (btn.textContent === label) btn.textContent = orig;
  }, ms);
}

// Pauses the emulator for the duration of fn() so PPU/OAM/VRAM reads can't be
// torn by a frame tick mid-walk. Resumes only if it was running before.
function _withPause(fn) {
  if (!nes) return;
  const wasRunning = running;
  if (wasRunning) _stop();
  try { fn(); } finally { if (wasRunning) _start(); }
}

// ── Savestate ───────────────────────────────────────────────────────────────

// jsnes.toJSON() includes the full ROM (~256KB → ~1MB as JSON) which blows
// through localStorage quota on mobile. Strip it before persisting, re-attach
// on load — the ROM is available from nes.romData anyway.
//
// Slots are stored as JSON strings (not parsed objects) to avoid jsnes'
// fromJSON aliasing — see SAVESTATE block at the top of the file.
function _saveState() {
  if (!nes) return;
  const slot = selectedSlot;
  try {
    const full = nes.toJSON();
    full.romData = null;
    full.frame = frameCount;
    let json;
    try { json = JSON.stringify(full); }
    catch (e) { _status('save serialization failed: ' + e.message, true); return; }
    savedStates[slot] = json;
    slotFrames[slot] = frameCount;
    try {
      localStorage.setItem(_slotKey(slot), json);
      const kb = Math.round(json.length / 1024);
      _status(`S${slot + 1}: saved @ frame ${frameCount} (${kb} KB)`);
    } catch (e) {
      console.warn('[emu] localStorage save failed', e);
      _status(`S${slot + 1}: saved @ frame ${frameCount} (in-memory only — ${e.message})`, true);
    }
    _refreshSlotButtons();
  } catch (e) { _status('save failed: ' + e.message, true); console.error(e); }
}

function _loadState() {
  if (!nes) return;
  const slot = selectedSlot;
  const json = savedStates[slot];
  if (!json) { _status(`S${slot + 1}: empty`, true); return; }
  try {
    // Parse a fresh copy on every LOAD — see savestate-aliasing comment above.
    const state = JSON.parse(json);
    if (!state.romData && nes.romData) state.romData = nes.romData;
    nes.fromJSON(state);
    const frameLabel = state.frame != null ? ` (@ f${state.frame})` : '';
    _status(`S${slot + 1}: loaded${frameLabel}`);
  } catch (e) { _status('load failed: ' + e.message, true); console.error(e); }
}

function _selectSlot(i) {
  if (i < 0 || i >= SLOT_COUNT) return;
  selectedSlot = i;
  _refreshSlotButtons();
  const populated = !!savedStates[i];
  const frame = slotFrames[i];
  const tail = !populated ? ' (empty)' : (frame != null ? ` (@ f${frame})` : '');
  _status(`slot ${i + 1} selected${tail}`);
}

function _refreshSlotButtons() {
  if (!dom?.slotButtons) return;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const b = dom.slotButtons[i];
    if (!b) continue;
    const populated = !!savedStates[i];
    const selected = i === selectedSlot;
    b.style.borderColor = selected ? '#c8a832' : '#444';
    b.style.color = populated ? '#7ec27e' : '#c8a832';
    b.style.fontWeight = selected ? 'bold' : 'normal';
    b.textContent = `S${i + 1}${populated ? '•' : ''}`;
  }
}

// ── Scene library ───────────────────────────────────────────────────────────
// Committed savestates in src/debug/scenes/. Index manifest at scenes/index.json
// lists metadata; each scene's full state lives at scenes/<name>.json. See
// src/debug/scenes/README.md for the schema and authoring flow.

const SCENES_INDEX_URL = 'src/debug/scenes/index.json';
const SCENE_NAME_RE = /^[a-z0-9-]+$/;

async function _fetchScenesIndex() {
  try {
    const resp = await fetch(SCENES_INDEX_URL, { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[emu] scenes index fetch failed', e);
    return [];
  }
}

async function _refreshScenesList() {
  if (!dom?.scenesList) return;
  dom.scenesList.innerHTML = '';
  const scenes = await _fetchScenesIndex();
  if (dom.scenesSummary) dom.scenesSummary.textContent = `SCENES (${scenes.length})`;
  if (!scenes.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#888;font-size:11px;padding:6px;font-style:italic;';
    empty.textContent = 'No scenes yet — capture one below.';
    dom.scenesList.appendChild(empty);
    return;
  }
  for (const meta of scenes) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid #222;';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;font-family:monospace;overflow:hidden;';
    const name = document.createElement('div');
    name.textContent = meta.name;
    name.style.cssText = 'color:#c8a832;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    const desc = document.createElement('div');
    desc.textContent = meta.description || '';
    desc.style.cssText = 'color:#888;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    info.append(name, desc);
    const btn = document.createElement('button');
    btn.textContent = 'LOAD';
    btn.style.cssText = 'padding:6px 10px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-family:monospace;font-size:11px;cursor:pointer;flex-shrink:0;min-width:54px;';
    btn.addEventListener('click', () => _loadScene(meta.name));
    row.append(info, btn);
    dom.scenesList.appendChild(row);
  }
}

async function _loadScene(name) {
  if (!nes) return;
  if (!SCENE_NAME_RE.test(name)) { _status(`scene name invalid: ${name}`, true); return; }
  _status(`scene ${name}: fetching…`);
  let scene;
  try {
    const resp = await fetch(`src/debug/scenes/${name}.json`, { cache: 'no-store' });
    if (!resp.ok) { _status(`scene ${name}: HTTP ${resp.status}`, true); return; }
    scene = await resp.json();
  } catch (e) { _status(`scene ${name}: fetch failed — ${e.message}`, true); return; }
  if (!scene?.state) { _status(`scene ${name}: missing state`, true); return; }
  const wasRunning = running;
  if (wasRunning) _stop();
  try {
    // Decouple from the cached scene object — same aliasing reason as savestate slots.
    const state = JSON.parse(JSON.stringify(scene.state));
    if (!state.romData && nes.romData) state.romData = nes.romData;
    nes.fromJSON(state);
    const frameLabel = scene.frame != null ? ` (@ f${scene.frame})` : '';
    _status(`scene ${name}: loaded${frameLabel}`);
  } catch (e) {
    _status(`scene ${name}: apply failed — ${e.message}`, true);
    console.error(e);
  } finally {
    if (wasRunning) _start();
  }
}

function _exportScene() {
  if (!nes) return;
  const name = (dom.sceneNameInput?.value || '').trim();
  const desc = (dom.sceneDescInput?.value || '').trim();
  if (!name) { _status('scene name required', true); dom.sceneNameInput?.focus(); return; }
  if (!SCENE_NAME_RE.test(name)) { _status('name: lowercase letters, digits, hyphens only', true); return; }
  try {
    const full = nes.toJSON();
    full.romData = null;
    const scene = {
      name,
      description: desc,
      captured: new Date().toISOString().slice(0, 10),
      frame: frameCount,
      state: full,
    };
    const json = JSON.stringify(scene, null, 2);
    dom.output.value = json;
    const kb = Math.round(json.length / 1024);
    _status(`scene "${name}" written to output (${kb} KB) — COPY or SAVE FILE to commit`);
  } catch (e) { _status('export failed: ' + e.message, true); console.error(e); }
}

// ── OAM snapshot (meta-sprite grouping) ─────────────────────────────────────
// Groups currently-visible sprites into meta-sprites by XY adjacency, so you get
// clean "this monster" / "this weapon" clusters instead of raw OAM noise.

function _snapshotOAM() {
  if (!nes) return;
  const { text, sprites, groups } = _oamSnapshotText();
  dom.output.value = text;
  _status(`snapshot: ${sprites} sprites in ${groups} groups`);
}

// Pure text builder used by both single-snap and REC OAM loop. Returns text
// plus group/sprite counts so the caller can render a status line.
function _oamSnapshotText() {
  const oam = nes.ppu.spriteMem;
  const sprites = [];
  for (let i = 0; i < 64; i++) {
    const y = oam[i * 4], t = oam[i * 4 + 1], a = oam[i * 4 + 2], x = oam[i * 4 + 3];
    if (y >= 0xF0) continue;
    sprites.push({ i, y: y + 1, t, a, x, group: -1 });
  }
  // Union-find by adjacency: two sprites are in the same group if one's bbox
  // touches the other (≤8px gap in X, ≤24 in Y). Track the merged group by
  // *reference* rather than index — `groups[merged]` after a splice resolves to
  // the wrong element when g < merged.
  const groups = [];
  for (const s of sprites) {
    let mergedGroup = null;
    for (let g = 0; g < groups.length; g++) {
      let touch = false;
      for (const other of groups[g]) {
        const dx = Math.abs(s.x - other.x), dy = Math.abs(s.y - other.y);
        if (dx <= 8 && dy <= 24) { touch = true; break; }
      }
      if (!touch) continue;
      if (mergedGroup === null) {
        groups[g].push(s);
        mergedGroup = groups[g];
      } else {
        mergedGroup.push(...groups[g]);
        groups.splice(g, 1);
        g--;
      }
    }
    if (mergedGroup === null) groups.push([s]);
  }
  const tiles = nes.ppu.ptTile;
  const out = [];
  out.push(`// OAM snapshot @ frame ${frameCount} — ${sprites.length} visible sprites in ${groups.length} groups`);
  out.push('');
  out.push(_dumpPpuctrl());
  out.push('');
  out.push(_dumpSfxStrip());
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
  return { text: out.join('\n'), sprites: sprites.length, groups: groups.length };
}

// ── BG snapshot (nametable + attribute table) ───────────────────────────────
// FF3 draws battle monsters as BG tiles, not OAM sprites. This captures the
// nametable, attribute table, and all non-blank tile patterns so you can see
// which BG palette each monster tile actually uses.

function _snapshotBG() {
  const text = _bgSnapshotText();
  if (text) { dom.output.value = text; _status(`BG snapshot captured`); }
  else _status('BG empty', true);
}

function _bgSnapshotText() {
  if (!nes) return '';
  const v = nes.ppu.vramMem;
  const tiles = nes.ppu.ptTile;
  const out = [];
  out.push(`// BG snapshot @ frame ${frameCount}`);
  out.push('');
  out.push(_dumpPpuctrl());
  out.push('');
  out.push(_dumpSfxStrip());
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
  if (maxR < 0) return '';

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

  return out.join('\n');
}

// ── Multi-frame record (REC OAM / REC BG) ───────────────────────────────────
// Captures OAM/BG across N consecutive frames so animations land in the output
// textarea as one paste-ready block. Drives the emulator manually via nes.frame()
// since the rAF tick is paused for the duration. Tap the active REC button mid-
// run to cancel.

const REC_FRAMES_MIN = 1, REC_FRAMES_MAX = 240;
const REC_GAP_MIN = 1, REC_GAP_MAX = 30;

let recordingActive = false;
let recCancel = false;
// When ON, _recordFrames hashes each snap's text (with the per-frame `@ frame N`
// header normalised away) and emits identical consecutive frames as a single
// `// frames N..M (Mx same as frame N)` divider instead of repeating the tile
// dump. NES holds each anim state 2-4 frames per pose, so a 120-frame cure REC
// shrinks ~60-70%. Per-session toggle; default OFF preserves the per-frame
// paste-ready format the cure-anim work was built on.
let recDedupe = false;

function _toggleDedupe() {
  recDedupe = !recDedupe;
  if (dom?.btnDedupe) {
    dom.btnDedupe.style.borderColor = recDedupe ? '#3a8a3a' : '#444';
    dom.btnDedupe.style.color = recDedupe ? '#7ec27e' : '#c8a832';
    dom.btnDedupe.textContent = recDedupe ? 'DEDUPE✓' : 'DEDUPE';
  }
  _status(`REC DEDUPE: ${recDedupe ? 'ON — collapses identical consecutive frames' : 'OFF'}`);
}

function _toggleRec(kind) {
  if (recordingActive) {
    recCancel = true;
    _status('REC: cancel requested…');
    return;
  }
  if (!nes) return;
  const frames = _clampInt(dom.recFramesInput?.value, 3, REC_FRAMES_MIN, REC_FRAMES_MAX);
  const gap = _clampInt(dom.recGapInput?.value, 1, REC_GAP_MIN, REC_GAP_MAX);
  if (frames == null) { _status(`frames: ${REC_FRAMES_MIN}-${REC_FRAMES_MAX}`, true); return; }
  if (gap == null) { _status(`gap: ${REC_GAP_MIN}-${REC_GAP_MAX}`, true); return; }
  recordingActive = true;
  recCancel = false;
  _recordFrames(kind, frames, gap).finally(() => {
    recordingActive = false;
    recCancel = false;
  });
}

function _clampInt(raw, defaultVal, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultVal;
  if (n < min || n > max) return null;
  return n;
}

async function _recordFrames(kind, count, gap) {
  const wasRunning = running;
  if (wasRunning) _stop();
  const startFrame = frameCount;
  // Clear any pre-REC accumulated SFX writes so the first snap reflects only
  // activity within the capture window.
  _sfxWrites.length = 0;
  // NES NTSC: 60.0988 fps → 16.639 ms/frame. Wall-clock annotations are
  // computed from NES frame deltas (REC drives nes.frame() in a loop, so
  // elapsed time = elapsed frames × 16.639). Emit-time pacing isn't relevant.
  const NES_MS_PER_FRAME = 16.639;
  const blocks = [];
  blocks.push(`// REC ${kind} × ${count} frames @ start f${startFrame}, gap=${gap}${recDedupe ? ', DEDUPE on' : ''}`);
  blocks.push(`// (gap = number of frames advanced between snaps; gap=1 means consecutive)`);
  blocks.push(`// (timing: NES NTSC ~16.639 ms/frame; t≈ relative to start of capture)`);
  blocks.push('');
  const button = (kind === 'OAM') ? dom.btnRecOam : dom.btnRecBg;
  const origLabel = button.textContent;
  // Dedupe state: track the normalised-key of the most recently *emitted*
  // frame, plus its index. When the next snap's key matches, skip the body and
  // emit a `frames N..M (Kx same)` summary on the next distinct frame (or at
  // end-of-run). The `@ frame N` tag gets normalised so it doesn't poison the
  // comparison — every snap header carries that and would always differ.
  let prevKey = null;
  let prevEmittedIdx = -1;
  let emittedCount = 0;
  const flushRunSummary = (runEnd) => {
    if (prevEmittedIdx < 0 || runEnd <= prevEmittedIdx) return;
    const span = runEnd - prevEmittedIdx;
    const spanMs = Math.round(span * gap * NES_MS_PER_FRAME);
    blocks.push(`// ── frames ${prevEmittedIdx + 1}..${runEnd} (${span}× same as frame ${prevEmittedIdx}, span ≈ ${spanMs}ms) ──`);
    blocks.push('');
  };
  try {
    for (let i = 0; i < count; i++) {
      if (recCancel) {
        _status(`REC ${kind}: cancelled at frame ${i}/${count}`);
        break;
      }
      button.textContent = `CANCEL (${i + 1}/${count})`;
      _status(`REC ${kind}: snap ${i + 1}/${count} @ f${frameCount}`);
      const snap = (kind === 'OAM') ? _oamSnapshotText().text : _bgSnapshotText();
      const key = recDedupe ? snap.replace(/@ frame \d+/g, '@ frame ?') : null;

      if (recDedupe && prevKey !== null && key === prevKey) {
        // Repeat — defer; summary lands when the next distinct frame emits or
        // at end-of-loop.
      } else {
        if (recDedupe) flushRunSummary(i - 1);
        const tMs = Math.round((frameCount - startFrame) * NES_MS_PER_FRAME);
        blocks.push(`// ═══ frame ${i} (snap @ f${frameCount}, t≈${tMs}ms) ═══════════════════════════════════════════════`);
        blocks.push('');
        blocks.push(snap || `// (empty ${kind} snap)`);
        blocks.push('');
        prevKey = key;
        prevEmittedIdx = i;
        emittedCount++;
      }
      // Skip the advance after the final snap.
      if (i < count - 1) {
        for (let g = 0; g < gap; g++) {
          if (recCancel) break;
          nes.frame();
          // Yield to the event loop so the UI updates and the cancel tap is responsive.
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }
    if (recDedupe && !recCancel) flushRunSummary(count - 1);
    dom.output.value = blocks.join('\n');
    if (!recCancel) {
      const finalFrame = frameCount;
      const tail = recDedupe ? ` — ${emittedCount}/${count} unique frames` : ` — ${count} frames captured`;
      _status(`REC ${kind}: done${tail} (f${startFrame}..f${finalFrame})`);
    }
  } catch (e) {
    _status(`REC ${kind} failed: ${e.message}`, true);
    console.error('[emu] REC failed', e);
  } finally {
    button.textContent = origLabel;
    if (wasRunning) _start();
  }
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

// PPUCTRL is split into individual flag fields by jsnes rather than mirrored as
// a raw byte. Reassemble for the snapshot header so the OAM/BG bank assumptions
// in this file (sprite tile lookup at $1000, BG tile lookup at $0000, base NT
// at $2000) become visible diagnostics — if FF3 ever runs a magic anim with
// PPUCTRL flipped, the captured banks land here instead of silently misreading.
function _dumpPpuctrl() {
  if (!nes?.ppu) return '// PPU layout: (ppu not ready)';
  const p = nes.ppu;
  const ntBase = 0x2000 + (p.f_nTblAddress | 0) * 0x400;
  const spSize = p.f_spriteSize ? '8x16' : '8x8';
  const spBank = p.f_spPatternTable ? 0x1000 : 0x0000;
  const bgBank = p.f_bgPatternTable ? 0x1000 : 0x0000;
  const lines = [];
  lines.push('// PPU layout @ capture');
  lines.push(`//   sprite size : ${spSize}`);
  lines.push(`//   sprite bank : $${_hex(spBank, 4)}  (snapshot reads from $1000)`);
  lines.push(`//   BG bank     : $${_hex(bgBank, 4)}  (snapshot reads from $0000)`);
  lines.push(`//   base NT     : $${_hex(ntBase, 4)}  (snapshot reads NT 0)`);
  return lines.join('\n');
}

// FF3J's sound engine uses RAM $7F49 as the SFX request register: ROM writes
// `0x80 | sfxId` to fire a SFX, `0xFF` to cut. NSF track our music.js uses =
// ROM byte − 0x3F.
//
// IMPORTANT: snap-time polling of `nes.cpu.mem[$7F49]` is NOT sufficient. The
// audio engine consumes the high-bit pulse within the same NES frame that
// it's written, so a frame-boundary snapshot only ever sees the post-consume
// residual (e.g. $40 after Fire's $C0 → consumed). To distinguish per-spell
// SFX, the EMU intercepts every CPU write to $7F48-$7F4F via jsnes'
// `onBatteryRamWrite` hook and queues the (addr,val) pair in `_sfxWrites`.
// Each snap drains the queue into the dump output, so a fresh `$Cx → NSF $xx`
// line appears even when the residual byte never shows the high bit set.
const SFX_REQ_BASE = 0x7F48;
const SFX_REQ_LEN  = 8;
let _sfxWrites = []; // {addr, val} accumulated since last snap

function _onBatteryRamWriteSfx(addr, val) {
  if (addr >= SFX_REQ_BASE && addr < SFX_REQ_BASE + SFX_REQ_LEN) {
    _sfxWrites.push({ addr: addr | 0, val: val & 0xFF });
  }
}

function _dumpSfxStrip() {
  if (!nes?.cpu?.mem) return '// SFX request strip: (cpu not ready)';
  const lines = [];
  lines.push(`// SFX request strip $${_hex(SFX_REQ_BASE, 4)}-$${_hex(SFX_REQ_BASE + SFX_REQ_LEN - 1, 4)} (FF3J: $7F49 = SFX queue)`);

  // Drain CPU writes to $7F48-$7F4F captured since last snap. These are the
  // pre-consume values, which the polled-residual loop below cannot see.
  if (_sfxWrites.length > 0) {
    for (const w of _sfxWrites) {
      let note = '';
      if (w.addr === 0x7F49) {
        if (w.val === 0xFF) note = '  (cut SFX)';
        else if (w.val >= 0x80) note = `  -> NSF track $${_hex(w.val - 0x3F, 2)} (music.js)`;
      }
      lines.push(`//   write $${_hex(w.addr, 4)} = $${_hex(w.val, 2)}${note}`);
    }
    _sfxWrites.length = 0;
  } else {
    lines.push(`//   (no CPU writes to $7F48-$7F4F since last snap)`);
  }

  for (let i = 0; i < SFX_REQ_LEN; i++) {
    const a = SFX_REQ_BASE + i;
    const v = nes.cpu.mem[a] | 0;
    let note = '';
    if (a === 0x7F49) {
      if (v === 0x00) note = '  (idle)';
      else if (v === 0xFF) note = '  (cut SFX)';
      else if (v >= 0x80) note = `  -> NSF track $${_hex(v - 0x3F, 2)} (music.js)`;
      else note = '  (raw — high bit not set; see write log above for the fresh request)';
    }
    lines.push(`//   $${_hex(a, 4)} = $${_hex(v, 2)}${note}`);
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
// Per-char struct offsets (within the 64-byte block at $6100/$6200/etc)
const JOB_OFF = 0x00;          // char A: $6100 job id
const LEVEL_OFF = 0x01;        // char A: $6101 level (starts at 0)
const MP_OFF = 0x30;           // char A: $6130-$613F (8 levels × current/max)
const SPELL_LIST_OFF = 0x07;   // char B: $6207-$620E (1 spell id per level)

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
  'wm-spells': () => _grantMagic(0x03, WM_MASK, 'WM'),
  'bm-spells': () => _grantMagic(0x04, BM_MASK, 'BM'),
  'all-spells': () => _grantMagic(0x14, ALL_MASK, 'Sage'),
};

// $6207-$620E is a BITFIELD, not a spell ID — 7 spells per level packed:
//   bits 0-2 = the 3 BLACK spells of that level
//   bits 3-5 = the 3 WHITE spells of that level
//   bit  6   = the level's "summon-effect" spell (Bahamur, Heatra, Spark, etc.)
// Source: ff3j.asm 3D/A1F4 (`LDA spell_mask,X / ORA $6207,X`, masks 01,02,04,
// 08,10,20,40 × 8 levels) cross-referenced with the spell ID table at L8
// (Flare/Death/Meteor at bits 0-2, WWind/Life2/Holy at 3-5, Bahamur at 6).
//
// Real summon books (Chocb/Shiva/Ramuh/Ifrit/Titan/Odin/Levia/Baham) are
// inventory ITEMS, not bits in $6207. TODO: add a SUMMON BOOKS preset that
// pokes the right item IDs into $60C0-$60FF.
const BM_MASK  = 0x07;  // bits 0,1,2 — all 3 black spells per level
const WM_MASK  = 0x38;  // bits 3,4,5 — all 3 white spells per level
const ALL_MASK = 0x7F;  // every bit — black + white + summon-effect (Sage's spread)
const JOB_LEVELS_OFF = 0x10;  // char B: $6210+job*2 (job level), +1 (exp)

function _grantMagic(jobId, levelMask, label) {
  const a = SRAM_BASE + CHARS_A_OFF;       // char 1 part A ($6100)
  const b = SRAM_BASE + CHARS_B_OFF;       // char 1 part B ($6200)
  _ramWrite(a + JOB_OFF, jobId);
  _ramWrite(a + LEVEL_OFF, 50);
  // Bump job level for the active job so all 8 magic levels unlock.
  _ramWrite(b + JOB_LEVELS_OFF + jobId * 2, 99);
  // MP: 0x09 / 0x09 (current/max) per level — high enough to cast freely.
  for (let lvl = 0; lvl < 8; lvl++) {
    _ramWrite(a + MP_OFF + lvl * 2 + 0, 0x09);
    _ramWrite(a + MP_OFF + lvl * 2 + 1, 0x09);
  }
  // Spell knowledge bitfield: same mask for all 8 levels.
  for (let lvl = 0; lvl < 8; lvl++) {
    _ramWrite(b + SPELL_LIST_OFF + lvl, levelMask);
  }
  return `char A → ${label} (job ${_hex(jobId, 2)}, lv50, joblv99, mask ${_hex(levelMask, 2)})`;
}

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

  // ROM toggle — swap between FF3 (default) and the FF1&2 cart. FF1&2
  // is optional; only loaded if the user dropped a second ROM on the
  // title screen (used for FF1 shopkeeper / NPC captures).
  const romRow = document.createElement('div');
  romRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const romLabel = document.createElement('span');
  romLabel.textContent = 'ROM:';
  romLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const btnRomFF3 = mkBtn('FF3', () => _switchRom('ff3'));
  const btnRomFF12 = mkBtn('FF1&2', () => _switchRom('ff12'));
  romRow.append(romLabel, btnRomFF3, btnRomFF12);
  rightCol.appendChild(romRow);

  // Slot row: 4 numbered savestate slots. Tap to select; gold border = selected,
  // green text + bullet = populated. SAVE/LOAD always act on the selected slot.
  const slotRow = document.createElement('div');
  slotRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const slotLabel = document.createElement('span');
  slotLabel.textContent = 'Slot:';
  slotLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  slotRow.appendChild(slotLabel);
  const slotButtons = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const b = mkBtn(`S${i + 1}`, () => _selectSlot(i));
    b.style.minWidth = '34px';
    slotButtons.push(b);
    slotRow.appendChild(b);
  }
  rightCol.appendChild(slotRow);

  // Capture row: savestate + the two actual capture tools.
  const capRow = document.createElement('div');
  capRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const btnSave = mkBtn('SAVE', _saveState);
  const btnLoad = mkBtn('LOAD', _loadState);
  // Capture buttons auto-pause the emulator so a mid-frame PPU read can't tear.
  const btnSnap = mkBtn('SNAP OAM', () => _withPause(_snapshotOAM));
  const btnSnapBG = mkBtn('SNAP BG', () => _withPause(_snapshotBG));
  const btnWpn = mkBtn('WPN TILES', () => _withPause(_dumpWeaponTiles));
  capRow.append(btnSave, btnLoad, btnSnap, btnSnapBG, btnWpn);
  rightCol.appendChild(capRow);

  // REC row: multi-frame OAM/BG capture. Drives nes.frame() between snaps;
  // tap the active REC button mid-run to cancel.
  const recRow = document.createElement('div');
  recRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;';
  const btnRecOam = mkBtn('REC OAM', () => _toggleRec('OAM'));
  const btnRecBg = mkBtn('REC BG', () => _toggleRec('BG'));
  const btnDedupe = mkBtn('DEDUPE', _toggleDedupe);
  const recFramesLabel = document.createElement('span');
  recFramesLabel.textContent = 'frames:';
  recFramesLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const recFramesInput = document.createElement('input');
  recFramesInput.type = 'number';
  recFramesInput.value = '3';
  recFramesInput.min = String(REC_FRAMES_MIN);
  recFramesInput.max = String(REC_FRAMES_MAX);
  recFramesInput.style.cssText = 'width:48px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const recGapLabel = document.createElement('span');
  recGapLabel.textContent = 'gap:';
  recGapLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const recGapInput = document.createElement('input');
  recGapInput.type = 'number';
  recGapInput.value = '1';
  recGapInput.min = String(REC_GAP_MIN);
  recGapInput.max = String(REC_GAP_MAX);
  recGapInput.style.cssText = 'width:48px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  recRow.append(btnRecOam, btnRecBg, btnDedupe, recFramesLabel, recFramesInput, recGapLabel, recGapInput);
  rightCol.appendChild(recRow);

  // Tile dump input
  const tileRow = document.createElement('div');
  tileRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const tileLabel = document.createElement('span');
  tileLabel.textContent = 'Tile:';
  tileLabel.style.cssText = 'color:#888;font-size:11px;font-family:monospace;';
  const tileInput = document.createElement('input');
  tileInput.placeholder = '0-511 or $xxx';
  tileInput.style.cssText = 'flex:1;min-width:0;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const btnTileDump = mkBtn('DUMP', () => _withPause(_dumpTileByIndex));
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

  // Output toolbar — tap-friendly copy + download for the textarea below.
  // Selecting a 50-line textarea on touch is painful; these are the difference between usable and not.
  const outRow = document.createElement('div');
  outRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const btnCopy = mkBtn('COPY', _copyOutput);
  const btnSaveFile = mkBtn('SAVE FILE', _saveOutputFile);
  outRow.append(btnCopy, btnSaveFile);
  root.appendChild(outRow);

  const output = document.createElement('textarea');
  output.readOnly = true;
  output.placeholder = 'CAPTURE output goes here. Paste into src/data/job-sprites.js etc.';
  output.style.cssText = 'flex:1;min-height:140px;background:#0f0f18;color:#ccc;font-family:monospace;font-size:10px;border:1px solid #333;border-radius:3px;padding:6px;resize:vertical;';
  root.appendChild(output);

  // Scenes panel — committed savestate library at src/debug/scenes/.
  // See src/debug/scenes/README.md for the schema and authoring flow.
  const scenesPanel = document.createElement('details');
  scenesPanel.style.cssText = 'border:1px solid #333;border-radius:3px;background:#141420;padding:6px;';
  const scenesSummary = document.createElement('summary');
  scenesSummary.textContent = 'SCENES';
  scenesSummary.style.cssText = 'cursor:pointer;color:#c8a832;font-size:11px;font-family:monospace;user-select:none;';
  scenesPanel.appendChild(scenesSummary);

  const scenesBody = document.createElement('div');
  scenesBody.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px;';

  const scenesTopRow = document.createElement('div');
  scenesTopRow.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const btnRefreshScenes = mkBtn('REFRESH', _refreshScenesList);
  scenesTopRow.appendChild(btnRefreshScenes);
  scenesBody.appendChild(scenesTopRow);

  const scenesList = document.createElement('div');
  scenesList.style.cssText = 'display:flex;flex-direction:column;gap:0;max-height:200px;overflow-y:auto;';
  scenesBody.appendChild(scenesList);

  const scenesDivider = document.createElement('div');
  scenesDivider.style.cssText = 'border-top:1px solid #333;margin:4px 0 0 0;padding-top:4px;color:#888;font-size:10px;font-family:monospace;';
  scenesDivider.textContent = 'EXPORT current state as a new scene:';
  scenesBody.appendChild(scenesDivider);

  const sceneNameInput = document.createElement('input');
  sceneNameInput.placeholder = 'name (lowercase a-z, 0-9, -)';
  sceneNameInput.autocapitalize = 'none';
  sceneNameInput.autocomplete = 'off';
  sceneNameInput.spellcheck = false;
  sceneNameInput.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:6px 8px;';
  scenesBody.appendChild(sceneNameInput);

  const sceneDescInput = document.createElement('input');
  sceneDescInput.placeholder = 'short description';
  sceneDescInput.autocomplete = 'off';
  sceneDescInput.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:6px 8px;';
  scenesBody.appendChild(sceneDescInput);

  const btnExportScene = mkBtn('EXPORT SCENE', _exportScene);
  btnExportScene.style.alignSelf = 'flex-start';
  scenesBody.appendChild(btnExportScene);

  scenesPanel.appendChild(scenesBody);
  root.appendChild(scenesPanel);

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
  const btnWMSpells = mkBtn('WM SPELLS', () => _runPreset('wm-spells'));
  const btnBMSpells = mkBtn('BM SPELLS', () => _runPreset('bm-spells'));
  const btnAllSpells = mkBtn('ALL SPELLS', () => _runPreset('all-spells'));
  editBtnRow.append(btnDumpState, btnFullHP, btnClearInv, btnWMSpells, btnBMSpells, btnAllSpells);
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

  const d = { root, canvas, status, frame, btnPause, btnStep, btnReset, btnSound, btnRomFF3, btnRomFF12, btnSave, btnLoad, btnSnap, btnSnapBG, btnWpn, btnRecOam, btnRecBg, btnDedupe, recFramesInput, recGapInput, btnCopy, btnSaveFile, slotButtons, tileInput, btnTileDump, output, writeInput, scenesSummary, scenesList, sceneNameInput, sceneDescInput };
  dom = d;
  _installKeys();
  _refreshSlotButtons();
  _refreshRomButtons();
  // Fire-and-forget: populate the SCENES panel header count without blocking mount.
  _refreshScenesList();
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
