'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb } = require('../../src/db');
const { startSession, getOpenSession } = require('../../src/sessions');
const { tempDb, makeTempDir, removeDir } = require('../helpers');

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
    'status', 'created_at', 'dispensed_at', 'request_id'
  ]);
});

test('a database made before request_id existed gains the column and keeps its rows', (t) => {
  const dir = makeTempDir();
  const old = new Database(path.join(dir, 'e-prescription.db'));
  old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, ended_at TEXT,
      status TEXT NOT NULL, archive_file TEXT, archived_at TEXT);
    CREATE TABLE prescriptions (id TEXT PRIMARY KEY, session_id INTEGER NOT NULL, patient_ref TEXT NOT NULL,
      kind TEXT NOT NULL, typed_body TEXT, image_path TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, dispensed_at TEXT);
    INSERT INTO sessions (started_at, status) VALUES ('2026-01-02T08:00:00.000Z', 'open');
    INSERT INTO prescriptions VALUES ('RX-20260102-0001', 1, 'TOKEN-001', 'typed', '{"lines":[]}', NULL, 'sent', '2026-01-02T08:01:00.000Z', NULL);`);
  old.close();

  const db = openDb(dir);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  assert.ok(columns(db, 'prescriptions').includes('request_id'));
  assert.equal(db.prepare('SELECT patient_ref FROM prescriptions').get().patient_ref, 'TOKEN-001');
  // The same request ID can only be stored once.
  const insert = db.prepare(`INSERT INTO prescriptions (id, session_id, patient_ref, kind, status, created_at, request_id)
    VALUES (?, 1, 'TOKEN-002', 'typed', 'sent', 'x', 'req-0000000000000001')`);
  insert.run('RX-20260102-0002');
  assert.throws(() => insert.run('RX-20260102-0003'), /UNIQUE/);
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
