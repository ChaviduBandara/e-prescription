// Opens the SQLite database and creates the tables from docs/SPEC.md.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  archive_file TEXT,
  archived_at  TEXT
);

-- Only one session can be open at a time.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open
  ON sessions (status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS prescriptions (
  id           TEXT PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions (id),
  patient_ref  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('typed', 'handwritten')),
  typed_body   TEXT,
  image_path   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'dispensed')),
  created_at   TEXT NOT NULL,
  dispensed_at TEXT
);

CREATE INDEX IF NOT EXISTS prescriptions_session
  ON prescriptions (session_id, created_at);
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'e-prescription.db'));
  db.pragma('journal_mode = WAL');
  // FULL: a committed prescription survives a power cut, not just a crash.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
