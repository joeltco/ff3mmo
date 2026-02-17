// IPS Patcher — applies IPS patches to ROM data in memory
//
// IPS format:
//   Header: "PATCH" (5 bytes)
//   Records: offset (3 bytes BE), size (2 bytes BE), data (size bytes)
//     If size=0: RLE record — run length (2 bytes BE), value (1 byte)
//   Footer: "EOF" (3 bytes)

/**
 * Apply an IPS patch to ROM data (in-place mutation).
 * @param {Uint8Array} romData — the ROM bytes to patch
 * @param {Uint8Array} ipsData — the IPS patch bytes
 * @returns {Uint8Array} the patched ROM (same buffer, mutated)
 */
export function applyIPS(romData, ipsData) {
  // Validate header
  if (ipsData[0] !== 0x50 || ipsData[1] !== 0x41 || ipsData[2] !== 0x54 ||
      ipsData[3] !== 0x43 || ipsData[4] !== 0x48) {
    throw new Error('Invalid IPS patch — missing PATCH header');
  }

  let i = 5; // skip "PATCH"

  while (i + 3 <= ipsData.length) {
    // Check for "EOF" marker
    if (ipsData[i] === 0x45 && ipsData[i + 1] === 0x4F && ipsData[i + 2] === 0x46) {
      break;
    }

    // Read offset (3 bytes big-endian)
    const offset = (ipsData[i] << 16) | (ipsData[i + 1] << 8) | ipsData[i + 2];
    i += 3;

    // Read size (2 bytes big-endian)
    const size = (ipsData[i] << 8) | ipsData[i + 1];
    i += 2;

    if (size === 0) {
      // RLE record: run length (2 bytes) + value (1 byte)
      const runLength = (ipsData[i] << 8) | ipsData[i + 1];
      const value = ipsData[i + 2];
      i += 3;

      for (let j = 0; j < runLength; j++) {
        if (offset + j < romData.length) {
          romData[offset + j] = value;
        }
      }
    } else {
      // Normal record: copy data bytes
      for (let j = 0; j < size; j++) {
        if (offset + j < romData.length) {
          romData[offset + j] = ipsData[i + j];
        }
      }
      i += size;
    }
  }

  return romData;
}
