// Minimal ZIP extractor for ROM uploads — no external dependency.
// ZIP entries are stored either uncompressed (method 0) or as raw DEFLATE
// (method 8), and the browser can inflate raw DEFLATE natively via
// DecompressionStream('deflate-raw'). We parse the central directory (robust
// against data descriptors, unlike trusting local-header sizes) and pull out
// the first .nes entry — or, failing that, the largest regular file.

const EOCD_SIG = 0x06054b50; // end of central directory
const CDH_SIG = 0x02014b50; // central directory file header

function looksLikeZip(bytes) {
  // Local file header magic "PK\x03\x04".
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser cannot unzip — please upload the unzipped .nes');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEOCD(view, len) {
  // EOCD is at least 22 bytes and may be followed by up to 64KB of comment.
  const minPos = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

// Returns an ArrayBuffer. If `arrayBuffer` is not a ZIP it is returned as-is,
// so this is safe to wrap around every ROM upload.
export async function extractRomFromZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (!looksLikeZip(bytes)) return arrayBuffer;

  const view = new DataView(arrayBuffer);
  const eocd = findEOCD(view, bytes.length);
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');

  const entryCount = view.getUint16(eocd + 10, true);
  let cd = view.getUint32(eocd + 16, true);

  const entries = [];
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(cd, true) !== CDH_SIG) break;
    const method = view.getUint16(cd + 10, true);
    const compSize = view.getUint32(cd + 20, true);
    const uncompSize = view.getUint32(cd + 24, true);
    const nameLen = view.getUint16(cd + 28, true);
    const extraLen = view.getUint16(cd + 30, true);
    const commentLen = view.getUint16(cd + 32, true);
    const localOffset = view.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    entries.push({ name, method, compSize, uncompSize, localOffset });
    cd += 46 + nameLen + extraLen + commentLen;
  }

  const isDir = (e) => e.name.endsWith('/');
  const nes = entries.filter((e) => !isDir(e) && /\.nes$/i.test(e.name));
  const pool = nes.length ? nes : entries.filter((e) => !isDir(e) && e.uncompSize > 0);
  if (!pool.length) throw new Error('ZIP: no ROM file inside the archive');
  pool.sort((a, b) => b.uncompSize - a.uncompSize);
  const entry = pool[0];

  // Local header lengths can differ from the central directory's — read them
  // fresh to locate where the entry's data actually starts.
  const lh = entry.localOffset;
  const lhNameLen = view.getUint16(lh + 26, true);
  const lhExtraLen = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const comp = bytes.subarray(dataStart, dataStart + entry.compSize);

  let out;
  if (entry.method === 0) out = comp.slice();
  else if (entry.method === 8) out = await inflateRaw(comp);
  else throw new Error(`ZIP: unsupported compression method ${entry.method}`);

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
