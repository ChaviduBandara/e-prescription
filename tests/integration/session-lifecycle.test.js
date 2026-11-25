// Phase 4: Dispensed and End Session over Socket.IO, with acks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, nextEvent, noEvent } = require('./server-harness');
const { fakeTyped } = require('../helpers');

const ACK_MS = 2000;

async function setup(t) {
  const harness = await startTestServer(t);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const send = async (overrides) =>
    (await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped(overrides))).prescription;
  const dispense = (id) => pharmacy.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id });
  const end = (sessionId = session.id) => pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId });
  return { ...harness, doctor, pharmacy, session, send, dispense, end };
}

function row(db, id) {
  return db.prepare('SELECT status, dispensed_at FROM prescriptions WHERE id = ?').get(id);
}

// ---- Dispensed ---------------------------------------------------------------

test('dispensed: saved, then acked, then broadcast to the doctor within 1 s', async (t) => {
  const { db, doctor, send, dispense } = await setup(t);
  const rx = await send();

  const startedAt = Date.now();
  const broadcast = nextEvent(doctor, 'prescription:dispensed', 1000);
  let rowAtAck;
  const res = await dispense(rx.id).then((r) => ((rowAtAck = row(db, rx.id)), r));
  const pushed = await broadcast;
  assert.ok(Date.now() - startedAt < 1000);

  assert.equal(res.ok, true);
  assert.equal(res.prescription.status, 'dispensed');
  assert.ok(res.prescription.dispensedAt);
  assert.equal(rowAtAck.status, 'dispensed', 'in SQLite before the ack arrived');
  assert.deepEqual(pushed, res.prescription);
});

test('dispensing twice keeps the first time and broadcasts once', async (t) => {
  const { doctor, send, dispense } = await setup(t);
  const rx = await send();
  const firstBroadcast = nextEvent(doctor, 'prescription:dispensed');
  const first = await dispense(rx.id);
  await firstBroadcast;
  const quiet = noEvent(doctor, 'prescription:dispensed');
  const second = await dispense(rx.id);
  assert.equal(second.ok, true);
  assert.equal(second.prescription.dispensedAt, first.prescription.dispensedAt);
  assert.equal(await quiet, true);
});

test('dispensed rejects a bad or unknown ID with a clear error', async (t) => {
  const { pharmacy, dispense } = await setup(t);
  assert.deepEqual(await dispense('RX-20990101-9999'), { ok: false, error: 'Prescription not found.' });
  assert.deepEqual(await dispense('not an id'), { ok: false, error: 'Unknown prescription ID.' });
  const noPayload = await pharmacy.timeout(ACK_MS).emitWithAck('prescription:dispensed', null);
  assert.equal(noPayload.ok, false);
});

test('a prescription in an ended session cannot be dispensed', async (t) => {
  const { db, send, dispense, end } = await setup(t);
  const rx = await send();
  await end();
  const res = await dispense(rx.id);
  assert.deepEqual(res, { ok: false, error: 'This session has ended.' });
  assert.equal(row(db, rx.id).status, 'sent');
});

test('REST reloads show dispensed status', async (t) => {
  const { session, send, dispense, getJson } = await setup(t);
  const rx = await send();
  await dispense(rx.id);
  const { body } = await getJson(`/api/prescriptions?session=${session.id}`);
  assert.equal(body.prescriptions[0].status, 'dispensed');
});

// ---- Session lifecycle -------------------------------------------------------

test('session:end closes the session, acks, and tells both screens', async (t) => {
  const { db, doctor, pharmacy, session, end, getJson } = await setup(t);
  const toDoctor = nextEvent(doctor, 'session:ended');
  const toPharmacy = nextEvent(pharmacy, 'session:ended');
  const res = await end();

  assert.equal(res.ok, true);
  assert.equal(res.session.id, session.id);
  assert.equal(res.session.status, 'closed');
  assert.ok(res.session.endedAt);
  assert.deepEqual(await toDoctor, res.session);
  assert.deepEqual(await toPharmacy, res.session);
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id).status, 'closed');
  assert.deepEqual((await getJson('/api/session/current')).body, { session: null });
});

test('ending a session keeps every prescription (hard rule 4)', async (t) => {
  const { db, session, send, end, getJson } = await setup(t);
  await send({ patientRef: 'TOKEN-001' });
  await send({ patientRef: 'TOKEN-002' });
  await end();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prescriptions WHERE session_id = ?').get(session.id).n, 2);
  const { body } = await getJson(`/api/prescriptions?session=${session.id}`);
  assert.equal(body.prescriptions.length, 2);
});

test('ending twice is harmless and broadcasts once', async (t) => {
  const { pharmacy, end } = await setup(t);
  const firstBroadcast = nextEvent(pharmacy, 'session:ended');
  await end();
  await firstBroadcast;
  const quiet = noEvent(pharmacy, 'session:ended');
  const again = await end();
  assert.equal(again.ok, true);
  assert.equal(again.session.status, 'closed');
  assert.equal(await quiet, true);
});

test('session:end rejects an unknown or malformed session', async (t) => {
  const { pharmacy, end } = await setup(t);
  assert.equal((await end(999)).ok, false);
  assert.equal((await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: '1' })).ok, false);
  assert.equal((await pharmacy.timeout(ACK_MS).emitWithAck('session:end', {})).ok, false);
});

test('after ending, sends are refused until a new session starts; only one is ever open', async (t) => {
  const { db, doctor, session, end, send } = await setup(t);
  await end();
  const refused = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  assert.equal(refused.ok, false);

  const next = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(next.ok, true);
  assert.notEqual(next.session.id, session.id);
  const again = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(again.session.id, next.session.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'open'`).get().n, 1);

  const rx = await send();
  assert.equal(rx.sessionId, next.session.id);
});

test('ending an old session does not close the new one', async (t) => {
  const { doctor, session, end } = await setup(t);
  await end();
  const next = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const stale = await end(session.id);
  assert.equal(stale.ok, true);
  assert.equal(stale.session.id, session.id);
  const current = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(current.session.id, next.session.id);
  assert.equal(current.session.status, 'open');
});
