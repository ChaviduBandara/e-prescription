// Session queries. Only one session is open at a time (enforced by a
// unique index in db.js).
'use strict';

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    archiveFile: row.archive_file,
    archivedAt: row.archived_at
  };
}

function getOpenSession(db) {
  return toSession(db.prepare(`SELECT * FROM sessions WHERE status = 'open'`).get());
}

function getSession(db, id) {
  return toSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
}

// Opens a new session, or returns the one already open (so a double tap on
// Start Session, or two tablets, never fails or opens two).
function startSession(db, now = new Date()) {
  return db.transaction(() => {
    const existing = getOpenSession(db);
    if (existing) return { session: existing, created: false };
    const info = db
      .prepare(`INSERT INTO sessions (started_at, status) VALUES (?, 'open')`)
      .run(now.toISOString());
    return { session: getSession(db, info.lastInsertRowid), created: true };
  }).immediate();
}

module.exports = { getOpenSession, getSession, startSession };
