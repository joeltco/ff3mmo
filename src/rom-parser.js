// ROM Parser — reads iNES header, validates, extracts PRG-ROM

const INES_MAGIC = [0x4E, 0x45, 0x53, 0x1A]; // "NES\x1a"
const HEADER_SIZE = 16;
const PRG_BANK_SIZE = 16384; // 16KB per PRG bank
const CHR_BANK_SIZE = 8192;  // 8KB per CHR bank

export function parseROM(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);

  if (data.length < HEADER_SIZE) {
    throw new Error('File too small to be a valid iNES ROM');
  }

  // Validate magic number
  for (let i = 0; i < 4; i++) {
    if (data[i] !== INES_MAGIC[i]) {
      throw new Error('Invalid iNES header — missing NES magic bytes');
    }
  }

  const prgBanks = data[4];
  const chrBanks = data[5];
  const flags6 = data[6];
  const flags7 = data[7];
  const mapper = ((flags6 >> 4) & 0x0F) | (flags7 & 0xF0);

  const prgSize = prgBanks * PRG_BANK_SIZE;
  const chrSize = chrBanks * CHR_BANK_SIZE;

  // FF3 uses mapper 4 (MMC3) with CHR-RAM (chrBanks = 0)
  const hasTrainer = !!(flags6 & 0x04);
  const trainerSize = hasTrainer ? 512 : 0;

  const prgStart = HEADER_SIZE + trainerSize;
  const prgEnd = prgStart + prgSize;

  if (data.length < prgEnd) {
    throw new Error(`ROM file too small: expected at least ${prgEnd} bytes, got ${data.length}`);
  }

  const prgROM = data.slice(prgStart, prgEnd);

  return {
    prgBanks,
    chrBanks,
    mapper,
    prgSize,
    chrSize,
    hasTrainer,
    prgROM,
    raw: data,
  };
}

// Get bytes at a file offset (including the 16-byte iNES header)
export function getBytesAt(rom, fileOffset, length) {
  return rom.raw.slice(fileOffset, fileOffset + length);
}
