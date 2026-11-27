'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createAuth, loadSecret, parseCookies, cookieName, pinProblems } = require('../../src/auth');
const { tempDir } = require('../helpers');

const PINS = { doctor: '1111', pharmacy: '2222' };

// An auth with a clock the test moves by hand.
function makeAuth(overrides = {}) {
  const clock = { t: 1_000_000 };
  const auth = createAuth({ pins: PINS, secret: 'test-secret', now: () => clock.t, ...overrides });
  return { auth, clock };
}

const tokenFrom = (setCookie) => parseCookies(setCookie.split(';')[0])[cookieName(setCookie.slice(3, setCookie.indexOf('=')))];

test('a correct PIN gives an httpOnly, SameSite=Strict cookie for that role only', () => {
  const { auth } = makeAuth();
  const result = auth.login('doctor', '1111', 'ip1');
  assert.equal(result.ok, true);
  assert.match(result.cookie, /^rx_doctor=doctor\.\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const token = tokenFrom(result.cookie);
  assert.equal(auth.verify('doctor', token), true);
  assert.equal(auth.verify('pharmacy', token), false);
});

test('wrong PINs, unknown roles and odd input are refused', () => {
  const { auth } = makeAuth();
  assert.equal(auth.login('doctor', '2222', 'ip1').status, 401);
  assert.equal(auth.login('pharmacy', '1111', 'ip1').status, 401);
  assert.equal(auth.login('admin', '1111', 'ip1').status, 400);
  assert.equal(auth.login('doctor', 1111, 'ip1').status, 401);
  assert.equal(auth.login('doctor', undefined, 'ip1').status, 401);
  assert.equal(auth.login('doctor', '1'.repeat(1000), 'ip1').status, 401);
});

test('tampered, forged, cross-role and expired tokens are refused', () => {
  const { auth, clock } = makeAuth({ loginMs: 60_000 });
  const token = auth.issue('pharmacy');
  const [role, issued, sig] = token.split('.');
  assert.equal(auth.verify('pharmacy', `${role}.${Number(issued) + 1}.${sig}`), false);
  assert.equal(auth.verify('pharmacy', `${role}.${issued}.${sig}x`), false);
  assert.equal(auth.verify('pharmacy', `doctor.${issued}.${sig}`), false);
  assert.equal(auth.verify('doctor', token), false);
  assert.equal(auth.verify('pharmacy', `${token}.extra`), false);
  assert.equal(auth.verify('pharmacy', ''), false);
  assert.equal(auth.verify('pharmacy', undefined), false);

  // Another server secret, or a changed PIN, invalidates it.
  assert.equal(createAuth({ pins: PINS, secret: 'other', now: () => clock.t }).verify('pharmacy', token), false);
  const newPin = createAuth({ pins: { ...PINS, pharmacy: '9999' }, secret: 'test-secret', now: () => clock.t });
  assert.equal(newPin.verify('pharmacy', token), false);

  assert.equal(auth.verify('pharmacy', token), true);
  clock.t += 60_001;
  assert.equal(auth.verify('pharmacy', token), false, 'expired');
});

test('5 wrong PINs lock that role out for 1 minute, even with the right PIN', () => {
  const { auth, clock } = makeAuth();
  for (let i = 1; i <= 4; i++) {
    const r = auth.login('doctor', '0000', 'ip1');
    assert.equal(r.status, 401);
    assert.match(r.error, new RegExp(`${5 - i} tr(y|ies) left`));
  }
  const fifth = auth.login('doctor', '0000', 'ip1');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.retryAfter, 60);

  const locked = auth.login('doctor', '1111', 'ip1');
  assert.equal(locked.status, 429);
  // Other roles and other devices are not affected.
  assert.equal(auth.login('pharmacy', '2222', 'ip1').ok, true);
  assert.equal(auth.login('doctor', '1111', 'ip2').ok, true);

  clock.t += 59_000;
  assert.equal(auth.login('doctor', '1111', 'ip1').retryAfter, 1);
  clock.t += 1_000;
  assert.equal(auth.login('doctor', '1111', 'ip1').ok, true);
});

test('a correct PIN resets the count of wrong ones', () => {
  const { auth } = makeAuth();
  for (let i = 0; i < 4; i++) auth.login('doctor', '0000', 'ip1');
  assert.equal(auth.login('doctor', '1111', 'ip1').ok, true);
  for (let i = 0; i < 4; i++) assert.equal(auth.login('doctor', '0000', 'ip1').status, 401);
});

test('rolesFromCookieHeader finds each valid role cookie', () => {
  const { auth } = makeAuth();
  const doctor = `rx_doctor=${auth.issue('doctor')}`;
  const pharmacy = `rx_pharmacy=${auth.issue('pharmacy')}`;
  assert.deepEqual(auth.rolesFromCookieHeader(`${doctor}; other=1; ${pharmacy}`), ['doctor', 'pharmacy']);
  assert.deepEqual(auth.rolesFromCookieHeader(doctor, ['pharmacy']), []);
  assert.deepEqual(auth.rolesFromCookieHeader(`rx_pharmacy=${auth.issue('doctor')}`), []);
  assert.deepEqual(auth.rolesFromCookieHeader(undefined), []);
});

test('the secret is created once in DATA_DIR and reused; SESSION_SECRET wins', (t) => {
  const dir = tempDir(t);
  const first = loadSecret(dir);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(loadSecret(dir), first);
  assert.equal(fs.readFileSync(path.join(dir, 'session-secret'), 'utf8'), first);
  assert.equal(loadSecret(dir, 'from-env'), 'from-env');
});

test('missing, too short or identical PINs are refused before any login exists', () => {
  assert.deepEqual(pinProblems(PINS), []);
  assert.deepEqual(pinProblems({ doctor: '', pharmacy: '2222' }), ['DOCTOR_PIN is not set.']);
  assert.deepEqual(pinProblems({ doctor: '1111' }), ['PHARMACY_PIN is not set.']);
  assert.match(pinProblems({ doctor: '12', pharmacy: '2222' })[0], /DOCTOR_PIN must be 4 to 32 characters/);
  assert.match(pinProblems({ doctor: '1'.repeat(33), pharmacy: '2222' })[0], /DOCTOR_PIN must be 4/);
  assert.deepEqual(pinProblems({ doctor: '1111', pharmacy: '1111' }), ['DOCTOR_PIN and PHARMACY_PIN must be different.']);
  assert.throws(() => createAuth({ pins: { doctor: '', pharmacy: '' }, secret: 'test-secret' }), /PIN setup: DOCTOR_PIN is not set/);
});

test('20 wrong PINs for one role from many IPs lock that role everywhere for 5 minutes', () => {
  const { auth, clock } = makeAuth();
  for (let i = 1; i < 20; i++) assert.equal(auth.login('doctor', '0000', `ip-${i}`).status, 401, `try ${i}`);
  const twentieth = auth.login('doctor', '0000', 'ip-20');
  assert.equal(twentieth.status, 429);
  assert.match(twentieth.error, /for this screen/);
  assert.equal(twentieth.retryAfter, 300);

  // The right PIN from a device that never guessed is refused too...
  const fresh = auth.login('doctor', '1111', 'ip-new');
  assert.equal(fresh.status, 429);
  assert.match(fresh.error, /Too many wrong PINs for this screen/);
  // ...but the other screen is not affected.
  assert.equal(auth.login('pharmacy', '2222', 'ip-new').ok, true);

  clock.t += 299_000;
  assert.equal(auth.login('doctor', '1111', 'ip-new').status, 429);
  clock.t += 1_000;
  assert.equal(auth.login('doctor', '1111', 'ip-new').ok, true);
});

test('role failures older than 10 minutes do not count toward the role lock', () => {
  const { auth, clock } = makeAuth();
  for (let i = 0; i < 19; i++) auth.login('doctor', '0000', `ip-${i}`);
  clock.t += 10 * 60 * 1000;
  for (let i = 0; i < 19; i++) assert.equal(auth.login('doctor', '0000', `ip-b${i}`).status, 401);
  assert.equal(auth.login('doctor', '1111', 'ip-new').ok, true);
});

test('the per-IP lockout table is pruned and capped', () => {
  const { auth, clock } = makeAuth({ roleMaxFailures: Infinity });
  for (let i = 0; i < 5000; i++) auth.login('doctor', '0000', `ip-${i}`);
  assert.ok(auth.trackedClients() <= 1000, `holds ${auth.trackedClients()}`);
  // Recent devices are still remembered: ip-4999 has had 1 wrong PIN.
  assert.match(auth.login('doctor', '0000', 'ip-4999').error, /3 tries left/);
  // Idle entries are dropped after 10 minutes.
  clock.t += 10 * 60 * 1000;
  auth.login('pharmacy', '2222', 'ip-x');
  assert.equal(auth.trackedClients(), 0);
});
