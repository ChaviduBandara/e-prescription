'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, nextEvent, noEvent } = require('./server-harness');
const { ERRORS } = require('../../src/validation');
const { datePart } = require('../../src/ids');
const { fakeTyped } = require('../helpers');

const ACK_MS = 2000;

async function setup(t) {
  const harness = await startTestServer(t);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  return { ...harness, doctor, pharmacy };
}

function rowCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n;
}

test('session:start opens a session and tells the pharmacy', async (t) => {
  const { doctor, pharmacy } = await setup(t);
  const started = nextEvent(pharmacy, 'session:started');
  const res = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(res.ok, true);
  assert.equal(res.session.status, 'open');
  assert.deepEqual(await started, res.session);
});

test('a second session:start returns the open session without a new broadcast', async (t) => {
  const { doctor, pharmacy } = await setup(t);
  const firstBroadcast = nextEvent(pharmacy, 'session:started');
  const first = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  await firstBroadcast;
  const quiet = noEvent(pharmacy, 'session:started');
  const second = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(second.session.id, first.session.id);
  assert.equal(await quiet, true);
});

test('doctor sends a typed prescription; pharmacy receives it within 1 s', async (t) => {
  const { doctor, pharmacy } = await setup(t);
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});

  const sentAt = Date.now();
  const received = nextEvent(pharmacy, 'prescription:new', 1000);
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  const rx = await received;
  assert.ok(Date.now() - sentAt < 1000, 'pharmacy got it within 1 s');

  assert.equal(res.ok, true);
  assert.equal(res.prescription.id, `RX-${datePart(new Date())}-0001`);
  assert.deepEqual(rx, res.prescription);
  assert.equal(rx.sessionId, session.id);
  assert.equal(rx.patientRef, 'TOKEN-001');
  assert.equal(rx.kind, 'typed');
  assert.equal(rx.status, 'sent');
  assert.deepEqual(rx.lines, fakeTyped().lines);
});

test('the prescription is in SQLite when the ack and the broadcast arrive', async (t) => {
  const { db, doctor, pharmacy } = await setup(t);
  await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const find = db.prepare('SELECT * FROM prescriptions WHERE id = ?');

  let rowAtBroadcast;
  pharmacy.once('prescription:new', (rx) => (rowAtBroadcast = find.get(rx.id)));
  const rowAtAck = await new Promise((resolve) => {
    doctor.emit('prescription:new', fakeTyped(), (res) => resolve(find.get(res.prescription.id)));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(rowAtAck.patient_ref, 'TOKEN-001');
  assert.equal(rowAtBroadcast.id, rowAtAck.id);
});

test('if the save fails, the doctor gets an error and the pharmacy gets nothing', async (t) => {
  const { db, doctor, pharmacy } = await setup(t);
  await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON prescriptions
           BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);

  const quiet = noEvent(pharmacy, 'prescription:new');
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  assert.equal(res.ok, false);
  assert.match(res.error, /NOT saved/);
  assert.equal(await quiet, true);
  assert.equal(rowCount(db), 0);
});

test('rejects a prescription with no patient ref, with a clear error', async (t) => {
  const { db, doctor, pharmacy } = await setup(t);
  await doctor.timeout(ACK_MS).emitWithAck('session:start', {});

  const quiet = noEvent(pharmacy, 'prescription:new');
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped({ patientRef: '  ' }));
  assert.deepEqual(res, { ok: false, error: ERRORS.patientRef });
  assert.equal(await quiet, true);
  assert.equal(rowCount(db), 0);
});

test('rejects a prescription when no session is open', async (t) => {
  const { db, doctor, pharmacy } = await setup(t);
  const quiet = noEvent(pharmacy, 'prescription:new');
  const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  assert.equal(res.ok, false);
  assert.match(res.error, /No open session/);
  assert.equal(await quiet, true);
  assert.equal(rowCount(db), 0);
});

test('REST returns the current session and its prescriptions in arrival order', async (t) => {
  const { doctor, getJson } = await setup(t);
  assert.deepEqual((await getJson('/api/session/current')).body, { session: null });

  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const ids = [];
  for (const ref of ['TOKEN-001', 'TOKEN-002', 'TOKEN-003']) {
    const res = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped({ patientRef: ref }));
    ids.push(res.prescription.id);
  }

  const current = await getJson('/api/session/current');
  assert.equal(current.status, 200);
  assert.equal(current.body.session.id, session.id);

  const list = await getJson(`/api/prescriptions?session=${session.id}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.prescriptions.map((rx) => rx.id), ids);
  assert.deepEqual(list.body.prescriptions.map((rx) => rx.patientRef), ['TOKEN-001', 'TOKEN-002', 'TOKEN-003']);
});

test('REST rejects a bad or unknown session parameter', async (t) => {
  const { getJson } = await setup(t);
  for (const query of ['', '?session=', '?session=abc', '?session=0', '?session=1;DROP']) {
    assert.equal((await getJson(`/api/prescriptions${query}`)).status, 400, query);
  }
  assert.equal((await getJson('/api/prescriptions?session=999')).status, 404);
});
