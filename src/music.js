// Music Manager — plays FF3 music via libgme (Game Music Emu)
//
// Builds an NSF from the ROM at init time, then uses libgme's Emscripten
// bindings to emulate the NES APU and output audio via Web Audio API.

import { buildNSF } from './nsf-builder.js';
import { buildFF1NSF } from './ff1-nsf-builder.js';
import { buildFF2NSF, ff2SfxTrack } from './ff2-nsf-builder.js';
import { getSetting, volGain } from './settings.js';

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
  DOOR:         0x44,  // SFX $03 + $41  [MEASURED v1.7.875 — the party spawned beside Ur's door (map 114, door at 21,26) and walked into it; the ROM's only `LDA #$83` site (0x7e6ad) fired on 14 of 14 passes, each followed by a fade to black. The fade is what makes it a DOOR rather than the unattributed $83 seen wandering the Altar Cave in v1.7.874.]
  FALL:         0x30,  // song 48 ($30) — falling/whoosh.  [MEASURED v1.7.876 — songs are requested at $7F43, NOT $7F49, which is why the SFX sweep could never see this one. The intro requests song 48 at frame 2733, right after the name grid closes and the screen blacks out; frame 2860 shows a lone character falling through darkness and by 2980 the party is standing in the Altar Cave. Song 2 (cave theme) follows at 2941, so 48 spans the fall and nothing else. Instrument self-checks: the same runs report song 31 in Ur (literally Ur's ROM songId byte) and song 32 on a battle (TRACKS.BATTLE).]
  EARTHQUAKE:   0x99,  // SFX $58 + $41  [MEASURED v1.7.874 — the opening quake, from the ROM's only `LDA #$D8` (0x775a1); $D8 - $3F = 0x99]
  SCREEN_CLOSE: 0x54,  // SFX $13 + $41  [MEASURED v1.7.875 — the CLOSING half of the map-transition wipe, from its own dedicated `LDA #$93` site (0x7c1cd): 4 of 5 warp passes and 14 of 14 Ur-door passes, always straight after the door/warp sound. Matches how transitions.js uses it.]
  SCREEN_OPEN:  0x55,  // SFX $14 + $41  [MEASURED v1.7.875 — the OPENING half of the same wipe, from its own dedicated `LDA #$94` site (0x7e2e4), 5 of 5 warp passes with a fade. Note the two halves have separate sites; the shared store at $E28F that v1.7.874 saw is a third path reached with A preloaded.]
  WARP:         0x9D,  // SFX $5C + $41  [MEASURED v1.7.875 — the warp tile in the crystal chamber (map 149 at 6,5), 5 of 5 passes, each with a fade to black; the capture screenshot shows a glowing portal. v1.7.874 flagged that $DC appears at no immediate site as 'suggestive' the constant might be wrong — it is not; the write arrives through the `LDA $CA` dispatcher. That absence signal was correctly labelled not-proof, and acting on it would have broken a correct constant.]
  POND_DRINK:   0x91,  // SFX $50 + $41 — healing drink (play half).  [MEASURED v1.7.876 — the Altar Cave pond, map 115, water at (29,8) with the party spawned at (29,9). A pressed at the water fired $d0 on 69 of 70 rounds, and CURE ($89 -> 74) follows every time as the heal lands, which is the same two-sound sequence handlePondHeal already plays. The pond is plain WALKABLE WATER, not an event trigger — which is why a sweep of all 215 event triggers, every Altar floor and ~300k frames never once produced $d0. That negative nearly got reported as 'the ROM never plays this'.]
  CURE:         0x4A,  // SFX $09 + $41 — cure spell sound  [MEASURED v1.7.873 — cure/heal captures, $89]
  MAGIC_CAST:   0x62,  // SFX $21 + $41 — magic pre-animation channel sound (FF3J disasm 33/B0D8 black, 33/B0FF white: LDA #$A1 / STA $7F49)  [MEASURED v1.7.873 — pre-animation cast cue, $A1]
  BATTLE_SWIPE: 0x56,  // SFX $15 + $41 — battle encounter swoosh  [MEASURED v1.7.874 — the only `LDA #$95` site (0x7d35f). A battle is on screen within 240 frames 11 times out of 11, while every other field sound in the same run scores 0/8, 0/3, 0/1. The CONTRAST is the evidence.]
  BOSS_DEATH:   0x7D,  // SFX $3C + $41 — boss dissolve crumble  [MEASURED v1.7.873 — Bahamut (0x06) capture, $BC]
  CURSOR:       0x59,  // SFX $18 + $41 — menu cursor movement  [MEASURED v1.7.874 — cursor moved in the name grid and the battle command window; two distinct `LDA #$98` sites, 0x7d225 (field) and 0x65bea (battle)]
  CONFIRM:      0x46,  // SFX $05 + $41 — menu confirm  [MEASURED v1.7.873 — physical-attack control round, $85]
  ERROR:        0x47,  // SFX $06 + $41 — error buzz  [MEASURED v1.7.874 — the battle command menu has 3 rows; selecting rows 3-6 buzzes on every attempt (20/20 per row) and rows 0-2 never do. Also fires from its own `LDA #$86` site (0x7d53b) on the field.]
  ATTACK_HIT:   0x71,  // SFX $30 + $41 — enemy physical hit on player (from battle-sfx-log trace v3)  [MEASURED v1.7.873 — physical-attack control round, $B0]
  KNIFE_HIT:    0x77,  // SFX $36 + $41 — knife/blade slash hit (ROM writes $B6 to $7F49)  [MEASURED v1.7.873 — monster's hit on the party, $B6 (32 traces)]
  MONSTER_DEATH: 0x72, // SFX $31 + $41 — normal monster death (ROM writes $B1 to $7F49)  [MEASURED v1.7.873 — death-spell secondary cue, $B1 (5 traces)]
  DEFEND_HIT:   0x61,  // SFX $20 + $41 — defend action sound (confirmed by user)  [MEASURED v1.7.873 — Safe (0x1a) capture, $A0].  [SETTLED v1.7.877 — v1.7.875 wondered aloud whether this belonged to the Run row and Guard's real sound was 135 ($c6), off one sighting each. Measured in an unkillable/harmless sandbox battle: across 61 rounds of battle-menu interaction $c6 NEVER appears. (v1.7.877 also said 'Guard plays no sound of its own'; that was overstated — the harness only lands a direction press about half the time, so an unknown share of those rounds were really Attack. The $c6 refutation does not depend on row labels; that claim did.) $a0 shows up only under Run, twice, beside the one escape. So the 135 idea is refuted and this constant is NOT moving: its $A0 measurement is the Safe spell's impact (a real capture of a different event), and DEFEND_HIT is OUR cue for OUR defend command. See BATTLE_ROW_SOUNDS in data/world-sfx-captured.js.]
  TREASURE:     0x80,  // SFX $3F + $41 — treasure chest open (3F/E982: LDA #$BF → $7F49)  [MEASURED v1.7.874 — A pressed at a chest in the Altar Cave, from the ROM's ONLY `LDA #$BF` store (0x7e994); the screenshot at the write shows the party against a row of chests and the follow-up shows one open]
  RUN_AWAY:     0x74,  // SFX $33 + $41 — escape success.  [MEASURED v1.7.876 — a real escape on an unpatched ROM, frame 30655. Run is a MENU ROW (the window reads Attack/Guard/Run/Item) and it is PER CHARACTER: picking Run for one member and mashing A for the rest never leaves. Choose it for all four and the party escapes — once in 34 full-party rounds, since escape is a roll. Corroborated by forcing entry to the routine at $BC89, which plays the same $b3 and clears the field. Do NOT re-read that routine's `JSR $8AE6 / AND #$20 / BEQ` as a joypad test; $8AE6 is `INC $B6 / LDA $B6 / RTS`, a loop counter.]
  SW_HIT:       0x5D,  // SFX $1C + $41 — SouthWind ice hit per enemy (from battle-item-trace)
  SIGHT:        0x7A,  // NSF $7A — Sight impact. MEASURED v1.7.873: the headless sweep casts Sight (spell 0x36) and the CPU writes `$B9` to $7F49, 98 frames after Sight's own CHR block goes live -> `$B9 - $3F = $7A`. This was 0x81 for a long time, carrying its own note that 0x81 had been inferred from a `$40` post-consume RESIDUAL rather than the request, and asking for exactly this recapture. The note was right: 0x81 is wrong. Same trap that once made FIRE_BOOM and REVIVE wrong.
  FIRE_BOOM:    0x82,  // SFX $41 + $41 — Fire spell impact. Verified via REC OAM f1301 (2026-05-08, post-v1.7.111 dumper): CPU writes `$C1` to $7F49 at frame 19 → NSF track `$C1 - $3F = $82`. Was 0x81 before v1.7.112; that was inferred from the post-consume residual `$40`, which is NOT the requested index — the engine does its own bookkeeping after consuming the high-bit pulse.
  SLEEP_PUFF:   0x95,  // SFX $54 + $41 — Sleep spell impact. Verified via REC OAM sleep-emu-snap (2026-05-08, v1.7.111+ dumper): CPU writes `$D4` to $7F49 at frame 74 → NSF track `$D4 - $3F = $95`.
  CRYSTAL_THUNDER: 132,  // NSF track 132 ($84) — crystal flash thunder/crash. Found by audition (/sfx); the disasm event $4B `F8 7F` pointed here.  [MEASURED v1.7.873 — Bolt/Bolt2/Bolt3 captures, $C3]
  REVIVE:       0x92,  // NSF track $92 — party-death/angel revive jingle. Verified via REC OAM @ f311 (capture STARTED before death): CPU writes `$D1` to $7F49 at frame 40 → track `$D1 - $3F = $92`, firing as the angel appears. The earlier f5299 residual `$40` was post-consume bookkeeping, NOT the request (same trap as SIGHT/FIRE_BOOM).
};

// FF1 track indices (0-based, for ff1 NSF).
//
// FF1 keeps its current song in zero page $4B (`music_track`) and starts one via
// Music_NewSong at $B003; NSF track N is FF1 song id N + $41. So "which song is
// this screen" is answerable by watching one byte — `tools/ff1-sound-probe.mjs`
// does exactly that and screenshots 45 frames after each request, which is how
// the entries below stopped being "verified by ear".
export const FF1_TRACKS = {
  // MEASURED v1.8.3: the game writes $51 to $4B the moment the party menu
  // opens, and writes the field song back when it closes. The screenshot at the
  // request is FF1's ITEM/MAGIC/WEAPON/ARMOR/STATUS party screen.
  MENU_SCREEN: 16,
  // ⚠ NOT attributed. The ROM really does request track 14 — three sites in
  // bank 14 ($a352, $a56f, $a598), found by `tools/ff1-sound-sites.mjs` — so it
  // is a real game track and not an invented number. But it has NOT been
  // observed firing on a shop screen: reaching an FF1 shop headlessly is
  // unsolved (the overworld position bytes $027/$028 track the party but
  // writing them does not move it, so warping in is not available yet).
  // Treat as PICKED until someone stands in a shop and sees $4B go to $4F.
  SHOP:        14,
};

/**
 * FF1 tracks whose meaning has actually been observed, for the sound catalogue.
 * Anything not in here is unlabelled ON PURPOSE — the ROM has 23 tracks and only
 * these three have been watched being requested at a known screen.
 */
export const FF1_TRACK_MEANINGS = new Map([
  [0,  'opening prologue ("The world is veiled in darkness...")'],
  [3,  'overworld field'],
  [16, 'main menu (party screen)'],
]);

// FF2 NSF track indices (0-based into the 31-entry song table). Audition-
// confirm the exact index by ear if a track sounds wrong (off-by-one between
// player-UI 1-based numbering and the 0-based gme_start_track call).
export const FF2_TRACKS = {
  ELDER_HOUSE: 24,   // elder house theme — confirmed by ear via /ff2 24
  MENTION_CHIME: 8,  // short jingle played when someone @-mentions you in chat
  // FF2's own "you learned a keyword" cue. MEASURED (v1.8.0): fires on the
  // exact frame Hilda teaches the keyword 【のばら】 in the Altair intro, and
  // never again across 4 re-conversations or 60 wander-and-LEARN attempts.
  // See playWordLearnedJingle below and docs/SFX-AUDIT.md.
  WORD_LEARNED: 9,
};

// FF2's own menu blips, ripped from the ROM and appended to the FF2 NSF as
// extra tracks (see ff2-nsf-builder.js FF2_SFX for the measurement).
// MEASURED v1.7.981 on the kana name-entry grid: a direction press fires
// CURSOR 4/4 and never CONFIRM; A or B fires CONFIRM and never CURSOR.
export const FF2_SFX_NAMES = { CURSOR: 'cursor', CONFIRM: 'confirm' };

let nsfData = null;    // Built NSF Uint8Array
let audioCtx = null;   // Web Audio context
let gainNode = null;   // Master gain — used for fade-out
let emu = null;        // libgme emulator handle
let emuRef = null;     // Emscripten pointer for emulator
let node = null;       // ScriptProcessor node
let audioBuf = null;   // Emscripten heap pointer for sample buffer
let currentTrack = -1;
let fadeOutTimer = null; // setTimeout handle for stop-after-fade

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
let ff1GainNode = null;
let ff1FadeTimer = null;
let ff1Buf = null;
let ff1Track = -1;

// FF2 music — fourth libgme emulator for FF2 ROM music (elder-house theme).
let ff2NsfData = null;
let ff2Emu = null;
let ff2EmuRef = null;
let ff2Node = null;
let ff2GainNode = null;
let ff2Buf = null;
let ff2Track = -1;

// Mention chime — a fifth, dedicated FF2 emulator so a one-shot notification
// jingle never disturbs the background map music (FF3 town on the main emu,
// or FF2 elder-house on ff2Emu). Built lazily from the same ff2NsfData.
let chimeEmu = null;
let chimeEmuRef = null;
let chimeNode = null;
let chimeBuf = null;
let chimeGainNode = null;
let chimeStopTimer = null;
// FF2 sound effects get their own emulator for the same reason the chime does:
// a blip must never disturb the map music.
let ff2SfxEmu = null;
let ff2SfxEmuRef = null;
let ff2SfxNode = null;
let ff2SfxBuf = null;
let ff2SfxGainNode = null;
let ff2SfxStopTimer = null;
const FF2_SFX_MS = 900;   // hard cap; the blips self-silence in 12-16 frames
const CHIME_MS = 2200;  // hard cap — a looping NSF track won't run forever

const BUF_SIZE = 4096; // samples per channel per callback (music, ~85ms at 48kHz)
const SFX_BUF_SIZE = 2048;  // smaller buffer for SFX (~42ms latency at 48kHz)

// Master volume buses. Every music emulator's per-track gain routes through
// musicMasterGain; SFX + the @-mention chime route through sfxMasterGain. This
// lets Options → Music / SFX set one gain each without touching the per-track
// fade-out ramps (which still ride on each emulator's own gain node). Created
// lazily once the AudioContext exists; initial gain reads from settings.
let musicMasterGain = null;
let sfxMasterGain = null;

function _musicMaster() {
  if (!musicMasterGain && audioCtx) {
    musicMasterGain = audioCtx.createGain();
    musicMasterGain.gain.value = volGain(getSetting('musicVol'));
    musicMasterGain.connect(audioCtx.destination);
  }
  return musicMasterGain;
}

function _sfxMaster() {
  if (!sfxMasterGain && audioCtx) {
    sfxMasterGain = audioCtx.createGain();
    sfxMasterGain.gain.value = volGain(getSetting('sfxVol'));
    sfxMasterGain.connect(audioCtx.destination);
  }
  return sfxMasterGain;
}

// Re-read the stored volume and apply it to the live bus. Called by the Options
// menu after changing the setting (and safe to call any time — no-op if the bus
// isn't created yet, since _musicMaster/_sfxMaster read the setting on create).
export function applyMusicVolume() {
  const m = _musicMaster();
  if (m && audioCtx) m.gain.setValueAtTime(volGain(getSetting('musicVol')), audioCtx.currentTime);
}

export function applySfxVolume() {
  const m = _sfxMaster();
  if (m && audioCtx) m.gain.setValueAtTime(volGain(getSetting('sfxVol')), audioCtx.currentTime);
}

export function initMusic(romData) {
  nsfData = buildNSF(romData);
}

// Create + resume the shared AudioContext. Mobile browsers (and desktop
// autoplay policy) only let audio start from inside a user-gesture call stack,
// so this is wired to the first touch/click/key in main.js. Once unlocked the
// context stays unlocked, so every later playTrack / SFX / chime just works —
// without this, music + the @-mention chime can stay silent on phones.
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no Web Audio support — silent */ }
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
  if (!gainNode) {
    gainNode = audioCtx.createGain();
    gainNode.connect(_musicMaster());
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  // Cancel any in-progress fade and reset gain to full
  if (fadeOutTimer) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setValueAtTime(1, audioCtx.currentTime);

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

  node.connect(gainNode);
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

export function fadeOutMusic(durationMs) {
  if (!gainNode || !audioCtx) return;
  if (fadeOutTimer) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
  gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + durationMs / 1000);
  fadeOutTimer = setTimeout(() => { fadeOutTimer = null; stopMusic(); }, durationMs);
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
    sfxNode.connect(_sfxMaster());
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

  if (!ff1GainNode) { ff1GainNode = audioCtx.createGain(); ff1GainNode.connect(_musicMaster()); }
  if (ff1FadeTimer) { clearTimeout(ff1FadeTimer); ff1FadeTimer = null; }
  ff1GainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  ff1GainNode.gain.setValueAtTime(1, audioCtx.currentTime);
  ff1Node.connect(ff1GainNode);
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

export function fadeOutFF1Music(durationMs) {
  if (!ff1GainNode || !audioCtx) return;
  if (ff1FadeTimer) { clearTimeout(ff1FadeTimer); ff1FadeTimer = null; }
  ff1GainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  ff1GainNode.gain.setValueAtTime(ff1GainNode.gain.value, audioCtx.currentTime);
  ff1GainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + durationMs / 1000);
  ff1FadeTimer = setTimeout(() => { ff1FadeTimer = null; stopFF1Music(); }, durationMs);
}

// --- FF2 music (fourth emulator) — elder house theme ---

export function initFF2Music(romData) {
  ff2NsfData = buildFF2NSF(romData);
}

export function ff2MusicReady() { return ff2NsfData != null; }

export function playFF2Track(trackId) {
  if (!ff2NsfData) return;
  if (typeof Module === 'undefined' || !Module.ccall) return;
  if (trackId === ff2Track) return;
  ff2Track = trackId;

  if (!audioCtx) { audioCtx = new AudioContext(); }
  if (audioCtx.state === 'suspended') { audioCtx.resume(); }

  if (ff2Node) { ff2Node.disconnect(); ff2Node = null; }
  if (ff2Emu) { Module.ccall('gme_delete', 'number', ['number'], [ff2Emu]); ff2Emu = null; }

  if (!ff2EmuRef) { ff2EmuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC); }

  const err = Module.ccall('gme_open_data', 'number',
    ['array', 'number', 'number', 'number'],
    [ff2NsfData, ff2NsfData.length, ff2EmuRef, audioCtx.sampleRate]);
  if (err !== 0) { console.error('ff2 gme_open_data failed'); return; }
  ff2Emu = Module.getValue(ff2EmuRef, 'i32');

  Module.ccall('gme_ignore_silence', 'number', ['number'], [ff2Emu, 1]);

  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [ff2Emu, trackId]) !== 0) {
    console.error('ff2 gme_start_track failed for track', trackId);
    return;
  }

  if (!ff2Buf) { ff2Buf = Module._malloc(BUF_SIZE * 2 * 2); }

  ff2Node = audioCtx.createScriptProcessor(BUF_SIZE, 0, 2);
  ff2Node.onaudioprocess = (e) => {
    if (!ff2Emu) return;
    if (Module.ccall('gme_track_ended', 'number', ['number'], [ff2Emu]) === 1) {
      Module.ccall('gme_start_track', 'number', ['number', 'number'], [ff2Emu, ff2Track]);
    }
    Module.ccall('gme_play', 'number',
      ['number', 'number', 'number'],
      [ff2Emu, BUF_SIZE * 2, ff2Buf]);
    const ch0 = e.outputBuffer.getChannelData(0);
    const ch1 = e.outputBuffer.getChannelData(1);
    const base = ff2Buf >> 1;
    for (let i = 0; i < BUF_SIZE; i++) {
      ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
      ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
    }
  };

  if (!ff2GainNode) { ff2GainNode = audioCtx.createGain(); ff2GainNode.connect(_musicMaster()); }
  ff2GainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  ff2GainNode.gain.setValueAtTime(1, audioCtx.currentTime);
  ff2Node.connect(ff2GainNode);
}

export function stopFF2Music() {
  if (ff2Node) { ff2Node.disconnect(); ff2Node = null; }
  if (ff2Emu) { Module.ccall('gme_delete', 'number', ['number'], [ff2Emu]); ff2Emu = null; }
  ff2Track = -1;
}

// Play the mention chime once on its own emulator/gain, leaving whatever map
// music is playing untouched. Re-triggering restarts the jingle. Auto-stops
// on track end or after CHIME_MS, whichever comes first. No-op until the FF2
// ROM has been loaded (ff2NsfData built in initFF2Music).
export function playMentionChime() { _playFF2Jingle(FF2_TRACKS.MENTION_CHIME); }

/**
 * The sound FF2 plays when you LEARN a keyword.
 *
 * MEASURED, not picked. Reaching FF2 gameplay headlessly was blocked by its
 * name-entry screen until the one-byte ROM patch in
 * `tools/ff2-build-playable-rom.mjs`; with that, `tools/ff2-learn-capture.mjs`
 * drove the intro and logged every `$E0` request against the frame it happened
 * on. Song 9 fires on the exact frame Hilda says
 *
 *     ヒルダ「あいことばは【のばら】です。よく おぼえておくのよ。」
 *     (Hilda: "The password is 【のばら】. Remember it well.")
 *
 * — the moment FF2 teaches its first keyword — and it never fires again across
 * four re-conversations with the same NPC or sixty wander-and-LEARN attempts.
 * It plays over the map music and hands it back 98 frames later (~1.6 s), which
 * matches the 1536 ms the sound catalogue measures for track 9.
 */
export function playWordLearnedJingle() { _playFF2Jingle(FF2_TRACKS.WORD_LEARNED); }

/**
 * Play a one-shot FF2 track on its own emulator, leaving whatever map music is
 * playing untouched. Re-triggering restarts it. Auto-stops on track end or after
 * CHIME_MS, whichever comes first. No-op until the FF2 ROM is loaded.
 *
 * One implementation for every FF2 jingle — the mention chime and the
 * word-learned cue are the same machinery, and two copies of it would drift.
 */
function _playFF2Jingle(track) {
  if (!ff2NsfData) return;
  if (typeof Module === 'undefined' || !Module.ccall) return;
  if (!audioCtx) { audioCtx = new AudioContext(); }
  if (audioCtx.state === 'suspended') { audioCtx.resume(); }
  _stopChime();  // collapse a still-ringing jingle so rapid triggers re-fire

  if (!chimeEmuRef) { chimeEmuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC); }
  const err = Module.ccall('gme_open_data', 'number',
    ['array', 'number', 'number', 'number'],
    [ff2NsfData, ff2NsfData.length, chimeEmuRef, audioCtx.sampleRate]);
  if (err !== 0) { console.error('chime gme_open_data failed'); return; }
  chimeEmu = Module.getValue(chimeEmuRef, 'i32');

  Module.ccall('gme_ignore_silence', 'number', ['number'], [chimeEmu, 1]);
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [chimeEmu, track]) !== 0) {
    console.error('chime gme_start_track failed'); _stopChime(); return;
  }

  if (!chimeBuf) { chimeBuf = Module._malloc(BUF_SIZE * 2 * 2); }
  chimeNode = audioCtx.createScriptProcessor(BUF_SIZE, 0, 2);
  chimeNode.onaudioprocess = (e) => {
    const ch0 = e.outputBuffer.getChannelData(0);
    const ch1 = e.outputBuffer.getChannelData(1);
    // Track ended (or torn down) → emit silence; the timer does the teardown
    // so we never delete the emu from inside its own audio callback.
    if (!chimeEmu || Module.ccall('gme_track_ended', 'number', ['number'], [chimeEmu]) === 1) {
      ch0.fill(0); ch1.fill(0); return;
    }
    Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [chimeEmu, BUF_SIZE * 2, chimeBuf]);
    const base = chimeBuf >> 1;
    for (let i = 0; i < BUF_SIZE; i++) {
      ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
      ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
    }
  };

  if (!chimeGainNode) { chimeGainNode = audioCtx.createGain(); chimeGainNode.connect(_sfxMaster()); }
  chimeGainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  chimeGainNode.gain.setValueAtTime(0.85, audioCtx.currentTime);
  chimeNode.connect(chimeGainNode);
  chimeStopTimer = setTimeout(_stopChime, CHIME_MS);
}

/**
 * Play one of FF2's ripped menu blips. No-op until the FF2 ROM is loaded, so
 * callers can fire it unconditionally the way they do playSFX.
 */
export function playFF2Sfx(name) {
  // NEVER silent. The FF2 blips only exist once the player has supplied the FF2
  // ROM and initFF2Music has built the NSF; before that this used to return and
  // the menu made no sound at all, which is indistinguishable from "the audio is
  // broken". Fall back to the nearest FF3 blip instead.
  const fallback = () => playSFX(name === FF2_SFX_NAMES.CONFIRM ? SFX.CONFIRM : SFX.CURSOR);
  if (!ff2NsfData) { fallback(); return; }
  if (typeof Module === 'undefined' || !Module.ccall) return;
  const track = ff2SfxTrack(name);
  if (track < 0) { fallback(); return; }
  if (!audioCtx) { audioCtx = new AudioContext(); }
  if (audioCtx.state === 'suspended') { audioCtx.resume(); }
  if (sfxMuted) return;
  _stopFF2Sfx();   // re-trigger cleanly on a held direction

  if (!ff2SfxEmuRef) { ff2SfxEmuRef = Module.allocate(1, 'i32', Module.ALLOC_STATIC); }
  if (Module.ccall('gme_open_data', 'number', ['array', 'number', 'number', 'number'],
      [ff2NsfData, ff2NsfData.length, ff2SfxEmuRef, audioCtx.sampleRate]) !== 0) { fallback(); return; }
  ff2SfxEmu = Module.getValue(ff2SfxEmuRef, 'i32');
  // NOT gme_ignore_silence: these tracks are mostly silence by design and the
  // sound is over in a fifth of a second.
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [ff2SfxEmu, track]) !== 0) {
    _stopFF2Sfx(); fallback(); return;
  }

  if (!ff2SfxBuf) { ff2SfxBuf = Module._malloc(SFX_BUF_SIZE * 2 * 2); }
  ff2SfxNode = audioCtx.createScriptProcessor(SFX_BUF_SIZE, 0, 2);
  ff2SfxNode.onaudioprocess = (e) => {
    const ch0 = e.outputBuffer.getChannelData(0);
    const ch1 = e.outputBuffer.getChannelData(1);
    if (!ff2SfxEmu) { ch0.fill(0); ch1.fill(0); return; }
    Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [ff2SfxEmu, SFX_BUF_SIZE * 2, ff2SfxBuf]);
    const base = ff2SfxBuf >> 1;
    for (let i = 0; i < SFX_BUF_SIZE; i++) {
      ch0[i] = Module.HEAP16[base + i * 2]     / 32768;
      ch1[i] = Module.HEAP16[base + i * 2 + 1] / 32768;
    }
  };
  if (!ff2SfxGainNode) { ff2SfxGainNode = audioCtx.createGain(); ff2SfxGainNode.connect(_sfxMaster()); }
  ff2SfxGainNode.gain.setValueAtTime(0.9, audioCtx.currentTime);
  ff2SfxNode.connect(ff2SfxGainNode);
  ff2SfxStopTimer = setTimeout(_stopFF2Sfx, FF2_SFX_MS);
}

function _stopFF2Sfx() {
  if (ff2SfxStopTimer) { clearTimeout(ff2SfxStopTimer); ff2SfxStopTimer = null; }
  if (ff2SfxNode) { ff2SfxNode.disconnect(); ff2SfxNode = null; }
  if (ff2SfxEmu) { Module.ccall('gme_delete', 'number', ['number'], [ff2SfxEmu]); ff2SfxEmu = null; }
}

function _stopChime() {
  if (chimeStopTimer) { clearTimeout(chimeStopTimer); chimeStopTimer = null; }
  if (chimeNode) { chimeNode.disconnect(); chimeNode = null; }
  if (chimeEmu) { Module.ccall('gme_delete', 'number', ['number'], [chimeEmu]); chimeEmu = null; }
}

export function clearMusicStash() {
  if (stashedNode) { stashedNode.disconnect(); stashedNode = null; }
  if (stashedEmu) { Module.ccall('gme_delete', 'number', ['number'], [stashedEmu]); stashedEmu = null; }
  stashedTrack = -1;
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
    node.connect(_musicMaster());
  }
  stashedEmu = null;
  stashedNode = null;
  stashedTrack = -1;
}

// Party-join celebration jingle (v1.7.722). Pauses the current map music,
// plays FF3 NSF track 44, then resumes after 5 s. Guarded so concurrent
// joins (rapid invite accepts during a party recovery) don't pile up
// pause/resume calls (the second pauseMusic would stash over the first,
// losing the original map music when resume fires). Once the jingle is
// already playing, additional triggers are ignored until the timer
// completes.
const PARTY_JOIN_TRACK = 44;             // FF3 NSF track 44
const PARTY_JOIN_HOLD_MS = 5000;
let _partyJoinTimer = null;
export function playPartyJoinJingle() {
  if (!nsfData) return;                  // ROM not loaded yet (boot)
  if (_partyJoinTimer) return;           // already playing
  pauseMusic();
  playTrack(PARTY_JOIN_TRACK);
  _partyJoinTimer = setTimeout(() => {
    _partyJoinTimer = null;
    resumeMusic();
  }, PARTY_JOIN_HOLD_MS);
}
