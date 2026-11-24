// Prescription queries. createTypedPrescription commits to SQLite before it
// returns, so callers can ack and broadcast straight after (hard rule 3).
'use strict';

const { nextPrescriptionId } = require('./ids');
const { getOpenSession } = require('./sessions');

function toPrescription(row) {
  const body = row.typed_body ? JSON.parse(row.typed_body) : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    patientRef: row.patient_ref,
    kind: row.kind,
    lines: body ? body.lines : [],
    status: row.status,
    createdAt: row.created_at,
    dispensedAt: row.dispensed_at
  };
}

class NoOpenSessionError extends Error {
  constructor() {
    super('No open session. Tap Start Session first.');
  }
}

// `value` must already be validated (see validation.js).
function createTypedPrescription(db, value, now = new Date()) {
  return db.transaction(() => {
    const session = getOpenSession(db);
    if (!session) throw new NoOpenSessionError();
    const id = nextPrescriptionId(db, now);
    db.prepare(
      `INSERT INTO prescriptions
         (id, session_id, patient_ref, kind, typed_body, status, created_at)
       VALUES (?, ?, ?, 'typed', ?, 'sent', ?)`
    ).run(id, session.id, value.patientRef, JSON.stringify({ lines: value.lines }), now.toISOString());
    return getPrescription(db, id);
  }).immediate();
}

function getPrescription(db, id) {
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  return row ? toPrescription(row) : null;
}

// Arrival order: oldest first.
function listForSession(db, sessionId) {
  return db
    .prepare('SELECT * FROM prescriptions WHERE session_id = ? ORDER BY created_at, id')
    .all(sessionId)
    .map(toPrescription);
}

module.exports = {
  createTypedPrescription,
  getPrescription,
  listForSession,
  NoOpenSessionError
};
