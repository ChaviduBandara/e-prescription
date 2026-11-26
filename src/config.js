// Central config: every setting comes from here, never a hardcoded path
// (CLAUDE.md hard rule 6). Each value falls back to a safe default so the
// app runs out of the box in development.
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envString(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const DATA_DIR = envString('DATA_DIR', path.join(ROOT, 'data'));
// `npm run dev` sets NODE_ENV=development (nodemon.json). Only then are
// there default PINs; anywhere else the server refuses to start without
// DOCTOR_PIN and PHARMACY_PIN (see src/auth.js pinProblems).
const DEVELOPMENT = process.env.NODE_ENV === 'development';

module.exports = {
  PORT: envInt('PORT', 3000),
  DATA_DIR,
  ARCHIVE_DIR: envString('ARCHIVE_DIR', path.join(DATA_DIR, 'archive')),
  DEVELOPMENT,
  DOCTOR_PIN: envString('DOCTOR_PIN', DEVELOPMENT ? '1234' : ''),
  PHARMACY_PIN: envString('PHARMACY_PIN', DEVELOPMENT ? '5678' : ''),
  // Printed at the top of every archive PDF.
  CLINIC_NAME: envString('CLINIC_NAME', 'Channeling Center'),
  // Optional. If unset, a random secret is created in DATA_DIR/session-secret.
  SESSION_SECRET: envString('SESSION_SECRET', '')
};
