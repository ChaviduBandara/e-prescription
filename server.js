// Express + Socket.IO entry point (Socket.IO wiring lands in phase 2).
'use strict';

const path = require('path');
const express = require('express');
const config = require('./src/config');

function createApp() {
  const app = express();

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}

function start(port = config.PORT) {
  const app = createApp();
  return app.listen(port);
}

if (require.main === module) {
  const server = start();
  server.on('listening', () => {
    const { port } = server.address();
    console.log(`e-Prescription server listening on port ${port}`);
  });
}

module.exports = { createApp, start };
