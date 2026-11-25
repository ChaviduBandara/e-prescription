// Shared helpers for node:test suites. Every test uses its own temp
// DATA_DIR so nothing ever touches data/.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { openDb } = require('../src/db');

// Note: node:test runs t.after hooks in the order they were registered,
// so anything holding files open must be closed inside the same hook,
// before the folder is removed.
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e-prescription-test-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// A temp folder that is removed after the test.
function tempDir(t) {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  return dir;
}

// A fresh database, closed and then removed after the test.
function tempDb(t) {
  const dir = makeTempDir();
  const db = openDb(dir);
  t.after(() => {
    if (db.open) db.close();
    removeDir(dir);
  });
  return { db, dir };
}

// Obviously fake data only (CLAUDE.md hard rule 5).
function fakeTyped(overrides = {}) {
  return {
    patientRef: 'TOKEN-001',
    lines: [{ medicine: 'Test Medicine 10mg', dosage: '1 tablet', instructions: 'Twice daily after meals' }],
    ...overrides
  };
}

// A small RGBA PNG, built here so tests need no binary fixtures. With
// `blank: true` every pixel is transparent, like an untouched canvas.
// `filter` is the PNG filter type byte written at the start of each row.
function makePng({ width = 40, height = 20, blank = false, filter = 0, interlace = 0 } = {}) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) raw[y * (rowBytes + 1)] = filter;
  if (!blank) {
    // An opaque black diagonal "stroke".
    for (let i = 0; i < Math.min(width, height); i++) {
      raw.writeUInt32BE(0x000000ff, i * (rowBytes + 1) + 1 + i * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, interlace], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function fakeHandwritten(overrides = {}) {
  return { kind: 'handwritten', patientRef: 'TOKEN-001', image: makePng(), ...overrides };
}

module.exports = { makeTempDir, removeDir, tempDir, tempDb, fakeTyped, makePng, pngChunk, fakeHandwritten };
