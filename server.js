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
const { createAuth, loadSecret } = require('./src/auth');

// Builds the app without listening, so tests can use a temp DATA_DIR.
// `pins` and `authOptions` (e.g. a short lockout) are for tests.
function createServer({ dataDir = config.DATA_DIR, pins, authOptions = {} } = {}) {
  const db = openDb(dataDir);
  const auth = createAuth({
    pins: pins || { doctor: config.DOCTOR_PIN, pharmacy: config.PHARMACY_PIN },
    secret: loadSecret(dataDir, config.SESSION_SECRET),
    ...authOptions
  });
  const app = express();

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api', createApiRouter(db, { dataDir, auth }));

  const httpServer = http.createServer(app);
  // The browser client is served from public/vendor/, not by Socket.IO.
  const io = new Server(httpServer, {
    serveClient: false,
    // Room for a handwriting PNG at the size limit plus margin, so an
    // oversized drawing gets a clear error ack instead of a dropped
    // connection. The PNG itself is checked in validation.js.
    maxHttpBufferSize: MAX_IMAGE_BYTES + 1024 * 1024
  });
  registerSocketHandlers(io, db, { dataDir, auth });

  async function close() {
    await new Promise((resolve) => io.close(() => resolve()));
    db.close();
  }

  return { app, httpServer, io, db, close };
}

// Starts listening. Resolves once the port is bound; `port: 0` picks a free one.
async function start({ port = config.PORT, ...options } = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(port, resolve);
  });
  server.port = server.httpServer.address().port;
  return server;
}

if (require.main === module) {
  for (const name of ['DOCTOR_PIN', 'PHARMACY_PIN']) {
    if (!process.env[name]) console.warn(`WARNING: ${name} is not set; using the development default. Set it before clinic use.`);
  }
  start()
    .then(({ port }) => console.log(`e-Prescription server listening on port ${port}`))
    .catch((err) => {
      console.error('Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { createServer, start };
