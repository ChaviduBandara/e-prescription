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

class SessionNotOpenError extends Error {
  constructor() {
    super('This session is not open any more. The screen will reload.');
  }
}

// Closes the open session `id`. Ending one that is already closed is not an
// error (a double tap, or two screens): it returns { closed: false }.
// Prescriptions are never touched (hard rule 4).
function endSession(db, id, now = new Date()) {
  return db.transaction(() => {
    const session = getSession(db, id);
    if (!session) throw new SessionNotOpenError();
    if (session.status === 'closed') return { session, closed: false };
    db.prepare(`UPDATE sessions SET status = 'closed', ended_at = ? WHERE id = ?`).run(now.toISOString(), id);
    return { session: getSession(db, id), closed: true };
  }).immediate();
}

module.exports = { getOpenSession, getSession, startSession, endSession, SessionNotOpenError };
