// The e2e run's server (tests/e2e/web-server.js) and its globalTeardown
// leave nothing behind: no temp data or archive folder, no running server.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const globalTeardown = require('../e2e/global-teardown');
const { spawnServer, killServer } = require('../server-process');
const { makeTempDir, removeDir } = require('../helpers');
const { PINS } = require('./server-harness');

test('after the e2e run the server closes and its temp data and archive folders are deleted', { timeout: 60_000 }, async (t) => {
  const root = makeTempDir();
  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(root, 'archive');
  const { child, base } = await spawnServer({ dataDir, archiveDir, pins: PINS, script: 'tests/e2e/web-server.js', env: { E2E_TMP_ROOT: root } });
  const saved = process.env.E2E_TMP_ROOT;
  t.after(async () => {
    process.env.E2E_TMP_ROOT = saved;
    await killServer(child);
    removeDir(root);
  });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'e-prescription.db')), 'a database is open in the temp folder');

  process.env.E2E_TMP_ROOT = root;
  await globalTeardown();

  assert.equal(fs.existsSync(root), false, 'temp folder deleted');
  await assert.rejects(fetch(`${base}/health`), 'the server no longer answers');
});
