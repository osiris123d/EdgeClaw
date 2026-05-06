/** Minimal ZIP (method “stored” / no compression) for Workers — no external deps. */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i])! & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(dv: DataView, offset: number, v: number): void {
  dv.setUint16(offset, v, true);
}

function writeU32(dv: DataView, offset: number, v: number): void {
  dv.setUint32(offset, v, true);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Build a ZIP archive with DEFLATE disabled (compression method 0).
 * Entry paths must be relative POSIX-style without `..` segments.
 */
export function buildStoredZip(entries: Array<{ path: string; contentUtf8: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const { path, contentUtf8 } of entries) {
    const nameBytes = encoder.encode(path);
    const data = encoder.encode(contentUtf8);
    const crc = crc32(data);
    const localSize = 30 + nameBytes.length + data.length;

    const local = new Uint8Array(localSize);
    const dv = new DataView(local.buffer);
    writeU32(dv, 0, 0x04034b50);
    writeU16(dv, 4, 20); // version needed
    writeU16(dv, 6, 0); // flags
    writeU16(dv, 8, 0); // compression = stored
    writeU16(dv, 10, 0); // mod time
    writeU16(dv, 12, 0); // mod date
    writeU32(dv, 14, crc);
    writeU32(dv, 18, data.length);
    writeU32(dv, 22, data.length);
    writeU16(dv, 26, nameBytes.length);
    writeU16(dv, 28, 0); // extra len
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);

    localChunks.push(local);

    const centralSize = 46 + nameBytes.length;
    const central = new Uint8Array(centralSize);
    const cdv = new DataView(central.buffer);
    writeU32(cdv, 0, 0x02014b50);
    writeU16(cdv, 4, 20); // version made by
    writeU16(cdv, 6, 20); // version needed
    writeU16(cdv, 8, 0);
    writeU16(cdv, 10, 0);
    writeU16(cdv, 12, 0);
    writeU16(cdv, 14, 0);
    writeU32(cdv, 16, crc);
    writeU32(cdv, 20, data.length);
    writeU32(cdv, 24, data.length);
    writeU16(cdv, 28, nameBytes.length);
    writeU16(cdv, 30, 0); // extra
    writeU16(cdv, 32, 0); // comment
    writeU16(cdv, 34, 0);
    writeU16(cdv, 36, 0);
    writeU32(cdv, 38, 0); // attrs
    writeU32(cdv, 42, offset);
    central.set(nameBytes, 46);

    centralChunks.push(central);
    offset += localSize;
  }

  const centralBytes = concatChunks(centralChunks);
  const centralDirSize = centralBytes.length;
  const centralDirOffset = offset;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  writeU32(edv, 0, 0x06054b50);
  writeU16(edv, 4, 0);
  writeU16(edv, 6, 0);
  writeU16(edv, 8, entries.length);
  writeU16(edv, 10, entries.length);
  writeU32(edv, 12, centralDirSize);
  writeU32(edv, 16, centralDirOffset);
  writeU16(edv, 20, 0);

  return concatChunks([...localChunks, centralBytes, eocd]);
}
