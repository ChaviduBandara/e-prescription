'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { inspectPng, MAX_IMAGE_BYTES, MAX_DIMENSION } = require('../../src/png');
const { makePng, pngChunk } = require('../helpers');

const SIGNATURE = makePng().subarray(0, 8);

test('accepts a drawn PNG and reports its size', () => {
  assert.deepEqual(inspectPng(makePng({ width: 40, height: 20 })), { ok: true, width: 40, height: 20 });
});

test('a fully transparent PNG is blank, whatever the row filter', () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    assert.deepEqual(inspectPng(makePng({ blank: true, filter })), { ok: false, reason: 'blank' }, `filter ${filter}`);
  }
});

test('one drawn pixel is enough to count as a drawing', () => {
  const png = makePng({ width: 30, height: 30, blank: true });
  // Rebuild with a single non-zero alpha byte at the bottom right.
  const rowBytes = 30 * 4;
  const raw = Buffer.alloc(30 * (rowBytes + 1));
  raw[raw.length - 1] = 1;
  const ihdr = png.subarray(16, 29);
  const one = Buffer.concat([SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  assert.equal(inspectPng(one).ok, true);
});

test('rejects data that is not a PNG', () => {
  const notPng = [
    undefined,
    null,
    'iVBORw0KGgo=',
    new Uint8Array([0x89, 0x50]),
    Buffer.alloc(0),
    Buffer.from('not an image at all'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]) // JPEG header
  ];
  for (const value of notPng) assert.deepEqual(inspectPng(value), { ok: false, reason: 'invalid' }, String(value));
});

test('rejects a truncated PNG or one with a bad checksum', () => {
  const png = makePng();
  assert.equal(inspectPng(png.subarray(0, png.length - 5)).reason, 'invalid');
  const corrupt = Buffer.from(png);
  corrupt[40] ^= 0xff; // inside IDAT
  assert.equal(inspectPng(corrupt).reason, 'invalid');
  const trailing = Buffer.concat([png, Buffer.from('extra')]);
  assert.equal(inspectPng(trailing).reason, 'invalid');
});

test('rejects files over the size limit before reading them', () => {
  const big = Buffer.concat([SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.deepEqual(inspectPng(big), { ok: false, reason: 'too-large' });
});

test('rejects images that are too wide or tall', () => {
  const png = makePng();
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(MAX_DIMENSION + 1, 0);
  const huge = Buffer.concat([SIGNATURE, pngChunk('IHDR', ihdr), png.subarray(33)]);
  assert.equal(inspectPng(huge).reason, 'invalid');
});

test('rejects pixel data that does not match the header (e.g. a decompression bomb)', () => {
  const png = makePng({ width: 10, height: 10 });
  const ihdr = png.subarray(16, 29);
  const bomb = zlib.deflateSync(Buffer.alloc(10 * 1024 * 1024, 1));
  const bad = Buffer.concat([SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', bomb), pngChunk('IEND', Buffer.alloc(0))]);
  assert.equal(inspectPng(bad).reason, 'invalid');
});

test('rejects interlaced PNGs and missing IHDR or IEND', () => {
  assert.equal(inspectPng(makePng({ interlace: 1 })).reason, 'invalid');
  const png = makePng();
  const noIhdr = Buffer.concat([SIGNATURE, png.subarray(33)]);
  assert.equal(inspectPng(noIhdr).reason, 'invalid');
  const noIend = png.subarray(0, png.length - 12);
  assert.equal(inspectPng(noIend).reason, 'invalid');
});
