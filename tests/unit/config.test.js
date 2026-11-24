'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CONFIG_PATH = require.resolve('../../src/config');
const KEYS = ['PORT', 'DATA_DIR', 'ARCHIVE_DIR', 'DOCTOR_PIN', 'PHARMACY_PIN'];

// Load a fresh copy of config.js with the given env vars set (others unset).
function loadConfig(env = {}) {
  const saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  delete require.cache[CONFIG_PATH];
  try {
    return require(CONFIG_PATH);
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[CONFIG_PATH];
  }
}

test('config exposes safe defaults for every required setting', () => {
  const config = loadConfig();
  assert.equal(config.PORT, 3000);
  assert.ok(path.isAbsolute(config.DATA_DIR));
  assert.equal(config.ARCHIVE_DIR, path.join(config.DATA_DIR, 'archive'));
  assert.equal(typeof config.DOCTOR_PIN, 'string');
  assert.equal(typeof config.PHARMACY_PIN, 'string');
});

test('config reads every setting from environment variables', () => {
  const config = loadConfig({
    PORT: '4321',
    DATA_DIR: path.join('fake', 'data'),
    ARCHIVE_DIR: path.join('fake', 'archive'),
    DOCTOR_PIN: '1111',
    PHARMACY_PIN: '2222'
  });
  assert.equal(config.PORT, 4321);
  assert.equal(config.DATA_DIR, path.join('fake', 'data'));
  assert.equal(config.ARCHIVE_DIR, path.join('fake', 'archive'));
  assert.equal(config.DOCTOR_PIN, '1111');
  assert.equal(config.PHARMACY_PIN, '2222');
});

test('config falls back to the default port when PORT is not a number', () => {
  assert.equal(loadConfig({ PORT: 'abc' }).PORT, 3000);
});
