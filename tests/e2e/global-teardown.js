// After every e2e run: ask the test server (web-server.js) to close and
// delete the run's temp data and archive folders, and wait until it has.
'use strict';

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function globalTeardown() {
  const root = process.env.E2E_TMP_ROOT;
  if (!root || !fs.existsSync(root)) return;
  fs.writeFileSync(path.join(root, 'stop'), '');
  const deadline = Date.now() + 15_000;
  while (fs.existsSync(root) && Date.now() < deadline) await sleep(100);
  if (!fs.existsSync(root)) return;
  // The server did not get to it (e.g. it never started).
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (err) {
    console.warn(`Could not delete the e2e temp folder ${root}: ${err.message}`);
  }
};
