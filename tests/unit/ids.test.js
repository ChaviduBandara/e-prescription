'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../../src/db');
const { nextPrescriptionId, formatId, ID_PATTERN } = require('../../src/ids');
const { startSession } = require('../../src/sessions');
const { createTypedPrescription } = require('../../src/prescriptions');
const { tempDb, makeTempDir, removeDir, fakeTyped } = require('../helpers');

// Local-time dates, matching how the server builds the ID.
const DAY1 = new Date(2026, 10, 24, 9, 30, 0);
const DAY1_LAST_SECOND = new Date(2026, 10, 24, 23, 59, 59, 999);
const DAY2_MIDNIGHT = new Date(2026, 10, 25, 0, 0, 0, 0);

function insert(db, now) {
  return createTypedPrescription(db, fakeTyped(), now).id;
}

test('formatId pads the running number to four digits', () => {
  assert.equal(formatId(DAY1, 1), 'RX-20261124-0001');
  assert.equal(formatId(DAY1, 42), 'RX-20261124-0042');
  assert.equal(formatId(new Date(2026, 0, 5), 9999), 'RX-20260105-9999');
  assert.match(formatId(DAY1, 7), ID_PATTERN);
});

test('first prescription of the day is 0001, then numbers run on', (t) => {
  const { db } = tempDb(t);
  startSession(db, DAY1);
  assert.equal(nextPrescriptionId(db, DAY1), 'RX-20261124-0001');
  assert.equal(insert(db, DAY1), 'RX-20261124-0001');
  assert.equal(insert(db, DAY1), 'RX-20261124-0002');
  assert.equal(insert(db, DAY1), 'RX-20261124-0003');
});

test('numbering restarts at 0001 after midnight', (t) => {
  const { db } = tempDb(t);
  startSession(db, DAY1);
  assert.equal(insert(db, DAY1), 'RX-20261124-0001');
  assert.equal(insert(db, DAY1_LAST_SECOND), 'RX-20261124-0002');
  assert.equal(insert(db, DAY2_MIDNIGHT), 'RX-20261125-0001');
  assert.equal(insert(db, DAY2_MIDNIGHT), 'RX-20261125-0002');
});

test('numbering continues after a server restart', (t) => {
  const dir = makeTempDir();
  let db = openDb(dir);
  t.after(() => {
    db.close();
    removeDir(dir);
  });
  startSession(db, DAY1);
  insert(db, DAY1);
  insert(db, DAY1);
  db.close();

  db = openDb(dir); // "restart"
  assert.equal(insert(db, DAY1), 'RX-20261124-0003');
});

test('numbers past 9999 still increase (compared as numbers, not text)', (t) => {
  const { db } = tempDb(t);
  const { session } = startSession(db, DAY1);
  db.prepare(
    `INSERT INTO prescriptions (id, session_id, patient_ref, kind, typed_body, status, created_at)
     VALUES ('RX-20261124-9999', ?, 'TOKEN-001', 'typed', '{"lines":[]}', 'sent', ?)`
  ).run(session.id, DAY1.toISOString());
  assert.equal(insert(db, DAY1), 'RX-20261124-10000');
  assert.equal(insert(db, DAY1), 'RX-20261124-10001');
});

test('many sends in a row get unique, consecutive IDs', (t) => {
  const { db } = tempDb(t);
  startSession(db, DAY1);
  const ids = Array.from({ length: 50 }, () => insert(db, DAY1));
  assert.equal(new Set(ids).size, 50);
  assert.equal(ids[49], 'RX-20261124-0050');
});
