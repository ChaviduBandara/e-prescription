// REST routes the screens use to load state on open and on reconnect.
// Only /api/auth/* is open; everything else needs a doctor or pharmacy login.
'use strict';

const express = require('express');
const { getOpenSession, getSession } = require('./sessions');
const { listForSession, getImageFile } = require('./prescriptions');
const { ID_PATTERN } = require('./ids');

function createApiRouter(db, { dataDir, auth }) {
  const router = express.Router();

  // ---- Login (open) ----
  router.post('/auth/login', express.json({ limit: '1kb' }), (req, res) => {
    const { role, pin } = req.body || {};
    const result = auth.login(role, pin, req.ip);
    if (!result.ok) {
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({ error: result.error, retryAfter: result.retryAfter });
    }
    res.set('Set-Cookie', result.cookie);
    res.json({ ok: true, role });
  });

  // Whether this browser is logged in as `role`. Never reveals the PIN.
  router.get('/auth/check', (req, res) => {
    const role = String(req.query.role || '');
    res.json({ ok: auth.rolesFromCookieHeader(req.headers.cookie, [role]).length === 1 });
  });

  // ---- Everything below needs a login. Both roles read the same state. ----
  router.use((req, res, next) => {
    const roles = auth.rolesFromCookieHeader(req.headers.cookie);
    if (roles.length === 0) return res.status(401).json({ error: 'Enter the PIN first.' });
    req.roles = roles;
    next();
  });

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
