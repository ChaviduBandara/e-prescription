'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startSession, getOpenSession } = require('../../src/sessions');
const { tempDb } = require('../helpers');

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

test('database runs in WAL mode with full sync', (t) => {
  const { db } = tempDb(t);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 2); // FULL
});

test('tables have exactly the columns in docs/SPEC.md', (t) => {
  const { db } = tempDb(t);
  assert.deepEqual(columns(db, 'sessions'), [
    'id', 'started_at', 'ended_at', 'status', 'archive_file', 'archived_at'
  ]);
  assert.deepEqual(columns(db, 'prescriptions'), [
    'id', 'session_id', 'patient_ref', 'kind', 'typed_body', 'image_path',
    'status', 'created_at', 'dispensed_at'
  ]);
});

test('starting a session twice returns the same open session', (t) => {
  const { db } = tempDb(t);
  const first = startSession(db);
  const second = startSession(db);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session.id, first.session.id);
  assert.equal(getOpenSession(db).status, 'open');
});

test('the database refuses a second open session', (t) => {
  const { db } = tempDb(t);
  startSession(db);
  assert.throws(
    () => db.prepare(`INSERT INTO sessions (started_at, status) VALUES ('x', 'open')`).run(),
    /UNIQUE/
  );
});
