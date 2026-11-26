// Runs `node server.js` as a separate process, as the Windows service does,
// so tests can kill it hard (a crash or power cut) and start it again on
// the same data. Used by the integration and e2e tests.
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Resolves { child, port, base } once the server is listening. `port: 0`
// picks a free one; pass the same port again to restart in place.
function spawnServer({ dataDir, archiveDir, pins, port = 0 }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ARCHIVE_DIR: archiveDir,
      DOCTOR_PIN: pins.doctor,
      PHARMACY_PIN: pins.pharmacy
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/listening on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        const listening = Number(match[1]);
        resolve({ child, port: listening, base: `http://localhost:${listening}` });
      }
    });
    child.stderr.on('data', (chunk) => (out += chunk));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${out}`));
    });
  });
}

// SIGKILL: no shutdown code runs, like a crash or a power cut.
function killServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

module.exports = { spawnServer, killServer };
