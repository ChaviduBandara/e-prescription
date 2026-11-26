// Express + Socket.IO entry point.
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./src/config');
const { openDb } = require('./src/db');
const { createApiRouter } = require('./src/api');
const { registerSocketHandlers } = require('./src/socket');
const { MAX_IMAGE_BYTES } = require('./src/png');
const { createAuth, loadSecret, pinProblems } = require('./src/auth');
const { createArchiver, removeStalePartials } = require('./src/archive');

// Builds the app without listening, so tests can use a temp DATA_DIR.
// `pins`, `authOptions` (e.g. a short lockout) and `archiveOptions` (e.g.
// short retry delays) are for tests.
function createServer({
  dataDir = config.DATA_DIR,
  archiveDir = config.ARCHIVE_DIR,
  clinicName = config.CLINIC_NAME,
  pins,
  authOptions = {},
  archiveOptions = {}
} = {}) {
  pins = pins || { doctor: config.DOCTOR_PIN, pharmacy: config.PHARMACY_PIN };
  // Checked before anything opens, so a bad setup leaves nothing half-started.
  const problems = pinProblems(pins);
  if (problems.length) throw new Error(`PIN setup: ${problems.join(' ')} Set them before starting the server (see README).`);
  const db = openDb(dataDir);
  let io = null; // set below; the archiver reports failures to the screens
  const archiver = createArchiver(
    db,
    { dataDir, archiveDir, clinicName },
    { onChange: (status) => io && io.emit('archive:status', status), ...archiveOptions }
  );
  const auth = createAuth({
    pins,
    secret: loadSecret(dataDir, config.SESSION_SECRET),
    ...authOptions
  });
  const app = express();

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api', createApiRouter(db, { dataDir, auth, archiver }));

  const httpServer = http.createServer(app);
  // The browser client is served from public/vendor/, not by Socket.IO.
  io = new Server(httpServer, {
    serveClient: false,
    // Room for a handwriting PNG at the size limit plus margin, so an
    // oversized drawing gets a clear error ack instead of a dropped
    // connection. The PNG itself is checked in validation.js.
    maxHttpBufferSize: MAX_IMAGE_BYTES + 1024 * 1024,
    // A tablet that loses WiFi goes silent rather than disconnecting. With
    // a ping every 10 s and 5 s to answer, both ends notice within ~15 s
    // (the default is up to 45 s), so "Connected" is never shown for long
    // over a dead link and a waiting send goes as soon as WiFi is back.
    pingInterval: 10_000,
    pingTimeout: 5_000
  });
  registerSocketHandlers(io, db, { dataDir, auth, archiver });

  // Stops taking connections, lets a PDF being written finish, then closes
  // the database (which also folds the WAL into the main file). Safe to
  // call more than once.
  let closing = null;
  function close() {
    closing =
      closing ||
      (async () => {
        archiver.close();
        await new Promise((resolve) => io.close(() => resolve()));
        await archiver.idle();
        db.close();
      })();
    return closing;
  }

  return { app, httpServer, io, db, archiver, close, archiveDir };
}

// Starts listening. Resolves once the port is bound; `port: 0` picks a free one.
async function start({ port = config.PORT, ...options } = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(port, resolve);
  });
  server.port = server.httpServer.address().port;
  // After a crash: tidy half-written PDFs, then archive sessions that
  // closed without one. SQLite recovers its own WAL when it opens.
  for (const name of removeStalePartials(server.archiveDir)) console.log(`removed unfinished archive file ${name}`);
  server.archiver.archivePending();
  return server;
}

// Ctrl+C, a Windows service stop (NSSM sends Ctrl+C) or SIGTERM: close
// cleanly and exit. A second signal while closing is ignored; if closing
// hangs, exit anyway after `timeoutMs`. `proc` and `exit` are for tests.
function handleShutdown(server, { proc = process, exit = (code) => process.exit(code), timeoutMs = 10_000 } = {}) {
  let stopping = false;
  async function onSignal(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    const force = setTimeout(() => {
      console.error('Shutdown took too long; exiting now.');
      exit(1);
    }, timeoutMs);
    force.unref();
    try {
      await server.close();
      console.log('Shut down cleanly.');
      exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err.message);
      exit(1);
    } finally {
      clearTimeout(force);
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) proc.on(signal, onSignal);
  return onSignal;
}

if (require.main === module) {
  if (config.DEVELOPMENT) {
    for (const name of ['DOCTOR_PIN', 'PHARMACY_PIN']) {
      if (!process.env[name]) console.warn(`Development mode: ${name} is not set; using the development default.`);
    }
  }
  start()
    .then((server) => {
      handleShutdown(server);
      console.log(`e-Prescription server listening on port ${server.port}`);
    })
    .catch((err) => {
      console.error('Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { createServer, start, handleShutdown };
