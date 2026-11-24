// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'e-prescription-e2e-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const ARCHIVE_DIR = path.join(TMP_ROOT, 'archive');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ],
  webServer: {
    command: 'node server.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      DATA_DIR,
      ARCHIVE_DIR
    }
  }
});
