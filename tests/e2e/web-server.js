// The server for the e2e run (playwright.config.js webServer). It is the
// real server, started in-process so it can also clean up after itself:
// when global-teardown.js drops a "stop" file into the run's temp folder,
// it closes the server (database included) and deletes that folder.
// Playwright on Windows can only force-kill this process, and does so after
// the teardown, so the clean-up cannot be left to an exit handler.
'use strict';

const fs = require('fs');
const path = require('path');
const { start } = require('../../server');

const root = process.env.E2E_TMP_ROOT;
if (!root) {
  console.error('E2E_TMP_ROOT is not set (see playwright.config.js).');
  process.exit(1);
}
const STOP_FILE = path.join(root, 'stop');

start()
  .then((server) => {
    console.log(`e2e server listening on port ${server.port}`);
    const watch = setInterval(async () => {
      if (!fs.existsSync(STOP_FILE)) return;
      clearInterval(watch);
      await server.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      // Stay idle until Playwright ends this process.
      setInterval(() => {}, 60_000);
    }, 200);
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
