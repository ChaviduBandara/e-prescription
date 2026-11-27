// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defineConfig, devices } = require('@playwright/test');

// Playwright evaluates this file in the runner and again in every worker.
// The runner picks the port and temp dirs once and stores them in env vars,
// which the workers inherit, so every process agrees on the same server.
if (!process.env.E2E_PORT) {
  const findFreePort =
    "const s=require('net').createServer();" +
    "s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  process.env.E2E_PORT = execFileSync(process.execPath, ['-e', findFreePort]).toString().trim();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e-prescription-e2e-'));
  process.env.E2E_TMP_ROOT = tmpRoot; // deleted after the run (global-teardown.js)
  process.env.E2E_DATA_DIR = path.join(tmpRoot, 'data');
  process.env.E2E_ARCHIVE_DIR = path.join(tmpRoot, 'archive');
  fs.mkdirSync(process.env.E2E_DATA_DIR, { recursive: true });
  fs.mkdirSync(process.env.E2E_ARCHIVE_DIR, { recursive: true });
}

const BASE_URL = `http://localhost:${process.env.E2E_PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  // One server and one open session are shared by every test and both
  // browsers, so tests run one at a time to keep sessions from colliding.
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalTeardown: require.resolve('./tests/e2e/global-teardown.js'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    command: 'node tests/e2e/web-server.js',
    url: `${BASE_URL}/health`,
    // Always start a fresh server with temp dirs; never reuse a dev server
    // that might be pointing at the real database.
    reuseExistingServer: false,
    env: {
      PORT: process.env.E2E_PORT,
      E2E_TMP_ROOT: process.env.E2E_TMP_ROOT,
      DATA_DIR: process.env.E2E_DATA_DIR,
      ARCHIVE_DIR: process.env.E2E_ARCHIVE_DIR,
      // Fake PINs for tests only (tests/e2e/fixtures.js PINS).
      DOCTOR_PIN: '2468',
      PHARMACY_PIN: '1357'
    }
  }
});
