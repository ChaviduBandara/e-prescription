// Checks that a handwritten prescription is a real, non-blank PNG.
// This only reads the PNG structure and pixel bytes; it never tries to
// interpret the drawing (CLAUDE.md hard rule 1: no OCR).
'use strict';

const zlib = require('zlib');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 4096; // pixels, per side
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Samples per pixel for each PNG colour type.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Returns { ok: true, width, height } or { ok: false, reason } where
// reason is 'too-large', 'invalid' or 'blank'.
function inspectPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return fail('invalid');
  if (buf.length > MAX_IMAGE_BYTES) return fail('too-large');
  if (buf.length < SIGNATURE.length || !buf.subarray(0, 8).equals(SIGNATURE)) return fail('invalid');

  const chunks = readChunks(buf);
  if (!chunks) return fail('invalid');
  const [first, last] = [chunks[0], chunks[chunks.length - 1]];
  if (!first || first.type !== 'IHDR' || first.data.length !== 13) return fail('invalid');
  if (last.type !== 'IEND') return fail('invalid');

  const ihdr = first.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [bitDepth, colorType, , , interlace] = ihdr.subarray(8);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return fail('invalid');
  if (!(colorType in CHANNELS) || ![1, 2, 4, 8, 16].includes(bitDepth)) return fail('invalid');
  // Browsers' canvas.toBlob never interlaces; refusing it keeps the size check simple.
  if (interlace !== 0) return fail('invalid');

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const rowBytes = Math.ceil((width * CHANNELS[colorType] * bitDepth) / 8);
  const expected = height * (rowBytes + 1); // +1 filter byte per row
  let raw;
  try {
    // The cap stops a tiny compressed file from inflating to gigabytes.
    raw = zlib.inflateSync(idat, { maxOutputLength: expected });
  } catch {
    return fail('invalid');
  }
  if (raw.length !== expected) return fail('invalid');
  if (isAllZero(raw, rowBytes)) return fail('blank');

  return { ok: true, width, height };
}

// Splits the file into chunks, checking lengths and CRCs. Null if broken.
function readChunks(buf) {
  const chunks = [];
  let pos = SIGNATURE.length;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) return null;
    const length = buf.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > buf.length) return null;
    const typeAndData = buf.subarray(pos + 4, pos + 8 + length);
    if (zlib.crc32(typeAndData) !== buf.readUInt32BE(pos + 8 + length)) return null;
    chunks.push({ type: typeAndData.subarray(0, 4).toString('latin1'), data: typeAndData.subarray(4) });
    pos = end;
    if (chunks[chunks.length - 1].type === 'IEND') break;
  }
  return pos === buf.length ? chunks : null;
}

// A blank canvas exports as all-zero pixels (transparent black). Every PNG
// filter predicts zero from zero neighbours, so the filtered bytes are all
// zero exactly when the pixels are. Each row's filter-type byte is skipped.
function isAllZero(raw, rowBytes) {
  for (let i = 0; i < raw.length; i++) {
    if (i % (rowBytes + 1) === 0) continue;
    if (raw[i] !== 0) return false;
  }
  return true;
}

function fail(reason) {
  return { ok: false, reason };
}

module.exports = { inspectPng, MAX_IMAGE_BYTES, MAX_DIMENSION };
