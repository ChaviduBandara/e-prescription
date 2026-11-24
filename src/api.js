// REST routes the screens use to load state on open and on reconnect.
'use strict';

const express = require('express');
const { getOpenSession, getSession } = require('./sessions');
const { listForSession } = require('./prescriptions');

function createApiRouter(db) {
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

  return router;
}

module.exports = { createApiRouter };
