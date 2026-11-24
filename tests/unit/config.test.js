'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');

test('config exposes safe defaults for every required setting', () => {
  assert.equal(typeof config.PORT, 'number');
  assert.ok(config.PORT > 0);
  assert.equal(typeof config.DATA_DIR, 'string');
  assert.ok(config.DATA_DIR.length > 0);
  assert.equal(typeof config.ARCHIVE_DIR, 'string');
  assert.ok(config.ARCHIVE_DIR.length > 0);
  assert.equal(typeof config.DOCTOR_PIN, 'string');
  assert.equal(typeof config.PHARMACY_PIN, 'string');
});
