// REST routes the screens use to load state on open and on reconnect.
'use strict';

const express = require('express');
const { getOpenSession, getSession } = require('./sessions');
const { listForSession, getImageFile } = require('./prescriptions');
const { ID_PATTERN } = require('./ids');

function createApiRouter(db, { dataDir }) {
  const router = express.Router();

  router.get('/session/current', (req, res) => {
    res.json({ session: getOpenSession(db) });
  });

  router.get('/prescriptions', (req, res) => {
    const raw = String(req.query.session ?? '');
    if (!/^[1-9]\d{0,15}$/.test(raw)) {
      return res.status(400).json({ error: 'Query parameter "session" must be a session ID.' });
    }
    const sessionId = Number(raw);
    if (!getSession(db, sessionId)) {
      return res.status(404).json({ error: 'Session not found.' });
    }
    res.json({ prescriptions: listForSession(db, sessionId) });
  });

  // The handwriting exactly as drawn: the stored PNG bytes, unchanged.
  router.get('/prescriptions/:id/image', (req, res) => {
    const file = ID_PATTERN.test(req.params.id) ? getImageFile(db, dataDir, req.params.id) : null;
    if (!file) return res.status(404).json({ error: 'Image not found.' });
    res.set({
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      // Revalidate each time (cheap 304s via ETag) rather than trust a cache.
      'Cache-Control': 'private, no-cache'
    });
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Image not found.' });
    });
  });

  return router;
}

module.exports = { createApiRouter };
