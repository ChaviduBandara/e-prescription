// Phase 5: every REST route and Socket.IO event refuses a missing or wrong
// login, and each role can only do its own job.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./server-harness');
const { fakeTyped, fakeHandwritten } = require('../helpers');

const ACK_MS = 2000;

// A session with one typed and one handwritten prescription.
async function setup(t, options) {
  const harness = await startTestServer(t, options);
  const doctor = await harness.connect('doctor');
  const pharmacy = await harness.connect('pharmacy');
  const { session } = await doctor.timeout(ACK_MS).emitWithAck('session:start', {});
  const typed = (await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped())).prescription;
  const drawn = (await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeHandwritten())).prescription;
  const routes = ['/api/session/current', `/api/prescriptions?session=${session.id}`, drawn.imageUrl];
  return { ...harness, doctor, pharmacy, session, typed, drawn, routes };
}

function count(db, sql) {
  return db.prepare(sql).get().n;
}

// ---- Login ------------------------------------------------------------------

test('login: right PIN sets the role cookie; wrong PIN does not', async (t) => {
  const { login } = await startTestServer(t);
  const ok = await login('doctor');
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /^rx_doctor=.+HttpOnly; SameSite=Strict/);

  const wrong = await login('doctor', '9999');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.setCookie, null);
  assert.match(wrong.body.error, /Wrong PIN/);

  // The pharmacy PIN does not open the doctor screen, or the reverse.
  assert.equal((await login('doctor', '2222')).status, 401);
  assert.equal((await login('pharmacy', '1111')).status, 401);
  assert.equal((await login('admin', '1111')).status, 400);
});

test('login: 5 wrong PINs lock the role out; it opens again after the lockout', async (t) => {
  const { login } = await startTestServer(t, { authOptions: { lockoutMs: 300 } });
  for (let i = 0; i < 4; i++) assert.equal((await login('pharmacy', '0000')).status, 401);
  const fifth = await login('pharmacy', '0000');
  assert.equal(fifth.status, 429);
  assert.match(fifth.body.error, /Too many wrong PINs/);

  const whileLocked = await login('pharmacy');
  assert.equal(whileLocked.status, 429, 'even the right PIN is refused while locked');
  assert.equal(whileLocked.setCookie, null);
  assert.equal((await login('doctor')).status, 200, 'the other role is not locked');

  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await login('pharmacy')).status, 200);
});

test('the default lockout is 1 minute', async (t) => {
  const { login } = await startTestServer(t);
  for (let i = 0; i < 5; i++) await login('doctor', '0000');
  const res = await login('doctor');
  assert.equal(res.status, 429);
  assert.ok(res.body.retryAfter > 55 && res.body.retryAfter <= 60, String(res.body.retryAfter));
});

test('auth/check says whether this browser is logged in as a role', async (t) => {
  const { getJson } = await startTestServer(t);
  assert.deepEqual((await getJson('/api/auth/check?role=doctor', { role: 'doctor' })).body, { ok: true });
  assert.deepEqual((await getJson('/api/auth/check?role=pharmacy', { role: 'doctor' })).body, { ok: false });
  assert.deepEqual((await getJson('/api/auth/check?role=doctor', { cookie: '' })).body, { ok: false });
});

// ---- REST -------------------------------------------------------------------

test('every REST route refuses a missing, forged or tampered login', async (t) => {
  const { routes, cookieFor, getJson, base } = await setup(t);
  const good = await cookieFor('pharmacy');
  const [name, value] = good.split('=');
  const [role, issued, sig] = value.split('.');
  const bad = {
    missing: '',
    garbage: 'rx_pharmacy=nonsense',
    tampered: `${name}=${role}.${Number(issued) - 1}.${sig}`,
    'doctor token in pharmacy cookie': `rx_pharmacy=${(await cookieFor('doctor')).split('=')[1]}`,
    'made-up role': `rx_admin=admin.${issued}.${sig}`
  };
  for (const route of routes) {
    for (const [label, cookie] of Object.entries(bad)) {
      const res = await fetch(`${base}${route}`, { headers: cookie ? { cookie } : {} });
      assert.equal(res.status, 401, `${route} with ${label}`);
    }
  }
  // Static pages, scripts and /health stay open: the PIN screen must load.
  for (const open of ['/doctor/', '/pharmacy/', '/shared/client.js', '/health']) {
    assert.equal((await fetch(`${base}${open}`)).status, 200, open);
  }
  assert.equal((await getJson('/api/session/current', { cookie: '' })).body.error, 'Enter the PIN first.');
});

test('both roles can read the session, queue and images', async (t) => {
  const { routes, base, cookieFor } = await setup(t);
  for (const role of ['doctor', 'pharmacy']) {
    for (const route of routes) {
      const res = await fetch(`${base}${route}`, { headers: { cookie: await cookieFor(role) } });
      assert.equal(res.status, 200, `${role} ${route}`);
    }
  }
});

// ---- Socket.IO --------------------------------------------------------------

test('a socket without a valid login for the role it claims is refused', async (t) => {
  const { connect, cookieFor } = await setup(t);
  const doctorCookie = await cookieFor('doctor');
  const attempts = {
    'no cookie': () => connect('doctor', { cookie: '' }),
    'garbage cookie': () => connect('doctor', { cookie: 'rx_doctor=nonsense' }),
    'doctor cookie claiming pharmacy': () => connect('pharmacy', { cookie: doctorCookie }),
    'no role claimed': () => connect('doctor', { claim: null }),
    'made-up role': () => connect('doctor', { claim: 'admin' }),
    'another site': () => connect('doctor', { origin: 'http://evil.example' })
  };
  for (const [label, attempt] of Object.entries(attempts)) {
    await assert.rejects(attempt(), /unauthorized/, label);
  }
  // Same-origin handshakes (like the real pages) are fine.
  const ok = await connect('doctor', { origin: undefined });
  assert.equal(ok.connected, true);
});

test('the doctor cannot mark dispensed or end the session', async (t) => {
  const { db, doctor, typed, session } = await setup(t);
  const dispensed = await doctor.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id: typed.id });
  assert.deepEqual(dispensed, { ok: false, error: 'This screen is not allowed to do that.' });
  const ended = await doctor.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id });
  assert.equal(ended.ok, false);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM prescriptions WHERE status = 'dispensed'`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE status = 'open'`), 1);
});

test('the pharmacy cannot send prescriptions or start a session', async (t) => {
  const { db, pharmacy, session, doctor } = await setup(t);
  const before = count(db, 'SELECT COUNT(*) AS n FROM prescriptions');
  const sent = await pharmacy.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped());
  assert.deepEqual(sent, { ok: false, error: 'This screen is not allowed to do that.' });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM prescriptions'), before);

  // Ending the session, then trying to start one from the pharmacy.
  assert.equal((await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id })).ok, true);
  const started = await pharmacy.timeout(ACK_MS).emitWithAck('session:start', {});
  assert.equal(started.ok, false);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE status = 'open'`), 0);
  // The doctor still can.
  assert.equal((await doctor.timeout(ACK_MS).emitWithAck('session:start', {})).ok, true);
});

test('each role can do its own job', async (t) => {
  const { doctor, pharmacy, typed, session } = await setup(t);
  assert.equal((await doctor.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped())).ok, true);
  assert.equal((await pharmacy.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id: typed.id })).ok, true);
  assert.equal((await pharmacy.timeout(ACK_MS).emitWithAck('session:end', { sessionId: session.id })).ok, true);
});

test('a refused event never reaches the other screen', async (t) => {
  const { doctor, pharmacy, typed } = await setup(t);
  const leaked = [];
  doctor.on('prescription:dispensed', (rx) => leaked.push(rx));
  // Only this test's refused send counts, not setup's own late broadcasts.
  pharmacy.on('prescription:new', (rx) => rx.patientRef === 'TOKEN-REFUSED' && leaked.push(rx));
  await doctor.timeout(ACK_MS).emitWithAck('prescription:dispensed', { id: typed.id });
  await pharmacy.timeout(ACK_MS).emitWithAck('prescription:new', fakeTyped({ patientRef: 'TOKEN-REFUSED' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(leaked, []);
});
