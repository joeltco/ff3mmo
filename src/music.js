// Music Manager — plays FF3 music via libgme (Game Music Emu)
//
// Builds an NSF from the ROM at init time, then uses libgme's Emscripten
// bindings to emulate the NES APU and output audio via Web Audio API.

import { buildNSF } from './nsf-builder.js';
import { buildFF1NSF } from './ff1-nsf-builder.js';

// Track indices — ROM song IDs (map properties byte 10)
export const TRACKS = {
  CRYSTAL_CAVE: 0x02,  // Altar Cave
  CRYSTAL_ROOM: 0x36,  // Crystal Room (song 54)
  WORLD_MAP:    0x1E,  // Eternal Wind
  TOWN_UR:      0x1F,  // My Home Town
  PIANO_3:      0x1A,  // 3rd piano song (loading screen)
  TITLE_SCREEN: 0x37,  // Title screen song (55)
  BATTLE:       0x20,  // Battle 1 (normal encounters)
  BOSS_BATTLE:  0x2A,  // Battle 2 (boss battle)
  VICTORY:      0x07,  // Battle victory
};

// SFX — raw NSF track numbers (passed directly to gme_start_track)
// SFX-type sounds: ROM SFX ID + 0x41. Song-type sounds: song ID directly.
export const SFX = {
  DOOR:         0x44,  // SFX $03 + $41
  FALL:         0x30,  // song 48 ($30) — falling/whoosh
  EARTHQUAKE:   0x99,  // SFX $58 + $41
  SCREEN_CLOSE: 0x54,  // SFX $13 + $41
  SCREEN_OPEN:  0x55,  // SFX $14 + $41
  WARP:         0x9D,  // SFX $5C + $41
  POND_DRINK:   0x91,  // SFX $50 + $41 — healing drink (play half)
  CURE:         0x4A,  // SFX $09 + $41 — cure spell sound
  BATTLE_SWIPE: 0x56,  // SFX $15 + $41 — battle encounter swoosh
  BOSS_DEATH:   0x7D,  // SFX $3C + $41 — boss dissolve crumble
  CURSOR:       0x59,  // SFX $18 + $41 — menu cursor movement
  CONFIRM:      0x46,  // SFX $05 + $41 — menu confirm
  ERROR:        0x47,  // SFX $06 + $41 — error buzz
  ATTACK_HIT:   0x71,  // SFX $30 + $41 — enemy physical hit on player (from battle-sfx-log trace v3)
  KNIFE_HIT:    0x77,  // SFX $36 + $41 — knife/blade slash hit (ROM writes $B6 to $7F49)
  MONSTER_DEATH: 0x72, // SFX $31 + $41 — normal monster death (ROM writes $B1 to $7F49)
  DEFEND_HIT:   0x61,  // SFX $20 + $41 — defend action sound (confirmed by user)
  TREASURE:     0x80,  // SFX $3F + $41 — treasure chest open (3F/E982: LDA #$BF → $7F49)
  RUN_AWAY:     0x74,  // SFX $33 + $41 — escape success (ROM writes $B3 to $7F49 at PC=$BCBC)
  SW_HIT:       0x5D,  // SFX $1C + $41 — SouthWind ice hit per enemy (from battle-item-trace)
};

// FF1 track indices (0-based, for ff1 NSF)
export const FF1_TRACKS = {
  MENU_SCREEN: 16,  // Song $51 (music_track $11) — FF1 menu music
};

let nsfData = null;    // Built NSF Uint8Array
let audioCtx = null;   // Web Audio context
let emu = null;        // libgme emulator handle
let emuRef = null;     // Emscripten pointer for emulator
let node = null;       // ScriptProcessor node
let audioBuf = null;   // Emscripten heap pointer for sample buffer
let currentTrack = -1;

// Stashed music state (for pause/resume across battle)
let stashedEmu = null;
let stashedNode = null;
let stashedTrack = -1;

// SFX — second libgme emulator so SFX don't kill music
let sfxEmu = null;
let sfxEmuRef = null;
let sfxNode = null;
let sfxBuf = null;
let sfxMuted = false;  // flag to silence SFX without expensive gme_seek

// FF1 music — third libgme emulator for FF1 ROM music (menu screen, etc.)
let ff1NsfData = null;
let ff1Emu = null;
let ff1EmuRef = null;
let ff1Node = null;
let ff1Buf = null;
let ff1Track = -1;

const BUF_SIZE = 4096; // samples per channel per callback (music, ~85ms at 48kHz)
const SFX_BUF_SIZE = 2048;  // smaller buffer for SFX (~42ms latency at 48kHz)

export function initMusic(romData) {
  nsfData = buildNSF(romData);
}

export function playTrack(trackId) {
  if (!nsfData) return;
  if (typeof Module === 'undefined' || !Module.ccall) return;
  if (trackId === currentTrack) return;
  currentTrack = trackId;

  // Create AudioContext on first use (browser autoplay policy)
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Tear down previous playback
  if (node) {
    node.disconnect();
    node = null;
  }
  if (emu) {
    Module.ccall('gme_delete', 'number', ['number'], [emu]);
    emu = null;
  }

  // Allocate emulator reference pointer (once)
  if (!emuRef) {
    emuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
  }

  // Open NSF data in libgme
  const err = Module.ccall('gme_open_data', 'number',
    ['array', 'number', 'number', 'number'],
    [nsfData, nsfData.length, emuRef, audioCtx.sampleRate]);
  if (err !== 0) {
    console.error('gme_open_data failed');
    return;
  }
  emu = Module.getValue(emuRef, 'i32');

  // Ignore silence detection (songs loop forever)
  Module.ccall('gme_ignore_silence', 'number', ['number'], [emu, 1]);

  // Start the requested track
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, trackId]) !== 0) {
    console.error('gme_start_track failed for track', trackId);
    return;
  }

  // Allocate sample buffer (once) — 16-bit stereo interleaved
  if (!audioBuf) {
    audioBuf = Module._malloc(BUF_SIZE * 2 * 2); // BUF_SIZE frames × 2 channels × 2 bytes
  }

  // Create ScriptProcessor for audio output
  node = audioCtx.createScriptProcessor(BUF_SIZE, 0, 2);

  node.onaudioprocess = (e) => {
    if (!emu) return;

    if (Module.ccall('gme_track_ended', 'number', ['number'], [emu]) === 1) {
      Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, currentTrack]);
    }

    // gme_play outputs interleaved stereo 16-bit signed samples: L,R,L,R,...
    Module.ccall('gme_play', 'number',
      ['number', 'number', 'number'],
      [emu, BUF_SIZE * 2, audioBuf]);

    const ch0 = e.outputBuffer.getChannelData(0);
    const ch1 = e.outputBuffer.getChannelData(1);
    const base = audioBuf >> 1; // HEAP16 index (byte offset / 2)

    for (let i = 0; i < BUF_SIZE; i++) {
      ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
      ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
    }
  };

  node.connect(audioCtx.destination);
}

export function stopMusic() {
  if (node) {
    node.disconnect();
    node = null;
  }
  if (emu) {
    Module.ccall('gme_delete', 'number', ['number'], [emu]);
    emu = null;
  }
  currentTrack = -1;
}

export function playSFX(sfxId) {
  if (!nsfData) return;
  if (typeof Module === 'undefined' || !Module.ccall) return;

  // Ensure AudioContext exists
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Lazy-init SFX emulator (persists across calls, reset per SFX)
  if (!sfxEmu) {
    if (!sfxEmuRef) {
      sfxEmuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
    }
    const err = Module.ccall('gme_open_data', 'number',
      ['array', 'number', 'number', 'number'],
      [nsfData, nsfData.length, sfxEmuRef, audioCtx.sampleRate]);
    if (err !== 0) return;
    sfxEmu = Module.getValue(sfxEmuRef, 'i32');
    // Do NOT call gme_ignore_silence — SFX should end naturally
  }

  // Start the SFX track (raw NSF track number)
  sfxMuted = false;  // clear mute from any previous stopSFX
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'],
      [sfxEmu, sfxId]) !== 0) {
    return;
  }

  // Allocate SFX sample buffer (once)
  if (!sfxBuf) {
    sfxBuf = Module._malloc(SFX_BUF_SIZE * 2 * 2);
  }

  // Create SFX ScriptProcessor if not exists
  if (!sfxNode) {
    sfxNode = audioCtx.createScriptProcessor(SFX_BUF_SIZE, 0, 2);
    sfxNode.onaudioprocess = (e) => {
      if (!sfxEmu) {
        e.outputBuffer.getChannelData(0).fill(0);
        e.outputBuffer.getChannelData(1).fill(0);
        return;
      }

      // If SFX muted or track ended, output silence
      if (sfxMuted || Module.ccall('gme_track_ended', 'number', ['number'], [sfxEmu]) === 1) {
        e.outputBuffer.getChannelData(0).fill(0);
        e.outputBuffer.getChannelData(1).fill(0);
        return;
      }

      Module.ccall('gme_play', 'number',
        ['number', 'number', 'number'],
        [sfxEmu, SFX_BUF_SIZE * 2, sfxBuf]);

      const ch0 = e.outputBuffer.getChannelData(0);
      const ch1 = e.outputBuffer.getChannelData(1);
      const base = sfxBuf >> 1;

      for (let i = 0; i < SFX_BUF_SIZE; i++) {
        ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
        ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
      }
    };
    sfxNode.connect(audioCtx.destination);
  }
}

// Stop SFX playback (ROM writes $FF to $7F49 to cut SFX short)
export function stopSFX() {
  sfxMuted = true;  // instant silence — no expensive gme_seek
}

// --- FF1 music (third emulator) ---

export function initFF1Music(romData) {
  ff1NsfData = buildFF1NSF(romData);
}

export function playFF1Track(trackId) {
  if (!ff1NsfData) return;
  if (typeof Module === 'undefined' || !Module.ccall) return;
  if (trackId === ff1Track) return;
  ff1Track = trackId;

  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Tear down previous FF1 playback
  if (ff1Node) {
    ff1Node.disconnect();
    ff1Node = null;
  }
  if (ff1Emu) {
    Module.ccall('gme_delete', 'number', ['number'], [ff1Emu]);
    ff1Emu = null;
  }

  if (!ff1EmuRef) {
    ff1EmuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
  }

  const err = Module.ccall('gme_open_data', 'number',
    ['array', 'number', 'number', 'number'],
    [ff1NsfData, ff1NsfData.length, ff1EmuRef, audioCtx.sampleRate]);
  if (err !== 0) {
    console.error('ff1 gme_open_data failed');
    return;
  }
  ff1Emu = Module.getValue(ff1EmuRef, 'i32');

  Module.ccall('gme_ignore_silence', 'number', ['number'], [ff1Emu, 1]);

  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [ff1Emu, trackId]) !== 0) {
    console.error('ff1 gme_start_track failed for track', trackId);
    return;
  }

  if (!ff1Buf) {
    ff1Buf = Module._malloc(BUF_SIZE * 2 * 2);
  }

  ff1Node = audioCtx.createScriptProcessor(BUF_SIZE, 0, 2);

  ff1Node.onaudioprocess = (e) => {
    if (!ff1Emu) return;

    if (Module.ccall('gme_track_ended', 'number', ['number'], [ff1Emu]) === 1) {
      Module.ccall('gme_start_track', 'number', ['number', 'number'], [ff1Emu, ff1Track]);
    }

    Module.ccall('gme_play', 'number',
      ['number', 'number', 'number'],
      [ff1Emu, BUF_SIZE * 2, ff1Buf]);

    const ch0 = e.outputBuffer.getChannelData(0);
    const ch1 = e.outputBuffer.getChannelData(1);
    const base = ff1Buf >> 1;

    for (let i = 0; i < BUF_SIZE; i++) {
      ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
      ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
    }
  };

  ff1Node.connect(audioCtx.destination);
}

export function stopFF1Music() {
  if (ff1Node) {
    ff1Node.disconnect();
    ff1Node = null;
  }
  if (ff1Emu) {
    Module.ccall('gme_delete', 'number', ['number'], [ff1Emu]);
    ff1Emu = null;
  }
  ff1Track = -1;
}

export function getCurrentTrack() {
  return currentTrack;
}

export function pauseMusic() {
  if (node) node.disconnect();
  // Stash current state so playTrack can overwrite emu/node
  stashedEmu = emu;
  stashedNode = node;
  stashedTrack = currentTrack;
  emu = null;
  node = null;
  currentTrack = -1;
}

export function resumeMusic() {
  // Kill whatever is playing now (e.g. battle music)
  if (node) { node.disconnect(); node = null; }
  if (emu) { Module.ccall('gme_delete', 'number', ['number'], [emu]); emu = null; }
  // Restore stashed state
  if (stashedNode && audioCtx) {
    emu = stashedEmu;
    node = stashedNode;
    currentTrack = stashedTrack;
    node.connect(audioCtx.destination);
  }
  stashedEmu = null;
  stashedNode = null;
  stashedTrack = -1;
}

