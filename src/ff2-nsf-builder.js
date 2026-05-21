// FF2 (J) NSF Builder — assembles an NSF from the standalone FF2 Famicom ROM.
//
// FF2's entire music engine + song table + song data live in 16KB bank $0D
// ($8000-$BFFF, self-contained — verified no cross-bank calls in the play
// path). Addresses from the everything8215/ff2 disassembly + rom-map:
//   PLAY (per-frame "update music"): $9800
//   INIT (load song by id): $9867 — id in zero page $E0 (raw index 0-30)
//   song pointer table: $9E0D (31 entries)   current song: $6F25
//
// Same single-bank shape as ff1-nsf-builder.js. Build at runtime from the
// user's ROM (never distribute the rip).

const PAGE_SIZE = 0x1000;  // 4KB NSF page
const HEADER_SIZE = 128;
const TOTAL_PAGES = 5;     // 4 pages for bank $0D + 1 page for stubs
const TOTAL_SONGS = 31;    // FF2 song pointer table has 31 entries
const BANK_0D_OFF = 0x0D * 0x4000 + 0x10;  // ROM offset for bank $0D (+ iNES header)

export function buildFF2NSF(romData) {
  const nsf = new Uint8Array(HEADER_SIZE + TOTAL_PAGES * PAGE_SIZE);

  // --- Header ---
  nsf[0x00] = 0x4E; nsf[0x01] = 0x45; nsf[0x02] = 0x53; nsf[0x03] = 0x4D; nsf[0x04] = 0x1A;
  nsf[0x05] = 0x01; // version
  nsf[0x06] = TOTAL_SONGS;
  nsf[0x07] = 0x01; // starting song (1-based)

  // Load address: $8000
  nsf[0x08] = 0x00; nsf[0x09] = 0x80;
  // INIT address: $C000 (our stub)
  nsf[0x0A] = 0x00; nsf[0x0B] = 0xC0;
  // PLAY address: $C020 (our stub)
  nsf[0x0C] = 0x20; nsf[0x0D] = 0xC0;

  // Song name / artist / copyright
  writeStr(nsf, 0x0E, 'Final Fantasy II', 32);
  writeStr(nsf, 0x2E, 'Nobuo Uematsu', 32);
  writeStr(nsf, 0x4E, '1988 Square', 32);

  // NTSC speed: 16666 µs
  nsf[0x6E] = 0x1A; nsf[0x6F] = 0x41;

  // Bankswitch init: pages 0-3 for $8000-$BFFF, page 4 for $C000
  nsf[0x70] = 0; nsf[0x71] = 1; nsf[0x72] = 2; nsf[0x73] = 3;
  nsf[0x74] = 4; nsf[0x75] = 0; nsf[0x76] = 0; nsf[0x77] = 0;

  // PAL speed
  nsf[0x78] = 0x1D; nsf[0x79] = 0x4E;
  nsf[0x7A] = 0x00; // NTSC
  nsf[0x7B] = 0x00; // no expansion audio

  // --- Bank $0D data (pages 0-3, 16KB at $8000-$BFFF) ---
  const bankData = new Uint8Array(romData.slice(BANK_0D_OFF, BANK_0D_OFF + 0x4000));
  for (let p = 0; p < 4; p++) {
    nsf.set(bankData.subarray(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), HEADER_SIZE + p * PAGE_SIZE);
  }

  // --- Custom stubs (page 4, at $C000) ---
  const stubOff = HEADER_SIZE + 4 * PAGE_SIZE;

  // INIT at $C000: A = track number (0-based, NSF player passes it in A).
  // FF2's init-song ($9867) reads the raw song id from zero page $E0, so
  // store A there and call it directly (forces a load even if it matches the
  // current song — important for track 0, where current-song defaults to 0).
  let i = stubOff;
  nsf[i++] = 0x85;       // STA $E0
  nsf[i++] = 0xE0;
  nsf[i++] = 0x20;       // JSR $9867 (init song)
  nsf[i++] = 0x67;
  nsf[i++] = 0x98;
  nsf[i++] = 0x60;       // RTS

  // Pad to $C020
  while (i < stubOff + 0x20) nsf[i++] = 0xEA; // NOP

  // PLAY at $C020: JMP $9800 (update music)
  nsf[i++] = 0x4C;       // JMP $9800
  nsf[i++] = 0x00;
  nsf[i++] = 0x98;

  return nsf;
}

function writeStr(buf, off, str, maxLen) {
  for (let i = 0; i < maxLen; i++) buf[off + i] = i < str.length ? str.charCodeAt(i) : 0;
}
