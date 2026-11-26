// Simple PIN login per role (doctor / pharmacy). No user accounts.
//
// A correct PIN gets a signed, httpOnly cookie for that role:
//   rx_<role> = <role>.<issuedAt ms>.<HMAC-SHA256>
// The HMAC key is the server secret plus the role's PIN, so changing a PIN
// logs that role out everywhere. 5 wrong PINs lock that role out for the
// client's IP for 1 minute.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = ['doctor', 'pharmacy'];
const LOGIN_MS = 24 * 60 * 60 * 1000; // a clinic day, with margin
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const MAX_PIN_LENGTH = 32;
const MIN_PIN_LENGTH = 4;
const PIN_ENV = { doctor: 'DOCTOR_PIN', pharmacy: 'PHARMACY_PIN' };

// Why these PINs are not safe to run with: [] if they are fine. Missing
// PINs would leave a screen open to anyone on the WiFi; equal PINs would let
// the doctor's PIN open the pharmacy screen too.
function pinProblems(pins = {}) {
  const problems = [];
  for (const role of ROLES) {
    const pin = pins[role];
    if (typeof pin !== 'string' || pin === '') problems.push(`${PIN_ENV[role]} is not set.`);
    else if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      problems.push(`${PIN_ENV[role]} must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters.`);
    }
  }
  if (!problems.length && pins.doctor === pins.pharmacy) problems.push('DOCTOR_PIN and PHARMACY_PIN must be different.');
  return problems;
}

const cookieName = (role) => `rx_${role}`;

// The signing secret: SESSION_SECRET if set, else a random one kept in
// DATA_DIR so logins survive a server restart.
function loadSecret(dataDir, fromEnv) {
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    // Another process wrote it first: use theirs.
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw err;
  }
  return secret;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time string comparison.
function same(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// Cookie header -> { name: value }. Only what we need; no decoding tricks.
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// pins: { doctor, pharmacy }. Options exist so tests can shorten time.
function createAuth({ pins, secret, now = Date.now, lockoutMs = LOCKOUT_MS, loginMs = LOGIN_MS }) {
  const problems = pinProblems(pins);
  if (problems.length) throw new Error(`PIN setup: ${problems.join(' ')} Set them before starting the server (see README).`);
  const failures = new Map(); // `${role}|${client}` -> { count, lockedUntil }

  function sign(role, issuedAt) {
    return crypto
      .createHmac('sha256', `${secret}:${pins[role]}`)
      .update(`${role}.${issuedAt}`)
      .digest('base64url');
  }

  function issue(role) {
    const issuedAt = now();
    return `${role}.${issuedAt}.${sign(role, issuedAt)}`;
  }

  // True if `token` is a valid, unexpired login for `role`.
  function verify(role, token) {
    if (!ROLES.includes(role) || typeof token !== 'string') return false;
    const [tokenRole, issuedRaw, sig, extra] = token.split('.');
    if (extra !== undefined || tokenRole !== role || !/^\d{1,15}$/.test(issuedRaw || '')) return false;
    const issuedAt = Number(issuedRaw);
    const age = now() - issuedAt;
    if (age < 0 || age > loginMs) return false;
    return same(sig || '', sign(role, issuedAt));
  }

  // The roles (of `allowed`) that the request's cookies prove.
  function rolesFromCookieHeader(header, allowed = ROLES) {
    const cookies = parseCookies(header);
    return allowed.filter((role) => verify(role, cookies[cookieName(role)]));
  }

  // -> { ok: true, cookie } | { ok: false, status, error, retryAfter? }
  function login(role, pin, client) {
    if (!ROLES.includes(role)) return { ok: false, status: 400, error: 'Unknown screen.' };
    const key = `${role}|${client}`;
    const entry = failures.get(key) || { count: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now()) return lockedOut(entry);

    const valid = typeof pin === 'string' && pin.length <= MAX_PIN_LENGTH && same(pin, pins[role]);
    if (valid) {
      failures.delete(key);
      return { ok: true, cookie: setCookieHeader(role, issue(role)) };
    }
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.count = 0;
      entry.lockedUntil = now() + lockoutMs;
      failures.set(key, entry);
      return lockedOut(entry);
    }
    failures.set(key, entry);
    const left = MAX_ATTEMPTS - entry.count;
    return { ok: false, status: 401, error: `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` };
  }

  function lockedOut(entry) {
    const retryAfter = Math.ceil((entry.lockedUntil - now()) / 1000);
    return {
      ok: false,
      status: 429,
      retryAfter,
      error: `Too many wrong PINs. Try again in ${retryAfter} seconds.`
    };
  }

  function setCookieHeader(role, token) {
    // httpOnly: page scripts cannot read it. SameSite=Strict: other sites
    // cannot use it. No Secure flag: the clinic LAN is plain http.
    return `${cookieName(role)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(loginMs / 1000)}`;
  }

  return { login, verify, rolesFromCookieHeader, issue };
}

module.exports = { createAuth, loadSecret, parseCookies, cookieName, pinProblems, ROLES, MAX_ATTEMPTS, LOCKOUT_MS };
