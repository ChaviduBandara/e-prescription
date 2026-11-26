// Prescription queries. The create functions commit to SQLite (and, for
// handwriting, write the PNG to disk) before they return, so callers can
// ack and broadcast straight after (hard rule 3).
'use strict';

const fs = require('fs');
const path = require('path');
const { nextPrescriptionId } = require('./ids');
const { getOpenSession } = require('./sessions');

// Where handwriting lives, relative to DATA_DIR. The database stores this
// relative path so the data folder can be moved as a whole.
const IMAGES_SUBDIR = 'images';

function toPrescription(row) {
  const body = row.typed_body ? JSON.parse(row.typed_body) : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    patientRef: row.patient_ref,
    kind: row.kind,
    lines: body ? body.lines : [],
    // The screens get a URL, never the file path on the pharmacy PC.
    imageUrl: row.kind === 'handwritten' ? `/api/prescriptions/${encodeURIComponent(row.id)}/image` : null,
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

const INSERT = `INSERT INTO prescriptions
  (id, session_id, patient_ref, kind, typed_body, image_path, status, created_at, request_id)
  VALUES (@id, @sessionId, @patientRef, @kind, @typedBody, @imagePath, 'sent', @createdAt, @requestId)`;

// Runs `write(id)` and the insert in one write transaction, so the ID read
// and the insert cannot interleave with another send.
function insertPrescription(db, now, build) {
  return db.transaction(() => {
    const session = getOpenSession(db);
    if (!session) throw new NoOpenSessionError();
    const id = nextPrescriptionId(db, now);
    const fields = build(id);
    db.prepare(INSERT).run({
      id,
      sessionId: session.id,
      createdAt: now.toISOString(),
      typedBody: null,
      imagePath: null,
      requestId: null,
      ...fields
    });
    return getPrescription(db, id);
  }).immediate();
}

// `value` must already be validated (see validation.js).
function createTypedPrescription(db, value, now = new Date()) {
  return insertPrescription(db, now, () => ({
    patientRef: value.patientRef,
    kind: 'typed',
    typedBody: JSON.stringify({ lines: value.lines }),
    requestId: value.requestId || null
  }));
}

// Saves the PNG bytes exactly as received to DATA_DIR/images/<id>.png, then
// the row. `value` must already be validated (see validation.js).
function createHandwrittenPrescription(db, dataDir, value, now = new Date()) {
  let written = null;
  try {
    return insertPrescription(db, now, (id) => {
      const relative = path.posix.join(IMAGES_SUBDIR, `${id}.png`);
      written = imageFile(dataDir, relative);
      writeFileDurably(written, value.image);
      return { patientRef: value.patientRef, kind: 'handwritten', imagePath: relative, requestId: value.requestId || null };
    });
  } catch (err) {
    // The row was rolled back, so this image belongs to no prescription.
    // Removing it is not deleting a prescription (hard rule 4).
    if (written) fs.rmSync(written, { force: true });
    throw err;
  }
}

// Write to a temp file, flush to disk, then rename: a power cut never
// leaves a half-written image under the final name.
function writeFileDurably(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function imageFile(dataDir, relative) {
  return path.join(dataDir, ...relative.split('/'));
}

// Absolute path of a handwritten prescription's PNG, or null.
function getImageFile(db, dataDir, id) {
  const row = db.prepare(`SELECT image_path FROM prescriptions WHERE id = ? AND kind = 'handwritten'`).get(id);
  if (!row || !row.image_path) return null;
  const file = imageFile(dataDir, row.image_path);
  // Defence in depth: only ever serve from the images folder.
  const imagesDir = path.join(dataDir, IMAGES_SUBDIR) + path.sep;
  return file.startsWith(imagesDir) ? file : null;
}

function getPrescription(db, id) {
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  return row ? toPrescription(row) : null;
}

// The prescription an earlier send with this request ID saved, or null.
function findByRequestId(db, requestId) {
  const row = db.prepare('SELECT * FROM prescriptions WHERE request_id = ?').get(requestId);
  return row ? toPrescription(row) : null;
}

class NotDispensableError extends Error {}

// Marks a prescription dispensed. Doing it twice is not an error: the
// second call returns { changed: false } and keeps the first time.
function markDispensed(db, id, now = new Date()) {
  return db.transaction(() => {
    const row = db.prepare('SELECT p.status, s.status AS session_status FROM prescriptions p JOIN sessions s ON s.id = p.session_id WHERE p.id = ?').get(id);
    if (!row) throw new NotDispensableError('Prescription not found.');
    if (row.status === 'dispensed') return { prescription: getPrescription(db, id), changed: false };
    if (row.session_status !== 'open') throw new NotDispensableError('This session has ended.');
    db.prepare(`UPDATE prescriptions SET status = 'dispensed', dispensed_at = ? WHERE id = ?`).run(now.toISOString(), id);
    return { prescription: getPrescription(db, id), changed: true };
  }).immediate();
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
  createHandwrittenPrescription,
  getImageFile,
  getPrescription,
  findByRequestId,
  listForSession,
  markDispensed,
  NoOpenSessionError,
  NotDispensableError,
  IMAGES_SUBDIR
};
