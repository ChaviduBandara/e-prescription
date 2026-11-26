// The server refuses to start in a state that would leave a screen open to
// anyone on the clinic WiFi (safety review, High).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('../../server');
const { tempDir } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

// Runs `node server.js` with the given PIN env and resolves { code, output }.
function runServer(dataDir, pins) {
  const env = { ...process.env, PORT: '0', DATA_DIR: dataDir, ARCHIVE_DIR: path.join(dataDir, 'archive') };
  for (const name of ['DOCTOR_PIN', 'PHARMACY_PIN', 'NODE_ENV']) delete env[name];
  Object.assign(env, pins);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

for (const [name, pins, message] of [
  ['no PINs set', {}, /DOCTOR_PIN is not set\. PHARMACY_PIN is not set\./],
  ['one PIN missing', { DOCTOR_PIN: '2468' }, /PHARMACY_PIN is not set/],
  ['the same PIN for both screens', { DOCTOR_PIN: '2468', PHARMACY_PIN: '2468' }, /must be different/]
]) {
  test(`node server.js refuses to start with ${name}, and opens nothing`, { timeout: 30_000 }, async (t) => {
    const dataDir = path.join(tempDir(t), 'data');
    const { code, output } = await runServer(dataDir, pins);
    assert.equal(code, 1, output);
    assert.match(output, /Failed to start: PIN setup:/);
    assert.match(output, message);
    assert.doesNotMatch(output, /listening/);
    assert.equal(fs.existsSync(path.join(dataDir, 'e-prescription.db')), false, 'no database was created');
  });
}

test('createServer refuses unsafe PINs too (any entry point)', (t) => {
  // A temp folder even here, so a broken check can never touch data/.
  const dataDir = path.join(tempDir(t), 'data');
  assert.throws(() => createServer({ dataDir, archiveDir: path.join(dataDir, 'archive'), pins: { doctor: '', pharmacy: '' } }), /PIN setup/);
  assert.equal(fs.existsSync(dataDir), false);
});
