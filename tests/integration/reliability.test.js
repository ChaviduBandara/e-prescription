// Phase 7: a clinic day with WiFi drops, lost acks, service stops and crashes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');
const { start, handleShutdown } = require('../../server');
const { startTestServer, nextEvent, noEvent, PINS } = require('./server-harness');
const { fakeTyped, fakeHandwritten, makePng, makeTempDir, removeDir } = require('../helpers');
const { spawnServer: spawnProcess, killServer: kill } = require('../server-process');

const ACK_MS = 5000;
let requestCounter = 0;
const requestId = () => `test-request-${String(++requestCounter).padStart(8, '0')}`;

async function openSession(t) {
  const harness = await startTestServer(t);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const send = (payload) => doctor.timeout(ACK_MS).emitWithAck('prescription:new', payload);
  return { ...harness, doctor, pharmacy, session, send };
}

const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n;

// ---- Request IDs -------------------------------------------------------------

test('a retried send with the same request ID returns the saved prescription and saves nothing new', async (t) => {
  const { db, pharmacy, send } = await openSession(t);
  const payload = { ...fakeTyped({ patientRef: 'TOKEN-001' }), requestId: requestId() };

  const pushed = nextEvent(pharmacy, 'prescription:new', ACK_MS);
  const first = await send(payload);
  assert.equal(first.ok, true);
  await pushed;

  // The ack was "lost" and the tablet sends again, twice.
  const quiet = noEvent(pharmacy, 'prescription:new', 500);
  const second = await send(payload);
  const third = await send(payload);
  assert.equal(second.ok, true);
  assert.equal(second.repeated, true);
  assert.deepEqual(second.prescription, first.prescription);
  assert.deepEqual(third.prescription, first.prescription);
  assert.equal(await quiet, true, 'the pharmacy is not told twice');
  assert.equal(count(db), 1);

  // A new tap on Send (new request ID) is a new prescription.
  const other = await send({ ...payload, requestId: requestId() });
  assert.notEqual(other.prescription.id, first.prescription.id);
  assert.equal(count(db), 2);
});

test('two copies of a handwritten send arriving together save one prescription and one image', async (t) => {
  const { db, dataDir, send } = await openSession(t);
  const payload = { ...fakeHandwritten({ patientRef: 'TOKEN-002', image: makePng({ width: 300, height: 400 }) }), requestId: requestId() };
  // Like a send buffered while offline plus the page's own retry.
  const [a, b] = await Promise.all([send(payload), send(payload)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.prescription.id, b.prescription.id);
  assert.equal(count(db), 1);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'images')), [`${a.prescription.id}.png`]);
});

test('a retry still gets its prescription after the session has ended', async (t) => {
  const { pharmacy, session, send } = await openSession(t);
  const payload = { ...fakeTyped({ patientRef: 'TOKEN-003' }), requestId: requestId() };
  const first = await send(payload);
  await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id });
  const retry = await send(payload);
  assert.equal(retry.ok, true);
  assert.equal(retry.prescription.id, first.prescription.id);
});

test('a reused request ID with a different patient is refused, and a malformed one is rejected', async (t) => {
  const { db, send } = await openSession(t);
  const id = requestId();
  await send({ ...fakeTyped({ patientRef: 'TOKEN-004' }), requestId: id });
  const clash = await send({ ...fakeTyped({ patientRef: 'TOKEN-005' }), requestId: id });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /does not match/);
  assert.equal(count(db), 1, 'TOKEN-005 was not saved under TOKEN-004');

  for (const bad of ['short', 'x'.repeat(65), 'has spaces in it!!', 42, null]) {
    const res = await send({ ...fakeTyped(), requestId: bad });
    assert.equal(res.ok, false, String(bad));
  }
  assert.equal(count(db), 1);
});

// ---- Session the send was made in -------------------------------------------

const SESSION_ENDED = 'The session ended before this was sent. Start a new session and send again.';

test('a send made in a session that has since ended is refused, even if a new session is open', async (t) => {
  const { db, doctor, pharmacy, session, send } = await openSession(t);
  const current = await send({ ...fakeTyped({ patientRef: 'TOKEN-201' }), sessionId: session.id, requestId: requestId() });
  assert.equal(current.ok, true, 'a send in the open session works');

  await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id });
  const late = { ...fakeTyped({ patientRef: 'TOKEN-202' }), sessionId: session.id, requestId: requestId() };
  const noSession = await send(late);
  assert.deepEqual(noSession, { ok: false, code: 'SESSION_ENDED', error: SESSION_ENDED });

  const { session: next } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const quiet = noEvent(pharmacy, 'prescription:new', 300);
  const wrongSession = await send(late);
  assert.deepEqual(wrongSession, { ok: false, code: 'SESSION_ENDED', error: SESSION_ENDED });
  const drawn = await send({ ...fakeHandwritten({ patientRef: 'TOKEN-203', image: makePng({ width: 300, height: 400 }) }), sessionId: session.id });
  assert.equal(drawn.code, 'SESSION_ENDED');
  assert.equal(await quiet, true, 'the pharmacy is not told');
  assert.equal(count(db), 1, 'nothing filed in the new session');

  // Sent again from the new session it is saved there.
  const again = await send({ ...late, sessionId: next.id, requestId: requestId() });
  assert.equal(again.ok, true);
  assert.equal(again.prescription.sessionId, next.id);
});

test('a retry of a send saved before its session ended still gets its prescription back', async (t) => {
  const { pharmacy, session, send } = await openSession(t);
  const payload = { ...fakeTyped({ patientRef: 'TOKEN-204' }), sessionId: session.id, requestId: requestId() };
  const first = await send(payload);
  await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id });
  const retry = await send(payload);
  assert.equal(retry.ok, true);
  assert.equal(retry.prescription.id, first.prescription.id);
});

test('a malformed session ID is rejected', async (t) => {
  const { db, send } = await openSession(t);
  for (const bad of [0, -1, 1.5, '1', null, 2 ** 60]) {
    assert.equal((await send({ ...fakeTyped(), sessionId: bad })).ok, false, String(bad));
  }
  assert.equal(count(db), 0);
});

// ---- Graceful shutdown -------------------------------------------------------

test('SIGINT/SIGTERM close the sockets and the database, exit 0, and the data opens again', async (t) => {
  const dataDir = makeTempDir();
  const archiveDir = path.join(dataDir, 'archive');
  let server = await start({ port: 0, dataDir, archiveDir, pins: PINS });
  t.after(async () => {
    await server.close();
    removeDir(dataDir);
  });

  const base = `http://localhost:${server.port}`;
  const cookie = await loginCookie(base, 'doctor');
  const doctor = await connectTo(base, 'doctor', cookie);
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const { prescription } = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped({ patientRef: 'TOKEN-006' }));

  const proc = new EventEmitter();
  const exits = [];
  const onSignal = handleShutdown(server, { proc, exit: (code) => exits.push(code) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) assert.equal(proc.listenerCount(signal), 1, signal);

  const dropped = nextEvent(doctor, 'disconnect', ACK_MS);
  proc.emit('SIGTERM', 'SIGTERM');
  proc.emit('SIGINT', 'SIGINT'); // a second Ctrl+C while closing is ignored
  assert.equal(await dropped, 'transport close', 'the tablet sees a dropped connection and will reconnect');
  await onSignal('SIGINT');
  await server.close();
  doctor.close();
  assert.deepEqual(exits, [0]);
  assert.equal(server.db.open, false);
  // Closing folded the WAL back into the database file.
  const wal = path.join(dataDir, 'e-prescription.db-wal');
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL checkpointed');

  // Started again on the same data: same open session, same prescription.
  server = await start({ port: 0, dataDir, archiveDir, pins: PINS });
  const again = `http://localhost:${server.port}`;
  const state = await getJson(again, '/api/session/current', cookie);
  assert.equal(state.session.id, session.id, 'the login cookie and the session survive');
  const { prescriptions } = await getJson(again, `/api/prescriptions?session=${session.id}`, cookie);
  assert.deepEqual(prescriptions, [prescription]);
});

// ---- Crash -------------------------------------------------------------------

test('after a hard kill the server starts cleanly on the same data and carries on', { timeout: 60_000 }, async (t) => {
  const dataDir = makeTempDir();
  const archiveDir = path.join(dataDir, 'archive');
  let child = null;
  t.after(async () => {
    if (child) await kill(child);
    removeDir(dataDir);
  });

  let base;
  ({ child, base } = await spawnProcess({ dataDir, archiveDir, pins: PINS }));
  const cookies = { doctor: await loginCookie(base, 'doctor'), pharmacy: await loginCookie(base, 'pharmacy') };
  let doctor = await connectTo(base, 'doctor', cookies.doctor);
  let pharmacy = await connectTo(base, 'pharmacy', cookies.pharmacy);
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const image = makePng({ width: 300, height: 400 });
  const sent = [];
  for (const payload of [
    fakeTyped({ patientRef: 'TOKEN-101' }),
    fakeHandwritten({ patientRef: 'TOKEN-102', image }),
    fakeTyped({ patientRef: 'TOKEN-103' })
  ]) {
    sent.push((await doctor.timeout(ACK_MS).emitWithAck('prescription:new', payload)).prescription);
  }
  await pharmacy.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id: sent[0].id });
  const before = await getJson(base, `/api/prescriptions?session=${session.id}`, cookies.pharmacy);
  doctor.close();
  pharmacy.close();

  // Power cut: no shutdown code runs. A PDF write was cut short too.
  await kill(child);
  child = null;
  fs.mkdirSync(archiveDir, { recursive: true });
  const partial = path.join(archiveDir, '.2026-01-02_session-9.pdf.99999.partial');
  fs.writeFileSync(partial, '%PDF-1.3 half');

  ({ child, base } = await spawnProcess({ dataDir, archiveDir, pins: PINS }));
  assert.equal(fs.existsSync(partial), false, 'the half-written PDF is tidied away');
  const check = new Database(path.join(dataDir, 'e-prescription.db'), { readonly: true });
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  check.close();

  // Same session, same prescriptions and statuses, same handwriting bytes.
  assert.equal((await getJson(base, '/api/session/current', cookies.doctor)).session.id, session.id);
  assert.deepEqual(await getJson(base, `/api/prescriptions?session=${session.id}`, cookies.pharmacy), before);
  const png = await fetch(`${base}${sent[1].imageUrl}`, { headers: { cookie: cookies.pharmacy } });
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), image);

  // The day carries on: the next ID follows on, and the pharmacy gets it.
  doctor = await connectTo(base, 'doctor', cookies.doctor);
  pharmacy = await connectTo(base, 'pharmacy', cookies.pharmacy);
  const pushed = nextEvent(pharmacy, 'prescription:new', ACK_MS);
  const next = await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped({ patientRef: 'TOKEN-104' }));
  assert.equal(next.ok, true);
  assert.equal(Number(next.prescription.id.slice(-4)), Number(sent[2].id.slice(-4)) + 1);
  assert.equal((await pushed).id, next.prescription.id);
  doctor.close();
  pharmacy.close();
});

// ---- Helpers -----------------------------------------------------------------

async function loginCookie(base, role) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, pin: PINS[role] })
  });
  assert.equal(res.status, 200, `login ${role}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function getJson(base, url, cookie) {
  const res = await fetch(`${base}${url}`, { headers: { cookie } });
  assert.equal(res.status, 200, url);
  return res.json();
}

function connectTo(base, role, cookie) {
  const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { role }, extraHeaders: { cookie } });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}
