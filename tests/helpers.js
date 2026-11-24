// Shared helpers for node:test suites. Every test uses its own temp
// DATA_DIR so nothing ever touches data/.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
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

module.exports = { makeTempDir, removeDir, tempDir, tempDb, fakeTyped };
