// NSF Builder — assembles a valid NSF file from FF3 ROM data at runtime
//
// Extracts the sound engine (bank $36) and song data banks ($37,$38,$39,$09),
// patches 2 MMC3 bank-switching instructions to use NSF-style registers,
// adds a small 6502 trampoline + INIT/PLAY stub, and writes the NSF header.
//
// The resulting ~45KB Uint8Array can be fed directly to libgme for playback.

// ROM offsets for 8KB PRG banks (bank_number * 0x2000 + 0x10 iNES header)
const BANK_36 = 0x06C010; // Sound engine code
const BANK_37 = 0x06E010; // Songs $00-$18
const BANK_38 = 0x070010; // Songs $19-$2A
const BANK_39 = 0x072010; // Songs $2B-$3A
const BANK_09 = 0x012010; // Songs $3B-$40
const BANK_SIZE = 0x2000;  // 8KB per bank

const PAGE_SIZE = 0x1000;  // 4KB NSF page
const HEADER_SIZE = 128;
const TOTAL_PAGES = 11;    // Pages 0-10
const TOTAL_SONGS = 192;   // Song IDs $00-$40 + SFX IDs $41-$BF (covers up to SFX $7E)

export function buildNSF(romData) {
  const nsf = new Uint8Array(HEADER_SIZE + TOTAL_PAGES * PAGE_SIZE);

  // --- Header (128 bytes) ---
  writeHeader(nsf);

  // --- Bank data (pages 0-9: ROM banks, page 10: custom stubs) ---

  // Pages 0-1: Bank $36 (sound engine) → NES $8000-$9FFF
  const engine = new Uint8Array(romData.slice(BANK_36, BANK_36 + BANK_SIZE));
  patchEngine(engine);
  nsf.set(engine.subarray(0, PAGE_SIZE), HEADER_SIZE + 0 * PAGE_SIZE);
  nsf.set(engine.subarray(PAGE_SIZE, BANK_SIZE), HEADER_SIZE + 1 * PAGE_SIZE);

  // Pages 2-3: Bank $37 (songs $00-$18) → NES $A000-$BFFF
  copyBank(nsf, romData, BANK_37, 2);

  // Pages 4-5: Bank $38 (songs $19-$2A)
  copyBank(nsf, romData, BANK_38, 4);

  // Pages 6-7: Bank $39 (songs $2B-$3A)
  copyBank(nsf, romData, BANK_39, 6);

  // Pages 8-9: Bank $09 (songs $3B-$40)
  copyBank(nsf, romData, BANK_09, 8);

  // Page 10: Custom 6502 stubs → NES $C000-$CFFF
  writeCustomCode(nsf, HEADER_SIZE + 10 * PAGE_SIZE);

  return nsf;
}

function writeHeader(nsf) {
  // Magic: "NESM" + $1A
  nsf[0x00] = 0x4E; // N
  nsf[0x01] = 0x45; // E
  nsf[0x02] = 0x53; // S
  nsf[0x03] = 0x4D; // M
  nsf[0x04] = 0x1A;

  nsf[0x05] = 0x01; // Version
  nsf[0x06] = TOTAL_SONGS;
  nsf[0x07] = 0x01; // Starting song (1-based)

  // Load address: $8000 (little-endian)
  nsf[0x08] = 0x00;
  nsf[0x09] = 0x80;

  // INIT address: $C040
  nsf[0x0A] = 0x40;
  nsf[0x0B] = 0xC0;

  // PLAY address: $C061
  nsf[0x0C] = 0x61;
  nsf[0x0D] = 0xC0;

  // Song name (32 bytes at $0E)
  writeString(nsf, 0x0E, 'Final Fantasy III', 32);

  // Artist (32 bytes at $2E)
  writeString(nsf, 0x2E, 'Nobuo Uematsu', 32);

  // Copyright (32 bytes at $4E)
  writeString(nsf, 0x4E, '1990 Square', 32);

  // NTSC speed: 16666 microseconds (little-endian)
  nsf[0x6E] = 0x1A;
  nsf[0x6F] = 0x41;

  // Bankswitch init values ($70-$77): 8 pages for $8000-$FFFF in 4KB chunks
  nsf[0x70] = 0;  // $8000-$8FFF → page 0 (engine low)
  nsf[0x71] = 1;  // $9000-$9FFF → page 1 (engine high)
  nsf[0x72] = 2;  // $A000-$AFFF → page 2 (bank $37 low, default)
  nsf[0x73] = 3;  // $B000-$BFFF → page 3 (bank $37 high, default)
  nsf[0x74] = 10; // $C000-$CFFF → page 10 (custom stubs)
  nsf[0x75] = 0;  // $D000-$DFFF → unused
  nsf[0x76] = 0;  // $E000-$EFFF → unused
  nsf[0x77] = 0;  // $F000-$FFFF → unused

  // PAL speed
  nsf[0x78] = 0x1D;
  nsf[0x79] = 0x4E;

  nsf[0x7A] = 0x00; // NTSC
  nsf[0x7B] = 0x00; // No expansion audio
}

function writeString(buf, offset, str, maxLen) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < str.length ? str.charCodeAt(i) : 0;
  }
}

function copyBank(nsf, romData, romOffset, startPage) {
  const bankData = new Uint8Array(romData.slice(romOffset, romOffset + BANK_SIZE));
  nsf.set(bankData.subarray(0, PAGE_SIZE), HEADER_SIZE + startPage * PAGE_SIZE);
  nsf.set(bankData.subarray(PAGE_SIZE, BANK_SIZE), HEADER_SIZE + (startPage + 1) * PAGE_SIZE);
}

function patchEngine(engine) {
  // Patch 1: NOP out "LDA #$07; STA $8000" at NES $899F (bank offset $099F)
  // Original: A9 07 8D 00 80 → EA EA EA EA EA (5 NOPs)
  engine[0x099F] = 0xEA;
  engine[0x09A0] = 0xEA;
  engine[0x09A1] = 0xEA;
  engine[0x09A2] = 0xEA;
  engine[0x09A3] = 0xEA;

  // Patch 2: Replace "STA $8001" with "JSR $C000" at NES $89BB (bank offset $09BB)
  // Original: 8D 01 80 → 20 00 C0
  engine[0x09BB] = 0x20; // JSR
  engine[0x09BC] = 0x00; // $C000 low
  engine[0x09BD] = 0xC0; // $C000 high
}

function writeCustomCode(nsf, pageOffset) {
  // All code lives in page 10, mapped at NES $C000-$CFFF
  const p = pageOffset;

  // --- Bankswitch trampoline at $C000 ---
  // Input: A = original bank number ($37, $38, $39, or $09)
  // Output: Sets NSF banking registers $5FFA/$5FFB to correct page pair

  // CMP #$37; BEQ handler_37
  nsf[p + 0x00] = 0xC9; nsf[p + 0x01] = 0x37;
  nsf[p + 0x02] = 0xF0; nsf[p + 0x03] = 0x0D; // BEQ $C011

  // CMP #$38; BEQ handler_38
  nsf[p + 0x04] = 0xC9; nsf[p + 0x05] = 0x38;
  nsf[p + 0x06] = 0xF0; nsf[p + 0x07] = 0x14; // BEQ $C01C

  // CMP #$39; BEQ handler_39
  nsf[p + 0x08] = 0xC9; nsf[p + 0x09] = 0x39;
  nsf[p + 0x0A] = 0xF0; nsf[p + 0x0B] = 0x1B; // BEQ $C027

  // CMP #$09; BEQ handler_09
  nsf[p + 0x0C] = 0xC9; nsf[p + 0x0D] = 0x09;
  nsf[p + 0x0E] = 0xF0; nsf[p + 0x0F] = 0x22; // BEQ $C032

  // RTS (fallthrough for unknown bank)
  nsf[p + 0x10] = 0x60;

  // handler_37 at $C011: pages 2, 3
  writeHandler(nsf, p + 0x11, 2, 3);

  // handler_38 at $C01C: pages 4, 5
  writeHandler(nsf, p + 0x1C, 4, 5);

  // handler_39 at $C027: pages 6, 7
  writeHandler(nsf, p + 0x27, 6, 7);

  // handler_09 at $C032: pages 8, 9
  writeHandler(nsf, p + 0x32, 8, 9);

  // --- INIT stub at $C040 ---
  // Called by NSF player with track number in A register.
  // Tracks $00-$40 = songs (existing path), $41-$80 = SFX (writes $7F49).
  let i = p + 0x40;
  nsf[i++] = 0x48;             // PHA — save track number
  nsf[i++] = 0x20;             // JSR $8000 — init sound engine
  nsf[i++] = 0x00;
  nsf[i++] = 0x80;
  nsf[i++] = 0x68;             // PLA — restore track number
  nsf[i++] = 0xC9;             // CMP #$41 — SFX track?
  nsf[i++] = 0x41;
  nsf[i++] = 0xB0;             // BCS sfx_init (branch if >= $41)
  nsf[i++] = 0x0F;             // +15 bytes forward → sfx_init at $C058
  // --- song path ---
  nsf[i++] = 0x8D;             // STA $7F43 — set song ID
  nsf[i++] = 0x43;
  nsf[i++] = 0x7F;
  nsf[i++] = 0xA9;             // LDA #$80
  nsf[i++] = 0x80;
  nsf[i++] = 0x8D;             // STA $7F42 — enable music
  nsf[i++] = 0x42;
  nsf[i++] = 0x7F;
  nsf[i++] = 0x20;             // JSR $899F — switch to song bank
  nsf[i++] = 0x9F;
  nsf[i++] = 0x89;
  nsf[i++] = 0x20;             // JSR $89C3 — initialize song channels
  nsf[i++] = 0xC3;
  nsf[i++] = 0x89;
  nsf[i++] = 0x60;             // RTS
  // --- sfx_init (at $C040 + 24 = $C058) ---
  nsf[i++] = 0x38;             // SEC
  nsf[i++] = 0xE9;             // SBC #$41 — convert to 0-based SFX ID
  nsf[i++] = 0x41;
  nsf[i++] = 0x09;             // ORA #$80 — set bit 7 (init flag)
  nsf[i++] = 0x80;
  nsf[i++] = 0x8D;             // STA $7F49 — trigger SFX
  nsf[i++] = 0x49;
  nsf[i++] = 0x7F;
  nsf[i++] = 0x60;             // RTS

  // --- PLAY stub at $C061 ---
  nsf[i++] = 0x4C;             // JMP $8003 — update sound
  nsf[i++] = 0x03;
  nsf[i++] = 0x80;
}

function writeHandler(nsf, offset, pageLo, pageHi) {
  // LDA #pageLo; STA $5FFA; LDA #pageHi; STA $5FFB; RTS
  nsf[offset + 0] = 0xA9; nsf[offset + 1] = pageLo;  // LDA #pageLo
  nsf[offset + 2] = 0x8D; nsf[offset + 3] = 0xFA; nsf[offset + 4] = 0x5F; // STA $5FFA
  nsf[offset + 5] = 0xA9; nsf[offset + 6] = pageHi;  // LDA #pageHi
  nsf[offset + 7] = 0x8D; nsf[offset + 8] = 0xFB; nsf[offset + 9] = 0x5F; // STA $5FFB
  nsf[offset + 10] = 0x60; // RTS
}
